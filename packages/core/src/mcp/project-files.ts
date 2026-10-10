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
import { dirname, join, parse, resolve } from "path";
import type { MCPServerConfig } from "../config/config.ts";

export interface ProjectMcpServers {
  /** 合并后的 server（近者覆盖远者） */
  servers: Record<string, MCPServerConfig>;
  /** server 名 → 声明它的 `.mcp.json` 绝对路径（取最终生效的那份） */
  sources: Record<string, string>;
  /** 实际读到的 `.mcp.json` 路径，根 → cwd 顺序 */
  files: string[];
}

/** cwd → 文件系统根（不含根）逐级列出目录，返回顺序为 cwd 在前 */
export function ancestorDirsToRoot(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  const root = parse(current).root;
  while (current !== root) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** 解析单个 `.mcp.json`；格式不对 / 读失败返回 null（由调用方决定是否告警） */
function readMcpJsonFile(path: string): Record<string, MCPServerConfig> | null {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  // 支持 { "mcpServers": { ... } } 或直接 { "serverName": { ... } }
  const servers = parsed?.mcpServers || parsed?.mcp_servers || parsed;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  return servers as Record<string, MCPServerConfig>;
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
 * MCP 的「项目身份」：git root（非仓库退回 cwd；落在 ~/.sid-code 内退回家目录）。
 * 审批 key 与禁用列表都按它分区 ⇒ 同一仓库任意子目录只审批一次、禁用状态一致（M4）。
 */
export async function getMcpProjectRoot(cwd: string = process.cwd()): Promise<string> {
  const { resolveProjectRoot } = await import("../memory/paths.ts");
  return resolveProjectRoot(cwd);
}

// ─── M2：持久化禁用列表 ─────────────────────────────────────────────────────
//
// 对齐 CC 的 `disabledMcpServers`：用户私有、按项目身份（git root）索引，**不写入共享的
// `.mcp.json`** —— 那是入库文件，一个人的禁用偏好会被提交给全团队。
// 落点与 mcp.local.json 同目录：~/.sid-code/projects/<项目键>/mcp-state.json。
// 不读也不写 ~/.claude.json（本仓规定对齐 CC 语义但不读 CC 配置文件）。

interface McpProjectState {
  disabledMcpServers?: string[];
}

async function mcpStatePath(cwd: string): Promise<string> {
  const { resolveProjectRoot, sanitizeProjectKey } = await import("../memory/paths.ts");
  const { sidPaths } = await import("../config/paths.ts");
  return join(sidPaths.projects(), sanitizeProjectKey(resolveProjectRoot(cwd)), "mcp-state.json");
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

/** 读当前项目的禁用列表 */
export async function getDisabledMcpServers(cwd: string = process.cwd()): Promise<string[]> {
  const list = readState(await mcpStatePath(cwd)).disabledMcpServers;
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
}

/** 写入某 server 的禁用状态（幂等）；返回写入的文件路径 */
export async function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  cwd: string = process.cwd(),
): Promise<string> {
  const path = await mcpStatePath(cwd);
  const state = readState(path);
  const set = new Set(state.disabledMcpServers ?? []);
  if (disabled) set.add(name);
  else set.delete(name);
  state.disabledMcpServers = [...set];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

/**
 * 按禁用列表给 server 打上 enabled:false（不改原对象）。
 * manager.connectAll 会把它们放进 disabledConfigs ⇒ 面板显示「已禁用」，与历史
 * `.mcp.json` 里的 `enabled:false` 走同一条路径。
 */
export function applyDisabledList(
  servers: Record<string, MCPServerConfig>,
  disabled: readonly string[],
): Record<string, MCPServerConfig> {
  if (disabled.length === 0) return servers;
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = disabled.includes(name) ? { ...cfg, enabled: false } : cfg;
  }
  return out;
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
