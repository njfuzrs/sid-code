/**
 * MCP 项目级 .mcp.json 审批机制
 * 审批记录存储在 ~/.sid-code/state/mcp-approvals.json
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

export type ApprovalStatus = "approved" | "rejected" | "pending";

interface ApprovalStore {
  approved: string[];
  rejected: string[];
  /**
   * 「该项目下全部 .mcp.json server 自动批准」的项目路径清单（D17-3）。
   *
   * 必须按项目，不能是一个全局布尔：项目级 server 要审批，是因为 .mcp.json 可能被
   * 恶意仓库注入；全局开关在项目 A 里图省事打开一次，之后 clone 的任何仓库都会被
   * 无提示加载 —— 等于把这条防线整个关掉。
   */
  approveAllProjects?: string[];
  /**
   * 旧版全局开关，**只读不认**：老文件里残留的 `approveAll: true` 一律忽略（fail-closed），
   * 不迁移成「对所有项目生效」—— 那就是要修掉的语义本身；也无法反推当初是在哪个项目开的。
   * 下次写盘时被删除。
   */
  approveAll?: unknown;
}

function legacyList(legacy?: string | readonly string[]): readonly string[] {
  if (!legacy) return [];
  return typeof legacy === "string" ? [legacy] : legacy;
}

/** 审批记录路径：~/.sid-code/state/mcp-approvals.json */
function approvalsPath(): string {
  return sidPaths.stateFile("mcp-approvals.json");
}

/**
 * 本进程内读到的「损坏且尚未备份」的审批文件路径。
 *
 * 为什么必须把「损坏」这个事实从读传到写：`loadApprovals` 解析失败时只能返回空 store
 * （fail-safe：所有项目级 server 回到待审批，重新询问用户），但紧接着的
 * `approveProjectServer` / `rejectProjectServer` / `setApproveAll` 都是
 * 「load → 改 → 整个文件重写」。若读的时候只告警不记状态，这一次写入就会用一份
 * 几乎为空的文件覆盖掉用户**全部项目**的历史审批 / 拒绝记录 —— 静默且不可逆。
 */
let corruptPending: string | null = null;

function loadApprovals(): ApprovalStore {
  const path = approvalsPath();
  // 文件不存在 = 正常首次使用（saveApprovals 会创建），不告警
  if (!existsSync(path)) return { approved: [], rejected: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // 上一次读到损坏、这一次读到合法内容 = 文件已被外部修复 → 清掉待备份标记，
      // 否则紧接着的写入会把一份好文件当成损坏件挪走
      if (corruptPending === path) corruptPending = null;
      return parsed as ApprovalStore;
    }
  } catch {
    // JSON 解析失败与「顶层不是对象」同属不可用，统一走下面的损坏处理
  }
  corruptPending = path;
  getLogger().warn(
    "MCP",
    `审批记录已损坏（${path}），已按空记录处理；原文件将在下次写入前备份为 ${path}.corrupt-<时间戳>`,
  );
  return { approved: [], rejected: [] };
}

