/**
 * MCP 管理命令增强版
 * 支持子命令：list/add/remove/enable/disable/test
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { ArgParser } from "./args.ts";
import { getLogger } from "../debug/logger.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  getSettingsForSource,
  patchSettingsFile,
} from "../config/settings/index.ts";

/** MCP 服务器配置 */
interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "stdio" | "http" | "sse";
  headers?: Record<string, string>;
  timeout?: number;
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
}

/** /mcp 主命令 */
export class MCPEnhancedCommand implements Command {
  name() { return "mcp"; }
  aliases() { return []; }
  description() { return "MCP 服务器管理"; }

  subCommands(): Command[] {
    return [
      new MCPListCommand(),
      new MCPAddCommand(),
      new MCPRemoveCommand(),
      new MCPEnableCommand(),
      new MCPDisableCommand(),
      new MCPTestCommand(),
      new MCPAuthenticateCommand(),
      new MCPPromptsCommand(),
      new MCPPromptRunCommand(),
      new MCPResourcesCommand(),
    ];
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 无参数时打开交互式面板
    if (!args.trim()) {
      return { kind: "dialog", dialog: "mcp" };
    }
    // 有参数时仍走子命令文本模式（兜底：未匹配子命令走 list）
    return new MCPListCommand().execute(args, ctx);
  }
}

/** /mcp list - 列出所有 MCP 服务器 */
class MCPListCommand implements Command {
  name() { return "list"; }
  aliases() { return ["ls", "status"]; }
  description() { return "列出所有 MCP 服务器状态"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return {
        kind: "message",
        message: "未配置 MCP 服务器\n在 ~/.sid-code/settings.json 或项目 .mcp.json 中添加 mcpServers 配置",
      };
    }

    const statuses = ctx.mcpManager.getStatus();
    if (statuses.length === 0) {
      return { kind: "message", message: "没有已连接的 MCP 服务器" };
    }

    const lines = ["MCP 服务器状态:"];
    for (const s of statuses) {
      const statusText = {
        connected: "✓ 已连接",
        connecting: "… 连接中",
        reconnecting: "↻ 重连中",
        failed: "✗ 连接失败",
        disabled: "○ 已禁用",
        disconnected: "✗ 未连接",
      }[s.status] || s.status;

      const counts: string[] = [];
      if (s.status === "connected") {
        counts.push(`${s.toolCount} 工具`);
        if (s.resourceCount > 0) counts.push(`${s.resourceCount} 资源`);
        if (s.promptCount > 0) counts.push(`${s.promptCount} 提示词`);
      }

      const reconnect = s.reconnectAttempts ? ` (重连 ${s.reconnectAttempts}/5)` : "";
      const error = s.error ? ` - ${s.error}` : "";
      const info = counts.length > 0 ? ` [${counts.join(", ")}]` : "";

      lines.push(`  ${statusText} ${s.name} (${s.transport})${info}${reconnect}${error}`);
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /mcp add - 添加 MCP 服务器 */
class MCPAddCommand implements Command {
  name() { return "add"; }
  aliases() { return []; }
  description() { return "添加 MCP 服务器配置"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);
    const commandOrUrl = parser.get(1);

    if (!name || !commandOrUrl) {
      return {
        kind: "error",
        message: "用法: /mcp add <name> <command|url> [args...] [--scope user|project] [--transport stdio|http|sse] [--env KEY=VALUE] [--timeout 5000]",
      };
    }

    const scope = parser.string("scope", "project") as "user" | "project";
    const transport = parser.string("transport", "stdio") as "stdio" | "http" | "sse";
    const timeout = parser.number("timeout");
    const trust = parser.flag("trust");
    const description = parser.string("description");

    // 构建服务器配置
    const serverConfig: MCPServerConfig = {};

    if (transport === "stdio") {
      serverConfig.command = commandOrUrl;
      const restArgs = parser.getRest(2);
      if (restArgs) {
        serverConfig.args = restArgs.split(/\s+/);
      }

      // 处理环境变量
      const envStr = parser.string("env");
      if (envStr) {
        serverConfig.env = {};
        for (const pair of envStr.split(",")) {
          const [key, value] = pair.split("=");
          if (key && value) {
            serverConfig.env[key.trim()] = value.trim();
          }
        }
      }
    } else {
      serverConfig.url = commandOrUrl;
      serverConfig.type = transport;

      // 处理 HTTP headers
      const headerStr = parser.string("header");
      if (headerStr) {
        serverConfig.headers = {};
        for (const pair of headerStr.split(",")) {
          const [key, value] = pair.split(":");
          if (key && value) {
            serverConfig.headers[key.trim()] = value.trim();
          }
        }
      }
    }

    if (timeout) serverConfig.timeout = timeout;
    if (trust) serverConfig.trust = trust;
    if (description) serverConfig.description = description;

    // 写入配置文件
    try {
      this.saveServerConfig(name, serverConfig, scope);
      return {
        kind: "message",
        message: `MCP 服务器 "${name}" 已添加到 ${scope} 配置 (${transport})\n重启会话后生效`,
      };
    } catch (err: any) {
      return { kind: "error", message: `添加失败: ${err.message}` };
    }
  }

  private saveServerConfig(name: string, config: MCPServerConfig, scope: "user" | "project"): void {
    const log = getLogger();

    if (scope === "project") {
      // 写入项目级 .mcp.json
      const mcpJsonPath = resolve(process.cwd(), ".mcp.json");
      let mcpConfig: { mcpServers?: Record<string, MCPServerConfig> } = {};

      if (existsSync(mcpJsonPath)) {
        const content = readFileSync(mcpJsonPath, "utf-8");
        mcpConfig = JSON.parse(content);
      }

      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers[name] = config;

      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      log.info("MCP_ADD", `已写入 ${mcpJsonPath}`);
    } else {
      // 写入用户级 ~/.sid-code/settings.json 的 mcpServers。
      // 仅读现有 mcpServers 做增量，再用 patchSettingsFile 只写这一个字段——
      // 不能整体 writeSettingsFile：会经 Zod 有损解析 strip 掉 MCP 自定义字段 +
      // 把 env 占位符展开成明文密钥落盘。
      const { settings } = getSettingsForSource("userSettings");
      const servers = { ...(settings?.mcpServers ?? {}) };
      servers[name] = config as any;

      patchSettingsFile("userSettings", "mcpServers", servers);
      log.info("MCP_ADD", `已写入用户 settings.json: ${name}`);
    }
  }
}

/** /mcp remove - 移除 MCP 服务器 */
class MCPRemoveCommand implements Command {
  name() { return "remove"; }
  aliases() { return ["rm", "delete"]; }
  description() { return "移除 MCP 服务器配置"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return { kind: "error", message: "用法: /mcp remove <name> [--scope user|project]" };
    }

