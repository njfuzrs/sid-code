/**
 * `mcp` CLI 子命令（对齐 claude-code `claude mcp ...`，缺口 A-3）
 *
 * 提供无头 CLI 入口管理 MCP 服务器配置。TUI 内已有 `/mcp` 斜杠命令（mcp-enhanced.ts），
 * 但那依赖完整 App（ctx.mcpManager/sessionState）。本命令是**独立快速路径**：只读写
 * settings.json / .mcp.json，不启动 App，供脚本/CI 使用。
 *
 * 子命令：
 *   mcp list                                列出所有已配置的 MCP 服务器（settings + .mcp.json 合并）
 *   mcp get <name>                          查看单个服务器详情
 *   mcp add <name> <command|url> [args...]  添加服务器（--scope user|project，--transport stdio|http|sse）
 *   mcp remove <name> [--scope ...]         移除服务器
 *
 * 写入语义与 /mcp 一致：user 作用域外科式补丁 settings.json 的 mcpServers（不整体覆盖，
 * 避免 Zod 有损 round-trip / 密钥明文化）；project 作用域写 .mcp.json。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MCPServerConfig } from "../config/config.ts";

/** 读取合并后的全部 MCP 服务器（settings.json + 项目 .mcp.json）。 */
async function loadAllServers(): Promise<Record<string, MCPServerConfig>> {
  const { loadConfig } = await import("../config/config.ts");
  const config = await loadConfig({});
  return (config.mcpServers ?? {}) as Record<string, MCPServerConfig>;
}

/** 解析形如 --scope user 的键值参数。 */
function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function describeServer(name: string, cfg: MCPServerConfig): string {
  const transport = cfg.transport ?? (cfg.url ? "http" : "stdio");
  const target = cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" ");
  return `${name}  [${transport}]  ${target}`;
}

async function cmdList(asJson: boolean): Promise<void> {
  const servers = await loadAllServers();
  const names = Object.keys(servers);
  if (asJson) {
    console.log(JSON.stringify(servers, null, 2));
    return;
  }
  if (names.length === 0) {
    console.log("未配置任何 MCP 服务器。用 `sid-code mcp add <name> <command|url>` 添加。");
    return;
  }
  console.log(`已配置的 MCP 服务器（共 ${names.length} 个）:\n`);
  for (const name of names) {
    console.log(`  ${describeServer(name, servers[name])}`);
  }
}

async function cmdGet(name: string, asJson: boolean): Promise<void> {
  const servers = await loadAllServers();
  const cfg = servers[name];
  if (!cfg) {
    console.error(`错误: MCP 服务器 "${name}" 不存在。`);
    process.exit(1);
  }
  if (asJson) {
    console.log(JSON.stringify({ [name]: cfg }, null, 2));
    return;
  }
  console.log(describeServer(name, cfg));
  console.log(JSON.stringify(cfg, null, 2));
}

/** 外科式写入 user settings 的 mcpServers（复用 /mcp add 的安全写入路径）。 */
async function saveUserServer(name: string, cfg: MCPServerConfig): Promise<void> {
  const { getSettingsForSource, patchSettingsFile } = await import("../config/settings/settings.ts");
  const { settings } = getSettingsForSource("userSettings");
  const servers = { ...((settings?.mcpServers as Record<string, MCPServerConfig>) ?? {}) };
  servers[name] = cfg;
  patchSettingsFile("userSettings", "mcpServers", servers as any);
}

async function removeUserServer(name: string): Promise<boolean> {
  const { getSettingsForSource, patchSettingsFile } = await import("../config/settings/settings.ts");
  const { settings } = getSettingsForSource("userSettings");
  const servers = { ...((settings?.mcpServers as Record<string, MCPServerConfig>) ?? {}) };
  if (!servers[name]) return false;
  delete servers[name];
  patchSettingsFile("userSettings", "mcpServers", servers as any);
  return true;
}

