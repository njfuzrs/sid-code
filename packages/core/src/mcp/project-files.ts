/**
 * 项目级 `.mcp.json` 的发现与合并（M1），以及按项目身份持久化的 MCP 禁用列表（M2）。
 *
 * ─── 为什么向上找到文件系统根，而不是停在 git root ───
 *
 * 对齐 CC：从 cwd 逐级向上直到文件系统根（不含根本身），从根往 cwd 方向依次合并，
 * **离 cwd 越近优先级越高**。实测在 git root 是 `docs-research` 的子目录里启动，CC 仍读到了
 * `~/.mcp.json` —— 上界不是 git root，也不是家目录。旧实现只读 `cwd/.mcp.json`，
 * 子目录启动时祖先目录声明的 server 全部静默消失。
 *
 * ─── 为什么加载侧与 CLI 必须共用这一个函数 ───
 *
 * `sid-code mcp list/pending/approve` 以前各自 `resolve(process.cwd(), ".mcp.json")`，
 * 只改加载侧会让 TUI 与 CLI 的列表在子目录下不一致（M4）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { getAncestorChain } from "../config/project-bases.ts";
import type { MCPServerConfig } from "../config/config.ts";

export interface ProjectMcpServers {
  /** 合并后的 server（近者覆盖远者） */
  servers: Record<string, MCPServerConfig>;
  /** server 名 → 声明它的 `.mcp.json` 绝对路径（取最终生效的那份） */
  sources: Record<string, string>;
  /** 实际读到的 `.mcp.json` 路径，根 → cwd 顺序 */
  files: string[];
}

/**
 * cwd → 文件系统根逐级列出目录，返回顺序为 cwd 在前。
 * 与 B4 共用 `getAncestorChain`（config/project-bases.ts）——此前这里另写了一份，
 * cwd 恰为文件系统根时两份结果不同（一份返回空、一份返回 [根]），两条读取路径因此漂移。
 */
export function ancestorDirsToRoot(cwd: string): string[] {
  return getAncestorChain(resolve(cwd)).reverse();
}

/**
 * 把 CC 格式的 server 条目归一成 sid-code 的 `transport` 口径。
 *
 * `.mcp.json` 是两家共用的文件：CC 用 `type` 字段，且 stdio 可以**不写**（只给 `command`）。
 * 此前原样透传，`~/.mcp.json` 里一条合法的 CC 配置在启动时被报
 * `transport: 无效值 "undefined"`，manager 建连时也落进「不支持的传输方式」分支。
 *
 * 规则（显式字段优先，推断只在两者都缺时发生）：
 * 1. 已有 `transport` → 原样保留（sid 原生写法，不做任何改写）；
 * 2. 否则取 `type`（`streamable-http` 是 MCP 规范里 http 的别名）；
 * 3. 都没有：有 `command` → stdio（CC 的默认值），只有 `url` → http。
 * 无法推断时保持缺省，交给 config/schema.ts 报错——不猜一个错的传输方式。
 */
export function normalizeMcpServerEntry(raw: unknown): MCPServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw as MCPServerConfig;
  const entry = { ...(raw as Record<string, unknown>) };
  if (typeof entry.transport !== "string" || entry.transport === "") {
    const type = typeof entry.type === "string" ? entry.type : undefined;
    const inferred =
      type === "streamable-http"
        ? "http"
        : (type ?? (entry.command ? "stdio" : entry.url ? "http" : undefined));
    if (inferred) entry.transport = inferred;
  }
  delete entry.type;
  return entry as unknown as MCPServerConfig;
}

/** 对一整层 server 表做 {@link normalizeMcpServerEntry}（.mcp.json 与 mcp.local.json 共用） */
export function normalizeMcpServerMap(
  servers: Record<string, unknown>,
): Record<string, MCPServerConfig> {
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) out[name] = normalizeMcpServerEntry(cfg);
  return out;
}

/** 解析单个 `.mcp.json`；格式不对 / 读失败返回 null（由调用方决定是否告警） */
function readMcpJsonFile(path: string): Record<string, MCPServerConfig> | null {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  // 支持 { "mcpServers": { ... } } 或直接 { "serverName": { ... } }
  const servers = parsed?.mcpServers || parsed?.mcp_servers || parsed;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  return normalizeMcpServerMap(servers as Record<string, unknown>);
}

/**
 * 从 cwd 向上收集并合并全部 `.mcp.json`。
 *
 * 单个文件损坏只跳过那一份（经 onWarn 报告），不连累其它层——
 * 祖先目录里一份坏文件不该让当前仓库的 server 一起消失。
 */