    const scope = parser.string("scope", "project") as "user" | "project";

    try {
      this.removeServerConfig(name, scope);
      return {
        kind: "message",
        message: `MCP 服务器 "${name}" 已从 ${scope} 配置中移除\n重启会话后生效`,
      };
    } catch (err: any) {
      return { kind: "error", message: `移除失败: ${err.message}` };
    }
  }

  private removeServerConfig(name: string, scope: "user" | "project"): void {
    const log = getLogger();

    if (scope === "project") {
      const mcpJsonPath = resolve(process.cwd(), ".mcp.json");
      if (!existsSync(mcpJsonPath)) {
        throw new Error("项目配置文件 .mcp.json 不存在");
      }

      const content = readFileSync(mcpJsonPath, "utf-8");
      const mcpConfig = JSON.parse(content);

      if (!mcpConfig.mcpServers?.[name]) {
        throw new Error(`服务器 "${name}" 不存在于项目配置中`);
      }

      delete mcpConfig.mcpServers[name];
      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      log.info("MCP_REMOVE", `已从 ${mcpJsonPath} 移除 ${name}`);
    } else {
      const { settings } = getSettingsForSource("userSettings");
      const servers = { ...(settings?.mcpServers ?? {}) };

      if (!servers[name]) {
        throw new Error(`服务器 "${name}" 不存在于用户配置中`);
      }

      delete servers[name];
      // 外科式补丁：只写 mcpServers，避免整体覆盖丢字段/明文化密钥。
      patchSettingsFile("userSettings", "mcpServers", servers);
      log.info("MCP_REMOVE", `已从用户 settings.json 移除 ${name}`);
    }
  }
}

/** /mcp enable - 启用 MCP 服务器 */
class MCPEnableCommand implements Command {
  name() { return "enable"; }
  aliases() { return []; }
  description() { return "启用 MCP 服务器"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return { kind: "error", message: "用法: /mcp enable <name> [--session]" };
    }

    const sessionOnly = parser.flag("session");

    if (sessionOnly) {
      // 会话级启用（从 SessionState 中移除禁用标记）
      const disabled = ctx.sessionState.get("mcp_disabled") as string[] || [];
      const newDisabled = disabled.filter(n => n !== name);
      ctx.sessionState.set("mcp_disabled", newDisabled);
      return { kind: "message", message: `MCP 服务器 "${name}" 已在当前会话启用` };
    }