function saveProjectServer(name: string, cfg: MCPServerConfig): void {
  const mcpJsonPath = resolve(process.cwd(), ".mcp.json");
  let mcpConfig: { mcpServers?: Record<string, MCPServerConfig> } = {};
  if (existsSync(mcpJsonPath)) {
    mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  }
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  mcpConfig.mcpServers[name] = cfg;
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
}

function removeProjectServer(name: string): boolean {
  const mcpJsonPath = resolve(process.cwd(), ".mcp.json");
  if (!existsSync(mcpJsonPath)) return false;
  const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  if (!mcpConfig.mcpServers?.[name]) return false;
  delete mcpConfig.mcpServers[name];
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  return true;
}

async function cmdAdd(args: string[]): Promise<void> {
  const name = args[0];
  const commandOrUrl = args[1];
  if (!name || !commandOrUrl) {
    console.error(
      "用法: sid-code mcp add <name> <command|url> [args...] [--scope user|project] [--transport stdio|http|sse] [--env KEY=VALUE]",
    );
    process.exit(1);
  }
  const scope = (getFlag(args, "scope") ?? "project") as "user" | "project";
  if (scope !== "user" && scope !== "project") {
    console.error(`错误: --scope 只能是 user 或 project，收到: "${scope}"`);
    process.exit(1);
  }
  const isUrl = /^https?:\/\//i.test(commandOrUrl);
  const transport = (getFlag(args, "transport") ?? (isUrl ? "http" : "stdio")) as string;

  const cfg: MCPServerConfig = {} as MCPServerConfig;
  if (isUrl || transport === "http" || transport === "sse") {
    cfg.transport = (transport === "stdio" ? "http" : transport) as MCPServerConfig["transport"];
    cfg.url = commandOrUrl;
  } else {
    cfg.transport = "stdio";
    cfg.command = commandOrUrl;
    // command 之后、遇到第一个 --flag 之前的位置参数都算 args
    const positional: string[] = [];
    for (let i = 2; i < args.length; i++) {
      if (args[i].startsWith("--")) break;
      positional.push(args[i]);
    }
    if (positional.length > 0) cfg.args = positional;
  }
  // --env KEY=VALUE（可多次）
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      const [k, ...rest] = args[i + 1].split("=");
      if (k) env[k.trim()] = rest.join("=").trim();
    }
  }
  if (Object.keys(env).length > 0) cfg.env = env;

  try {
    if (scope === "project") saveProjectServer(name, cfg);
    else await saveUserServer(name, cfg);
    console.log(`MCP 服务器 "${name}" 已添加到 ${scope} 配置（${cfg.transport}）。重启会话后生效。`);
  } catch (err: any) {
    console.error(`添加失败: ${err?.message ?? err}`);
    process.exit(1);
  }
}

async function cmdRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("用法: sid-code mcp remove <name> [--scope user|project]");
    process.exit(1);
  }
  const scopeArg = getFlag(args, "scope");
  // 未指定 scope 时两处都尝试移除。
  const scopes: ("user" | "project")[] = scopeArg
    ? [scopeArg as "user" | "project"]
    : ["project", "user"];
  let removed = false;
  try {
    for (const scope of scopes) {
      if (scope === "project") removed = removeProjectServer(name) || removed;
      else removed = (await removeUserServer(name)) || removed;
    }
  } catch (err: any) {
    console.error(`移除失败: ${err?.message ?? err}`);
    process.exit(1);
  }
  if (!removed) {
    console.error(`错误: MCP 服务器 "${name}" 不存在于${scopeArg ? ` ${scopeArg}` : ""}配置中。`);
    process.exit(1);
  }
  console.log(`MCP 服务器 "${name}" 已移除。重启会话后生效。`);
}

export async function handleMcpCommand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      await cmdList(asJson);
      return;
    case "get":
      await cmdGet(rest[0], asJson);
      return;
    case "add":
      await cmdAdd(rest);
      return;
    case "remove":
    case "rm":
    case "delete":
      await cmdRemove(rest);
      return;
    default:
      console.error(
        `错误: 未知 mcp 子命令 "${sub}"。可用: list / get <name> / add <name> <command|url> / remove <name>`,
      );
      process.exit(1);
  }
}
