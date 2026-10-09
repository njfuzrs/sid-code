/**
 * MCP 项目级 .mcp.json 审批机制
 * 审批记录存储在 ~/.sid-code/state/mcp-approvals.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { sidPaths } from "../config/paths.ts";

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

/** 审批记录路径：~/.sid-code/state/mcp-approvals.json */
function approvalsPath(): string {
  return sidPaths.stateFile("mcp-approvals.json");
}

function loadApprovals(): ApprovalStore {
  try {
    if (existsSync(approvalsPath())) {
      return JSON.parse(readFileSync(approvalsPath(), "utf-8"));
    }
  } catch {}
  return { approved: [], rejected: [] };
}

function saveApprovals(store: ApprovalStore): void {
  // 旧版全局 approveAll 不再生效，写盘时顺手清掉，避免读文件的人误以为它还开着
  delete store.approveAll;
  const dir = sidPaths.state();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(approvalsPath(), JSON.stringify(store, null, 2));
}

/**
 * 检查项目级 MCP Server 的审批状态。
 *
 * M4：projectPath 现在是项目身份（git root），旧版用的是启动 cwd。`legacyPath` 传启动 cwd，
 * 新 key 没有记录时回退查旧 key —— 升级后不必在每个子目录重新审批一遍；
 * 下次对该 server 写入（approve/reject）时旧 key 被清掉，完成迁移。
 */
export function getProjectServerApproval(
  serverName: string,
  projectPath: string,
  legacyPath?: string,
): ApprovalStatus {
  const approvals = loadApprovals();
  const lookup = (path: string): ApprovalStatus | null => {
    const key = `${path}:${serverName}`;
    if (approvals.rejected?.includes(key)) return "rejected";
    if (approvals.approved?.includes(key)) return "approved";
    if (approvals.approveAllProjects?.includes(path)) return "approved";
    return null;
  };
  const primary = lookup(projectPath);
  if (primary) return primary;
  if (legacyPath && legacyPath !== projectPath) {
    const legacy = lookup(legacyPath);
    if (legacy) return legacy;
  }
  return "pending";
}

/**
 * 批准项目级 MCP Server
 */
export function approveProjectServer(
  serverName: string,
  projectPath: string,
  legacyPath?: string,
): void {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;
  const legacyKey = legacyPath ? `${legacyPath}:${serverName}` : null;
  approvals.approved = (approvals.approved ?? []).filter((k) => k !== legacyKey);
  if (!approvals.approved.includes(key)) {
    approvals.approved.push(key);
  }
  approvals.rejected = (approvals.rejected ?? []).filter((k) => k !== key && k !== legacyKey);
  saveApprovals(approvals);
}

/**
 * 拒绝项目级 MCP Server
 */
export function rejectProjectServer(
  serverName: string,
  projectPath: string,
  legacyPath?: string,
): void {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;
  const legacyKey = legacyPath ? `${legacyPath}:${serverName}` : null;
  approvals.rejected = (approvals.rejected ?? []).filter((k) => k !== legacyKey);
  if (!approvals.rejected.includes(key)) {
    approvals.rejected.push(key);
  }
  approvals.approved = (approvals.approved ?? []).filter((k) => k !== key && k !== legacyKey);
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
/** 旧版审批 key 用的启动 cwd，写入时一并清掉旧 key（M4 迁移） */
let pendingApprovalLegacyPath: string | undefined;

/** 登记待审批快照（loadConfig 调用） */
export function setPendingApprovalServers(
  servers: Record<string, unknown>,
  projectPath: string,
  legacyPath?: string,
): void {
  pendingApproval = servers;
  pendingApprovalProject = projectPath;
  pendingApprovalLegacyPath = legacyPath;
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
  approveProjectServer(serverName, pendingApprovalProject, pendingApprovalLegacyPath);
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
export function getPendingApprovalLegacyPath(): string | undefined {
  return pendingApprovalLegacyPath;
}