    // G6-3：持久化启用——把 enabled=true 写回 server 所在配置源（user/project）。
    try {
      const target = setServerEnabled(name, true);
      if (!target) {
        return { kind: "error", message: `未在 user/project 配置中找到 MCP 服务器 "${name}"` };
      }
      return { kind: "message", message: `MCP 服务器 "${name}" 已持久启用（${target} 配置）\n重启会话后生效` };
    } catch (err: any) {
      return { kind: "error", message: `启用失败: ${err.message}` };
    }
  }
}

/** /mcp disable - 禁用 MCP 服务器 */
class MCPDisableCommand implements Command {
  name() { return "disable"; }
  aliases() { return []; }
  description() { return "禁用 MCP 服务器"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return { kind: "error", message: "用法: /mcp disable <name> [--session]" };
    }

    const sessionOnly = parser.flag("session");

    if (sessionOnly) {
      // 会话级禁用（存储在 SessionState）
      const disabled = ctx.sessionState.get("mcp_disabled") as string[] || [];
      if (!disabled.includes(name)) {
        disabled.push(name);
        ctx.sessionState.set("mcp_disabled", disabled);
      }
      return { kind: "message", message: `MCP 服务器 "${name}" 已在当前会话禁用` };
    }

    // G6-3：持久化禁用——把 enabled=false 写回 server 所在配置源（user/project）。
    try {
      const target = setServerEnabled(name, false);
      if (!target) {
        return { kind: "error", message: `未在 user/project 配置中找到 MCP 服务器 "${name}"` };
      }
      return { kind: "message", message: `MCP 服务器 "${name}" 已持久禁用（${target} 配置）\n重启会话后生效` };
    } catch (err: any) {
      return { kind: "error", message: `禁用失败: ${err.message}` };
    }
  }
}

/**
 * G6-3：把某 MCP 服务器的 enabled 位持久化到它所在的配置源。
 *
 * 查找顺序：project(.mcp.json) → user(settings.json)。找到即在该源就地改 enabled，
 * 返回命中的 scope；两处都没有返回 null。用 patchSettingsFile 只改一字段，避免整体
 * 重写 settings 时 Zod 有损解析（strip 掉 MCP 自定义字段 + 展开 env 占位符落明文）。
 */
function setServerEnabled(name: string, enabled: boolean): "project" | "user" | null {
  const log = getLogger();

  // project：.mcp.json
  const mcpJsonPath = resolve(process.cwd(), ".mcp.json");
  if (existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
      const servers = parsed.mcpServers ?? parsed.mcp_servers ?? parsed;
      if (servers && typeof servers === "object" && servers[name]) {
        servers[name].enabled = enabled;
        writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2), "utf-8");
        log.info("MCP", `已持久化 ${name} enabled=${enabled} 到 .mcp.json`);
        return "project";
      }
    } catch (err) {
      log.warn("MCP", `读取 .mcp.json 失败: ${err}`);
    }
  }

  // user：~/.sid-code/settings.json 的 mcpServers
  const { settings } = getSettingsForSource("userSettings");
  const servers = { ...(settings?.mcpServers ?? {}) } as Record<string, any>;
  if (servers[name]) {
    servers[name] = { ...servers[name], enabled };
    patchSettingsFile("userSettings", "mcpServers", servers);
    log.info("MCP", `已持久化 ${name} enabled=${enabled} 到用户 settings.json`);
    return "user";
  }

  return null;
}