function saveApprovals(store: ApprovalStore): void {
  // 旧版全局 approveAll 不再生效，写盘时顺手清掉，避免读文件的人误以为它还开着
  delete store.approveAll;
  const dir = sidPaths.state();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = approvalsPath();
  // 本次进程读到过损坏 → 写入前先把原文件挪走。每个损坏文件只备份一次：
  // 备份完（或确认无需备份）即清标记，后续写入不会再产生第二份备份。
  if (corruptPending === path && existsSync(path)) {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch (err) {
      // 备份失败不阻断写入：损坏内容本就解析不出来，approve 仍要能用；
      // 补一条告警说明原文件没能保住即可。
      getLogger().warn(
        "MCP",
        `备份损坏的审批记录失败（${path}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  writeFileSync(path, JSON.stringify(store, null, 2));
  // 写入成功后才清标记：若上面 rename 成功而这里写失败，path 已不存在，
  // 下次写入会被 existsSync 拦住、不会产生第二个备份文件。
  corruptPending = null;
}

// ─── 内容指纹 ────────────────────────────────────────────────────────────────
//
// 批准记录必须绑定「批准时看到的配置内容」，不能只绑 server 名：.mcp.json 是随仓库
// 分发的，同名 server 的 command / args / url 被人改掉（恶意 PR、被投毒的依赖仓库）后，
// 只认名字的批准会让新命令在下次启动时**无提示执行**——用户批准的是旧命令，不是新命令。
// 同仓的 extension/trust.ts 早就按 SHA-256 内容 hash 记信任，这里与它对齐。
//
// 拒绝记录刻意仍按名字记：拒绝是「这个名字我不要」，内容变了也不该自动解除（fail-closed）。

/** 指纹里排除的字段：只是开关，不改变「会执行什么」。关掉一个 server 不该要求重新审批。 */
const FINGERPRINT_EXCLUDED_KEYS = new Set(["enabled"]);

/** 稳定 JSON 序列化（对象键排序），保证同一份配置在不同进程里算出同一个指纹 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * 计算项目级 server 配置的内容指纹（SHA-256 全长 hex）。
 *
 * 取的是 .mcp.json 里**声明的原文**（`${VAR}` 未展开）：批准的对象是仓库里写的东西，
 * 环境变量的值是用户自己的，换个 token 不该触发重新审批。
 */
export function computeServerConfigFingerprint(config: unknown): string {
  let target = config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    target = Object.fromEntries(
      Object.entries(config as Record<string, unknown>).filter(
        ([k]) => !FINGERPRINT_EXCLUDED_KEYS.has(k),
      ),
    );
  }
  return createHash("sha256").update(stableStringify(target), "utf-8").digest("hex");
}

/** 批准键：`<项目路径>:<server 名>#sha256:<指纹>` */
function approvedKey(path: string, serverName: string, fingerprint: string): string {
  return `${path}:${serverName}#sha256:${fingerprint}`;
}

/**
 * 某项目下某 server 的全部批准键（含旧版无指纹的 `<path>:<name>`），写入时整体替换用：
 * 内容变了重新批准后，旧指纹的记录不能留着——否则把配置改回旧内容会被静默放行。
 */
function isApprovedKeyFor(key: string, path: string, serverName: string): boolean {
  const base = `${path}:${serverName}`;
  return key === base || key.startsWith(`${base}#sha256:`);
}

/**
 * 检查项目级 MCP Server 的审批状态。
 *
 * 批准按「server 名 + 配置内容指纹」匹配：`config` 与批准时不同 → pending，重新询问。
 * 升级前留下的无指纹批准记录一律不认（视为 pending），下次批准时被清掉。
 *
 * M4：projectPath 现在是项目身份（主仓根，linked worktree 归到主 checkout）。旧版用过两种键：
 * 启动 cwd（#220 之前）与当前工作树根（#220）。`legacyPath` 传这些旧键，新 key 没有记录时
 * 回退查 —— 升级后不必在每个子目录 / worktree 重新审批一遍；
 * 下次对该 server 写入（approve/reject）时旧 key 被清掉，完成迁移。
 */
export function getProjectServerApproval(
  serverName: string,
  config: unknown,
  projectPath: string,
  legacyPath?: string | readonly string[],
): ApprovalStatus {
  const approvals = loadApprovals();
  const fingerprint = computeServerConfigFingerprint(config);
  const lookup = (path: string): ApprovalStatus | null => {
    if (approvals.rejected?.includes(`${path}:${serverName}`)) return "rejected";
    if (approvals.approved?.includes(approvedKey(path, serverName, fingerprint))) return "approved";
    // 按项目全部批准是用户的显式选择（含之后新增 / 改动的 server），不受指纹约束
    if (approvals.approveAllProjects?.includes(path)) return "approved";
    return null;
  };
  const primary = lookup(projectPath);
  if (primary) return primary;
  for (const p of legacyList(legacyPath)) {
    if (p === projectPath) continue;
    const legacy = lookup(p);
    if (legacy) return legacy;
  }
  return "pending";
}

/**
 * 批准项目级 MCP Server。`config` 是用户此刻看到并批准的配置，批准只对这份内容有效。
 */
export function approveProjectServer(
  serverName: string,
  config: unknown,
  projectPath: string,
  legacyPath?: string | readonly string[],
): void {
  const approvals = loadApprovals();
  const key = approvedKey(projectPath, serverName, computeServerConfigFingerprint(config));
  const paths = [projectPath, ...legacyList(legacyPath)];
  // 同名 server 的旧指纹记录、无指纹旧记录、旧版路径键一并清掉，只留本次这一条
  approvals.approved = (approvals.approved ?? []).filter(
    (k) => !paths.some((p) => isApprovedKeyFor(k, p, serverName)),
  );
  approvals.approved.push(key);
  const nameKeys = new Set(paths.map((p) => `${p}:${serverName}`));
  approvals.rejected = (approvals.rejected ?? []).filter((k) => !nameKeys.has(k));
  saveApprovals(approvals);
}

/**
 * 拒绝项目级 MCP Server
 */
export function rejectProjectServer(
  serverName: string,
  projectPath: string,
  legacyPath?: string | readonly string[],
): void {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;
  const legacyPaths = legacyList(legacyPath);
  const legacyKeys = new Set(legacyPaths.map((p) => `${p}:${serverName}`));
  legacyKeys.delete(key);
  approvals.rejected = (approvals.rejected ?? []).filter((k) => !legacyKeys.has(k));
  if (!approvals.rejected.includes(key)) {
    approvals.rejected.push(key);
  }
  // 拒绝覆盖该名字在本项目（及旧版路径键）下的全部批准，不论指纹
  approvals.approved = (approvals.approved ?? []).filter(
    (k) => ![projectPath, ...legacyPaths].some((p) => isApprovedKeyFor(k, p, serverName)),
  );
  saveApprovals(approvals);
}

/**
 * 设置「该项目下全部项目级 Server 自动批准」。**只作用于 projectPath 这一个项目**（D17-3），
 * 其它项目的 .mcp.json 仍逐个审批。显式 rejected 的 server 优先于本开关。
 */
export function setApproveAll(value: boolean, projectPath: string): void {
  const approvals = loadApprovals();
  const list = (approvals.approveAllProjects ?? []).filter((p) => p !== projectPath);
  if (value) list.push(projectPath);
  approvals.approveAllProjects = list;
  saveApprovals(approvals);
}

// ─── 待审批快照（SEC-AUDIT-2026-07-19 P1）────────────────────────────────────
//
// loadConfig 在合并 MCP 配置时把 pending 的项目级 server **排除出生效列表**，
// 并登记到这里。/mcp 面板读它来展示"有 N 个待审批 server"，用户批准后写入
// approved 列表，下次启动即加载。
//
// 为什么用模块级单例而不挂在 Config 上：Config 会被序列化进会话快照、被 Zod
// 校验、被项目级 settings 合并——把"本次启动的临时审批状态"塞进去会污染这些
// 通路（早先的 `_pendingApproval` 就是塞在 serverConfig 里，结果既被透传到
// 生效列表又无人读取）。审批状态是进程内的一次性信息，不该进配置结构。

/** 待审批的项目级 server 名 → 其配置（仅本进程内有效） */
let pendingApproval: Record<string, unknown> = {};
/** 待审批 server 所属的项目路径（M4 起是项目身份 git root） */
let pendingApprovalProject = "";
/** 旧版审批 key（启动 cwd / 工作树根），写入时一并清掉（M4 迁移） */
let pendingApprovalLegacyPath: readonly string[] | undefined;

/** 登记待审批快照（loadConfig 调用） */
export function setPendingApprovalServers(
  servers: Record<string, unknown>,
  projectPath: string,
  legacyPath?: string | readonly string[],
): void {
  pendingApproval = servers;
  pendingApprovalProject = projectPath;
  pendingApprovalLegacyPath = legacyList(legacyPath);
}

/** 读取待审批 server 名单（/mcp 面板调用） */
export function getPendingApprovalServers(): { names: string[]; projectPath: string } {
  return { names: Object.keys(pendingApproval), projectPath: pendingApprovalProject };
}

/**
 * 批准一个待审批 server 并从快照中移除。
 * 返回 true 表示确实批准了（名字在快照里）。
 *
 * D17：本函数只写持久化状态、不建连——它在 core 的审批层，不持有 MCPManager。
 * 运行中热连接的入口是存在的（`MCPManager.addServer`），会话内的调用方应当用
 * {@link approveAndConnectPendingServer}；`sid-code mcp approve` 这类独立子进程
 * 没有 manager，只能提示「下次启动生效」。（旧注释说「运行中没有补连入口」，不成立。）
 */
export function approvePendingServer(serverName: string): boolean {
  if (!(serverName in pendingApproval)) return false;
  // 用快照里的配置算指纹：这正是审批框 / 面板展示给用户看的那一份
  approveProjectServer(
    serverName,
    pendingApproval[serverName],
    pendingApprovalProject,
    pendingApprovalLegacyPath,
  );
  delete pendingApproval[serverName];
  return true;
}

/**
 * 会话内批准并立即连接（D17）。`connect` 通常是 `mcpManager.addServer.bind(mcpManager)`，
 * 它自己过 mcpPolicy 闸、带总超时、成功后经 onToolsRefresh 把工具注册进 registry。
 *
 * 返回 null 表示名字不在待审批快照里；否则返回连上后注册的工具数（连接失败为 0，
 * 批准状态已落盘，下次启动仍会尝试）。
 */
export async function approveAndConnectPendingServer<T>(
  serverName: string,
  connect: (name: string, config: never) => Promise<T[]>,
): Promise<number | null> {
  const config = pendingApproval[serverName];
  if (config === undefined) return null;
  approvePendingServer(serverName);
  const tools = await connect(serverName, config as never);
  return tools.length;
}

/**
 * 「批准本项目全部」（M3 启动审批框的第二个选项）：打开按项目的 approveAll 开关，
 * 并把快照里剩下的 server 逐个批准 + 连接。返回实际处理的名字。
 */
export async function approveAllPendingServers<T>(
  connect?: (name: string, config: never) => Promise<T[]>,
): Promise<string[]> {
  if (pendingApprovalProject) setApproveAll(true, pendingApprovalProject);
  const names = Object.keys(pendingApproval);
  for (const name of names) {
    if (connect) await approveAndConnectPendingServer(name, connect);
    else approvePendingServer(name);
  }
  return names;
}

/** 读取某个待审批 server 的配置（启动审批框展示命令用） */
export function getPendingApprovalConfig(serverName: string): unknown {
  return pendingApproval[serverName];
}

/** 拒绝一个待审批 server 并从快照中移除（后续启动直接跳过，不再询问）。 */
export function rejectPendingServer(serverName: string): boolean {
  if (!(serverName in pendingApproval)) return false;
  rejectProjectServer(serverName, pendingApprovalProject, pendingApprovalLegacyPath);
  delete pendingApproval[serverName];
  return true;
}

/** 测试辅助：重置模块级快照 */
export function __resetPendingApproval(): void {
  pendingApproval = {};
  pendingApprovalProject = "";
  pendingApprovalLegacyPath = undefined;
}

/** 读取待审批快照对应的旧版 key 路径（CLI 写入时迁移用） */
export function getPendingApprovalLegacyPath(): readonly string[] | undefined {
  return pendingApprovalLegacyPath;
}
