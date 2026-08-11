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
 *   mcp pending                             列出待审批的项目级服务器（未加载）
 *   mcp approve <name> | --all              批准项目级服务器（下次启动生效）
 *   mcp reject <name> | --all               拒绝项目级服务器（后续不再询问）
 *   mcp serve [--allow-write]               把 sid-code 自身工具暴露为 MCP server（stdio）
 *
 * 写入语义与 /mcp 一致：user 作用域外科式补丁 settings.json 的 mcpServers（不整体覆盖，
 * 避免 Zod 有损 round-trip / 密钥明文化）；project 作用域写 .mcp.json。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

/** 读取合并后的全部 MCP 服务器（settings.json + 项目 .mcp.json）。 */
async function loadAllServers(): Promise<Record<string, MCPServerConfig>> {
  const { loadConfig } = await import("@sid-code/core/config/config.ts");
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
  const { getSettingsForSource, patchSettingsFile } = await import("@sid-code/core/config/settings/settings.ts");
  const { settings } = getSettingsForSource("userSettings");
  const servers = { ...((settings?.mcpServers as Record<string, MCPServerConfig>) ?? {}) };
  servers[name] = cfg;
  patchSettingsFile("userSettings", "mcpServers", servers as any);
}

async function removeUserServer(name: string): Promise<boolean> {
  const { getSettingsForSource, patchSettingsFile } = await import("@sid-code/core/config/settings/settings.ts");
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

/**
 * 列出待审批的项目级 MCP 服务器（SEC-AUDIT-2026-07-19 P1）。
 *
 * 待审批 = 项目 .mcp.json 声明了、但用户从未批准/拒绝过的 server。这类 server
 * **不会被加载**（fail-closed），需显式 approve 后下次启动才生效。
 *
 * 实现要点：loadConfig() 会在合并阶段登记待审批快照（模块级单例），所以必须先
 * 跑一次 loadConfig 再读快照——不能只读 .mcp.json，那样拿不到"哪些已批准过"。
 */
async function cmdPending(asJson: boolean): Promise<void> {
  const { loadConfig } = await import("@sid-code/core/config/config.ts");
  await loadConfig({});
  const { getPendingApprovalServers } = await import("@sid-code/core/mcp/approval.ts");
  const { names, projectPath } = getPendingApprovalServers();

  if (asJson) {
    console.log(JSON.stringify({ pending: names, projectPath }, null, 2));
    return;
  }
  if (names.length === 0) {
    console.log("没有待审批的项目级 MCP 服务器。");
    return;
  }
  console.log(`待审批的项目级 MCP 服务器（共 ${names.length} 个，当前**未加载**）:\n`);
  for (const name of names) {
    console.log(`  ${name}`);
  }
  console.log(
    `\n项目: ${projectPath}\n` +
      `批准: sid-code mcp approve <name>   （或 --all 批准全部）\n` +
      `拒绝: sid-code mcp reject <name>\n` +
      `批准后需重启会话才会连接。`,
  );
}

/** 读取项目 .mcp.json 里声明的所有 server 名（不论审批状态）。 */
function projectDeclaredServerNames(): string[] {
  const mcpJsonPath = resolve(process.cwd(), ".mcp.json");
  if (!existsSync(mcpJsonPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    return Object.keys(parsed?.mcpServers ?? {});
  } catch {
    return [];
  }
}

/**
 * 批准 / 拒绝项目级 MCP 服务器。
 *
 * 作用域刻意是「.mcp.json 里声明的所有 server」，**不是**只有 pending 的那些——
 * 否则 approve 之后该 server 就离开了 pending 快照，reject 会报"不在待审批列表中"，
 * 用户**永远无法撤销一个已批准的 server**。审批是可反复改的决定，不是一次性闸门。
 * （--all 仍只作用于 pending，避免手滑把已明确拒绝的 server 一并批准。）
 */
async function cmdApproveReject(args: string[], approve: boolean): Promise<void> {
  const verb = approve ? "approve" : "reject";
  const all = args.includes("--all");
  const name = args.find((a) => !a.startsWith("--"));

  if (!name && !all) {
    console.error(`用法: sid-code mcp ${verb} <name> | --all`);
    process.exit(1);
  }

  // 先加载配置填充待审批快照（同 cmdPending 的理由）
  const { loadConfig } = await import("@sid-code/core/config/config.ts");
  await loadConfig({});
  const approval = await import("@sid-code/core/mcp/approval.ts");
  const { names: pendingNames, projectPath } = approval.getPendingApprovalServers();
  const declared = projectDeclaredServerNames();

  if (declared.length === 0) {
    console.log("当前目录没有 .mcp.json，或其中未声明任何 MCP 服务器。");
    return;
  }

  // --all 只批量处理 pending；指名则可作用于任何已声明的 server（含改判已批准的）
  const targets = all ? [...pendingNames] : [name!];
  if (targets.length === 0) {
    console.log("没有待审批的项目级 MCP 服务器。");
    return;
  }

  const cwd = projectPath || process.cwd();
  const done: string[] = [];
  for (const t of targets) {
    if (!declared.includes(t)) {
      console.error(`警告: "${t}" 未在项目 .mcp.json 中声明，已跳过。`);
      continue;
    }
    // 直接写持久化状态（approveProjectServer/rejectProjectServer 是幂等的互斥写），
    // 再顺手把它从 pending 快照里摘掉（若在）。
    if (approve) approval.approveProjectServer(t, cwd);
    else approval.rejectProjectServer(t, cwd);
    if (approve) approval.approvePendingServer(t);
    else approval.rejectPendingServer(t);
    done.push(t);
  }

  if (done.length === 0) {
    process.exit(1);
  }
  console.log(
    approve
      ? `已批准 ${done.length} 个 MCP 服务器: ${done.join(", ")}。重启会话后连接。`
      : `已拒绝 ${done.length} 个 MCP 服务器: ${done.join(", ")}。后续启动不再询问。`,
  );
}

export async function handleMcpCommand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "serve": {
      // G5：把 sid-code 自身工具暴露为 MCP server（stdio）。默认仅只读工具，
      // --allow-write 放开写/执行类。走独立入口，不启动 App。
      const { runMcpServe } = await import("../entrypoints/mcp-serve.ts");
      await runMcpServe(rest);
      return;
    }
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
    // SEC-AUDIT-2026-07-19 P1：项目级 MCP 审批入口
    case "pending":
      await cmdPending(asJson);
      return;
    case "approve":
      await cmdApproveReject(rest, true);
      return;
    case "reject":
      await cmdApproveReject(rest, false);
      return;
    default:
      console.error(
        `错误: 未知 mcp 子命令 "${sub}"。可用: list / get <name> / add <name> <command|url> / remove <name> / ` +
          `pending / approve <name>|--all / reject <name>|--all / serve [--allow-write]`,
      );
      process.exit(1);
  }
}