/** /mcp test - 测试 MCP 服务器连接 */
class MCPTestCommand implements Command {
  name() { return "test"; }
  aliases() { return []; }
  description() { return "测试 MCP 服务器连接"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return { kind: "error", message: "用法: /mcp test <name>" };
    }

    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }

    // 查找服务器状态
    const statuses = ctx.mcpManager.getStatus();
    const server = statuses.find(s => s.name === name);

    if (!server) {
      return { kind: "error", message: `未找到 MCP 服务器 "${name}"` };
    }

    const lines = [
      `MCP 服务器: ${name}`,
      `传输方式: ${server.transport}`,
      `状态: ${server.status}`,
    ];

    if (server.status === "connected") {
      lines.push(`工具数量: ${server.toolCount}`);
      lines.push(`资源数量: ${server.resourceCount}`);
      lines.push(`提示词数量: ${server.promptCount}`);
    }

    if (server.error) {
      lines.push(`错误: ${server.error}`);
    }

    if (server.reconnectAttempts) {
      lines.push(`重连次数: ${server.reconnectAttempts}/5`);
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /mcp authenticate - 触发远程 MCP 服务器的 OAuth 授权 */
class MCPAuthenticateCommand implements Command {
  name() { return "authenticate"; }
  // 别名收窄为 ["auth"]：不再劫持 "login"（账户登录通用语义，CC /login=登录 Anthropic 账户）。
  // 释放顶层 login，避免未来账户体系硬冲突 + 语义误导。
  aliases() { return ["auth"]; }
  description() { return "对配置了 OAuth 的远程 MCP 服务器发起授权"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }

    const oauthServers = ctx.mcpManager.listOAuthServers();

    if (!name) {
      if (oauthServers.length === 0) {
        return {
          kind: "message",
          message: "没有配置 OAuth 的 MCP 服务器\n在服务器配置中添加 \"oauth\": {} 即可启用 OAuth",
        };
      }
      return {
        kind: "message",
        message: `用法: /mcp authenticate <name>\n可授权的服务器: ${oauthServers.join(", ")}`,
      };
    }

    try {
      const tools = await ctx.mcpManager.authenticate(name);
      return {
        kind: "message",
        message: `${name} OAuth 授权成功，注册了 ${tools.length} 个工具`,
      };
    } catch (err: any) {
      return { kind: "error", message: `授权失败: ${err.message}` };
    }
  }
}

/** /mcp prompts - 列出所有提示词 */
class MCPPromptsCommand implements Command {
  name() { return "prompts"; }
  aliases() { return []; }
  description() { return "列出所有 MCP 提示词"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }

    const prompts = ctx.mcpManager.getAllPrompts();
    if (prompts.length === 0) {
      return { kind: "message", message: "没有可用的 MCP 提示词" };
    }

    const lines = ["MCP 提示词:"];
    for (const { serverName, prompt } of prompts) {
      const argList = prompt.arguments?.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(" ") || "";
      const desc = prompt.description ? ` — ${prompt.description}` : "";
      lines.push(`  /mcp prompt ${serverName}:${prompt.name} ${argList}${desc}`);
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/**
 * /mcp prompt <server>:<name> [k=v...] - 执行指定提示词并提交给 LLM
 *
 * B3：修复引导语指向的「/mcp prompt」命令此前不存在（承诺了不存在的命令，
 * 用户照做时命令回退到父命令 → 只列状态）。逻辑迁自原死代码 MCPCommand.usePrompt。
 */
class MCPPromptRunCommand implements Command {
  name() { return "prompt"; }
  aliases() { return []; }
  description() { return "执行 MCP 提示词：/mcp prompt <server>:<name> [arg=val ...]"; }
  argumentHint() { return "<server>:<name> [arg=val ...]"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }

    // 格式：<server>:<promptName> [arg1=val1 arg2=val2 ...]
    const match = args.trim().match(/^(\S+?):(\S+)(?:\s+(.*))?$/);
    if (!match) {
      return {
        kind: "error",
        message: "用法: /mcp prompt <server>:<name> [arg1=val1 arg2=val2 ...]\n用 /mcp prompts 查看可用提示词",
      };
    }

    const [, serverName, promptName, argStr] = match;
    const promptArgs: Record<string, string> = {};
    if (argStr) {
      for (const pair of argStr.split(/\s+/)) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          promptArgs[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
    }

    try {
      const messages = await ctx.mcpManager.getPrompt(
        serverName,
        promptName,
        Object.keys(promptArgs).length > 0 ? promptArgs : undefined,
      );
      // 将提示词消息拼接为文本，作为用户输入提交给 LLM
      const text = messages.map(m => m.content).join("\n\n");
      if (!text.trim()) {
        return { kind: "error", message: `提示词 ${serverName}:${promptName} 返回空内容` };
      }
      return { kind: "submit_prompt", prompt: text };
    } catch (err: any) {
      return { kind: "error", message: `获取提示词失败: ${err.message}` };
    }
  }
}

/** /mcp resources - 列出所有资源 */
class MCPResourcesCommand implements Command {
  name() { return "resources"; }
  aliases() { return []; }
  description() { return "列出所有 MCP 资源"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }

    const resources = ctx.mcpManager.getAllResources();
    if (resources.length === 0) {
      return { kind: "message", message: "没有可用的 MCP 资源" };
    }

    const lines = ["MCP 资源:"];
    for (const { serverName, resource } of resources) {
      const desc = resource.description ? ` — ${resource.description}` : "";
      const mime = resource.mimeType ? ` [${resource.mimeType}]` : "";
      lines.push(`  ${serverName}: ${resource.name} (${resource.uri})${mime}${desc}`);
    }

    return { kind: "message", message: lines.join("\n") };
  }
}