export function loadProjectMcpServers(
  cwd: string = process.cwd(),
  onWarn?: (message: string) => void,
): ProjectMcpServers {
  const servers: Record<string, MCPServerConfig> = {};
  const sources: Record<string, string> = {};
  const files: string[] = [];

  // 从根往 cwd 方向处理，后写的（更近的）覆盖先写的
  for (const dir of ancestorDirsToRoot(cwd).reverse()) {
    const file = join(dir, ".mcp.json");
    if (!existsSync(file)) continue;
    try {
      const layer = readMcpJsonFile(file);
      if (!layer) {
        onWarn?.(`${file} 格式不正确，期望对象`);
        continue;
      }
      files.push(file);
      for (const [name, cfg] of Object.entries(layer)) {
        servers[name] = cfg;
        sources[name] = file;
      }
    } catch (err) {
      onWarn?.(`读取 ${file} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { servers, sources, files };
}

/**
 * MCP 的「项目身份」：主仓根（B2 identity，linked worktree 归到主 checkout；非仓库退回 cwd；
 * 落在 ~/.sid-code 内退回家目录）。审批 key 与禁用列表都按它分区 ⇒ 同一仓库任意子目录、
 * 任意 worktree 只审批一次、禁用状态一致（M4，对齐 CC `findCanonicalGitRoot`）。
 */
export async function getMcpProjectRoot(cwd: string = process.cwd()): Promise<string> {
  const { getProjectIdentityRoot } = await import("../config/project-bases.ts");
  return getProjectIdentityRoot(cwd);
}

/**
 * 迁移兼容：此前（含 #220）用过的项目键，**不含**当前的主仓根。
 * - 当前工作树根（`--show-toplevel`，worktree 下是 worktree 自己）—— #220 的键；
 * - 启动 cwd —— #220 之前审批 key 用的就是它。
 * 读取时新键查不到再查这些，写入时一并清掉，完成迁移。
 */
export async function getLegacyMcpProjectKeys(cwd: string = process.cwd()): Promise<string[]> {
  const { getCheckoutRoot, getProjectIdentityRoot } = await import("../config/project-bases.ts");
  const primary = getProjectIdentityRoot(cwd);
  const out: string[] = [];
  for (const p of [getCheckoutRoot(cwd), resolve(cwd)]) {
    if (p !== primary && !out.includes(p)) out.push(p);
  }
  return out;
}

/** 某个项目根在 ~/.sid-code/projects/ 下的私有目录 */
async function projectStateDir(root: string): Promise<string> {
  const { sanitizeProjectKey } = await import("../memory/paths.ts");
  const { sidPaths } = await import("../config/paths.ts");
  return join(sidPaths.projects(), sanitizeProjectKey(root));
}

/**
 * 项目私有目录里某个文件的读取路径：主仓根那份存在就用它，否则回退到旧键（worktree 自己
 * 的根）下已存在的那份 —— #220 起 mcp.local.json / mcp-state.json 是按工作树分开存的，
 * 改成按主仓归一后，老 worktree 的文件不能凭空失效。都不存在时返回主仓根路径（供写入）。
 */
export async function resolveProjectStateFile(
  file: string,
  cwd: string = process.cwd(),
): Promise<{ path: string; primary: string }> {
  const { getCheckoutRoot, getProjectIdentityRoot } = await import("../config/project-bases.ts");
  const primary = join(await projectStateDir(getProjectIdentityRoot(cwd)), file);
  if (existsSync(primary)) return { path: primary, primary };
  const legacy = join(await projectStateDir(getCheckoutRoot(cwd)), file);
  if (legacy !== primary && existsSync(legacy)) return { path: legacy, primary };
  return { path: primary, primary };
}

// ─── M2：持久化禁用列表 ─────────────────────────────────────────────────────
//
// 对齐 CC 的 `disabledMcpServers`：用户私有、按项目身份（git root）索引，**不写入共享的
// `.mcp.json`** —— 那是入库文件，一个人的禁用偏好会被提交给全团队。
// 落点与 mcp.local.json 同目录：~/.sid-code/projects/<项目键>/mcp-state.json。
// 不读也不写 ~/.claude.json（本仓规定对齐 CC 语义但不读 CC 配置文件）。

interface McpProjectState {
  disabledMcpServers?: string[];
  /**
   * 显式启用的 server。只为盖过配置源里写死的 `enabled:false`（历史上 `/mcp disable`
   * 改写进 `.mcp.json` / 用户 settings 的那种）：只有「禁用名单」时，从面板启用一个
   * 这样的 server 本会话能连上，重启又回到禁用 —— 用户点了「启用」却只活一个会话。
   * 与 disabledMcpServers 互斥：写一边就从另一边删掉。
   */
  enabledMcpServers?: string[];
}

function readState(path: string): McpProjectState {
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : [];
}

/** 当前项目的持久化开关：禁用名单 + 显式启用名单 */
export async function getMcpServerToggles(
  cwd: string = process.cwd(),
): Promise<{ disabled: string[]; enabled: string[] }> {
  const state = readState((await resolveProjectStateFile("mcp-state.json", cwd)).path);
  return {
    disabled: stringList(state.disabledMcpServers),
    enabled: stringList(state.enabledMcpServers),
  };
}

/** 读当前项目的禁用列表 */
export async function getDisabledMcpServers(cwd: string = process.cwd()): Promise<string[]> {
  return (await getMcpServerToggles(cwd)).disabled;
}

/** 写入某 server 的启用 / 禁用状态（幂等）；返回写入的文件路径（总是主仓根那份） */
export async function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  cwd: string = process.cwd(),
): Promise<string> {
  const { path: readPath, primary } = await resolveProjectStateFile("mcp-state.json", cwd);
  const state = readState(readPath);
  const off = new Set(stringList(state.disabledMcpServers));
  const on = new Set(stringList(state.enabledMcpServers));
  if (disabled) {
    off.add(name);
    on.delete(name);
  } else {
    off.delete(name);
    on.add(name);
  }
  state.disabledMcpServers = [...off];
  state.enabledMcpServers = [...on];
  mkdirSync(dirname(primary), { recursive: true });
  writeFileSync(primary, JSON.stringify(state, null, 2));
  return primary;
}

/**
 * 按持久化开关改写 server 的 enabled（不改原对象）：禁用名单 → enabled:false；
 * 显式启用名单 → 去掉配置源里的 enabled:false。
 * manager.connectAll 会把 enabled:false 的放进 disabledConfigs ⇒ 面板显示「已禁用」，与历史
 * `.mcp.json` 里的 `enabled:false` 走同一条路径。
 *
 * ⚠️ 必须作用于**最终交给 connectAll 的那份集合**（cli.ts 里合并了插件 / `--mcp-config` 之后），
 * 而不是 loadConfig 里只含 settings + `.mcp.json` 的 config.mcpServers —— 否则插件与
 * `--mcp-config` 来源的 server 禁用后提示「已持久化」，重启又连上。
 */
export function applyServerToggles(
  servers: Record<string, MCPServerConfig>,
  toggles: { disabled: readonly string[]; enabled: readonly string[] },
): Record<string, MCPServerConfig> {
  if (toggles.disabled.length === 0 && toggles.enabled.length === 0) return servers;
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (toggles.disabled.includes(name)) {
      out[name] = { ...cfg, enabled: false };
    } else if (toggles.enabled.includes(name) && cfg.enabled === false) {
      const { enabled: _e, ...rest } = cfg as MCPServerConfig & { enabled?: boolean };
      out[name] = rest as MCPServerConfig;
    } else {
      out[name] = cfg;
    }
  }
  return out;
}

/** 只按禁用名单打 enabled:false（保留给既有调用方；新代码用 applyServerToggles） */
export function applyDisabledList(
  servers: Record<string, MCPServerConfig>,
  disabled: readonly string[],
): Record<string, MCPServerConfig> {
  return applyServerToggles(servers, { disabled, enabled: [] });
}

/** toggleMcpServer 需要的 manager 能力（只取接口，避免 project-files → manager 的依赖） */
export interface McpToggleTarget {
  disableServer(name: string): Promise<boolean>;
  enableServer(name: string): Promise<unknown[] | null>;
}

/**
 * M2：面板与 `/mcp enable|disable` 的唯一入口 —— **先写盘、再当场生效**（对齐 CC）。
 *
 * 两个入口以前各写各的（面板写 sessionState、命令改写 .mcp.json），且都不碰 manager：
 * 提示「已禁用」而工具仍在注册表里。收成一个函数，两个入口不会再各自漂移。
 *
 * `applied` 为 false 表示本会话没有 manager 或 manager 不认识该名字 ——
 * 持久状态已写，下次启动生效；调用方据此如实提示，不报一个没发生的「已生效」。
 */
export async function toggleMcpServer(
  name: string,
  disabled: boolean,
  manager: McpToggleTarget | undefined,
  cwd: string = process.cwd(),
): Promise<{ statePath: string; applied: boolean }> {
  const statePath = await setMcpServerDisabled(name, disabled, cwd);
  let applied = false;
  if (manager) {
    applied = disabled
      ? await manager.disableServer(name)
      : (await manager.enableServer(name)) !== null;
  }
  return { statePath, applied };
}

/**
 * 启动时是否要建 MCPManager（M3）。有待审批的项目 server 也要建 —— 否则在「只有 .mcp.json」
 * 的项目里（pending 不进生效集合），启动审批框批准后没有 manager 可连，只能落盘等下次启动，
 * 用户还看不到任何提示。企业策略禁用 MCP 时 pending 不算：批准了也不会连。
 */
export function shouldCreateMcpManager(opts: {
  serverCount: number;
  ideAutoConnect: boolean;
  pendingApprovalCount: number;
  mcpAllowedByPolicy: boolean;
}): boolean {
  if (opts.serverCount > 0 || opts.ideAutoConnect) return true;
  return opts.mcpAllowedByPolicy && opts.pendingApprovalCount > 0;
}
