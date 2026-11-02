/**
 * MCP 管理命令增强版
 * 支持子命令：list/add/remove/enable/disable/test
 */

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { ArgParser } from "../../args.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getSettingsForSource, patchSettingsFile } from "@sid-code/core/config/settings/index.ts";

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
export class MCPEnhancedCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数时打开交互式面板
    if (!args.trim()) {
      return { type: "dialog", dialog: "mcp" };
    }
    // 有参数时仍走子命令文本模式（兜底：未匹配子命令走 list）
    return new MCPListCommand().call(args, ctx);
  }
}

/** /mcp list - 列出所有 MCP 服务器 */
export class MCPListCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return {
        type: "text",
        value:
          "未配置 MCP 服务器\n在 ~/.sid-code/settings.json 或项目 .mcp.json 中添加 mcpServers 配置",
      };
    }

    const statuses = ctx.mcpManager.getStatus();
    if (statuses.length === 0) {
      return { type: "text", value: "没有已连接的 MCP 服务器" };
    }

    const lines = ["MCP 服务器状态:"];
    for (const s of statuses) {
      const statusText =
        {
          connected: "✓ 已连接",
          connecting: "… 连接中",
          reconnecting: "↻ 重连中",
          failed: "✗ 连接失败",
          needs_auth: "! 待授权",
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

    return { type: "text", value: lines.join("\n") };
  }
}

/** /mcp add - 添加 MCP 服务器 */
export class MCPAddCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);
    const commandOrUrl = parser.get(1);

    if (!name || !commandOrUrl) {
      return errorText(
        "用法: /mcp add <name> <command|url> [args...] [--scope user|project] [--transport stdio|http|sse] [--env KEY=VALUE] [--timeout 5000]",
      );
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
        type: "text",
        value: `MCP 服务器 "${name}" 已添加到 ${scope} 配置 (${transport})\n重启会话后生效`,
      };
    } catch (err: any) {
      return errorText(`添加失败: ${err.message}`);
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
export class MCPRemoveCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return errorText("用法: /mcp remove <name> [--scope user|project]");
    }

    const scope = parser.string("scope", "project") as "user" | "project";

    try {
      this.removeServerConfig(name, scope);
      return {
        type: "text",
        value: `MCP 服务器 "${name}" 已从 ${scope} 配置中移除\n重启会话后生效`,
      };
    } catch (err: any) {
      return errorText(`移除失败: ${err.message}`);
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

/**
 * /mcp enable|disable 的共用实现（M2）。
 *
 * 对齐 CC：禁用是持久化的、用户私有、按项目身份（git root）存，**不改写共享的 .mcp.json**，
 * 并且当场断连 / 重连。原先的 `--session` 档只写 `sessionState.mcp_disabled`，全仓零读者
 * （提示「已禁用」而工具仍可调用），CC 也没有这一档 —— 已删除。
 */
async function toggleCommand(
  args: string,
  ctx: CommandContext,
  disabled: boolean,
): Promise<LocalCommandResult> {
  const verb = disabled ? "disable" : "enable";
  const name = new ArgParser(args).get(0);
  if (!name) {
    return errorText(`用法: /mcp ${verb} <name>`);
  }
  const known = ctx.mcpManager?.getStatus().some((s) => s.name === name) ?? false;
  if (!known && ctx.mcpManager) {
    return errorText(`未找到 MCP 服务器 "${name}"（用 /mcp list 查看）`);
  }
  try {
    const { toggleMcpServer } = await import("@sid-code/core/mcp/project-files.ts");
    const { applied } = await toggleMcpServer(name, disabled, ctx.mcpManager);
    const action = disabled ? "禁用" : "启用";
    return {
      type: "text",
      value: applied
        ? `MCP 服务器 "${name}" 已${action}（当前项目，已持久化）`
        : `MCP 服务器 "${name}" 已${action}（当前项目，已持久化），重启会话后生效`,
    };
  } catch (err: any) {
    return errorText(`${disabled ? "禁用" : "启用"}失败: ${err.message}`);
  }
}

/** /mcp enable - 启用 MCP 服务器 */
export class MCPEnableCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    return toggleCommand(args, ctx, false);
  }
}

/** /mcp disable - 禁用 MCP 服务器 */
export class MCPDisableCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    return toggleCommand(args, ctx, true);
  }
}

/** /mcp test - 测试 MCP 服务器连接 */
export class MCPTestCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return errorText("用法: /mcp test <name>");
    }

    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }

    // 查找服务器状态
    const statuses = ctx.mcpManager.getStatus();
    const server = statuses.find((s) => s.name === name);

    if (!server) {
      return errorText(`未找到 MCP 服务器 "${name}"`);
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

    if (server.status === "needs_auth") {
      lines.push(`提示: 运行 /mcp authenticate ${name} 完成 OAuth 授权`);
    }

    if (server.reconnectAttempts) {
      lines.push(`重连次数: ${server.reconnectAttempts}/5`);
    }

    return { type: "text", value: lines.join("\n") };
  }
}

/** /mcp authenticate - 触发远程 MCP 服务器的 OAuth 授权 */
export class MCPAuthenticateCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }

    const oauthServers = ctx.mcpManager.listOAuthServers();

    if (!name) {
      if (oauthServers.length === 0) {
        return {
          type: "text",
          value: '没有配置 OAuth 的 MCP 服务器\n在服务器配置中添加 "oauth": {} 即可启用 OAuth',
        };
      }
      return {
        type: "text",
        value: `用法: /mcp authenticate <name>\n可授权的服务器: ${oauthServers.join(", ")}`,
      };
    }

    try {
      const tools = await ctx.mcpManager.authenticate(name);
      return {
        type: "text",
        value: `${name} OAuth 授权成功，注册了 ${tools.length} 个工具`,
      };
    } catch (err: any) {
      return errorText(`授权失败: ${err.message}`);
    }
  }
}

/**
 * /mcp approve - 会话内批准项目 .mcp.json 里待审批的 server 并立即连接（D17）。
 *
 * 原先唯一的审批入口是 `sid-code mcp approve`（独立子进程，手上没有 manager），
 * 只能落盘后让用户重启。会话内有 manager，就直接 addServer 热连接。
 */
export class MCPApproveCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const name = new ArgParser(args).get(0);
    const approval = await import("@sid-code/core/mcp/approval.ts");
    const { names } = approval.getPendingApprovalServers();

    if (!name) {
      return {
        type: "text",
        value:
          names.length === 0
            ? "没有待审批的项目级 MCP 服务器"
            : `用法: /mcp approve <name>\n待审批: ${names.join(", ")}`,
      };
    }
    if (!names.includes(name)) {
      return errorText(`"${name}" 不在待审批列表中`);
    }
    if (!ctx.mcpManager) {
      // 本会话没有任何 MCP server 时 manager 不会创建：只能落盘，下次启动连接
      approval.approvePendingServer(name);
      return { type: "text", value: `已批准 "${name}"，重启会话后连接` };
    }
    const mgr = ctx.mcpManager;
    const count = await approval.approveAndConnectPendingServer(name, (n, c) =>
      mgr.addServer(n, c),
    );
    const status = mgr.getStatus().find((s) => s.name === name);
    if (status?.status === "connected") {
      return { type: "text", value: `已批准并连接 "${name}"，注册了 ${count} 个工具` };
    }
    return {
      type: "text",
      value: `已批准 "${name}"，但连接未成功${status?.error ? `：${status.error}` : ""}（下次启动会再试）`,
    };
  }
}

/**
 * /mcp reject - 会话内拒绝项目 .mcp.json 里待审批的 server（M3）。
 * 拒绝后续启动直接跳过、不再询问；改主意用 `sid-code mcp approve <name>`。
 */
export class MCPRejectCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const name = new ArgParser(args).get(0);
    const approval = await import("@sid-code/core/mcp/approval.ts");
    const { names } = approval.getPendingApprovalServers();
    if (!name) {
      return {
        type: "text",
        value:
          names.length === 0
            ? "没有待审批的项目级 MCP 服务器"
            : `用法: /mcp reject <name>\n待审批: ${names.join(", ")}`,
      };
    }
    if (!approval.rejectPendingServer(name)) {
      return errorText(`"${name}" 不在待审批列表中`);
    }
    return { type: "text", value: `已拒绝 "${name}"，后续启动不再询问` };
  }
}

/** /mcp prompts - 列出所有提示词 */
export class MCPPromptsCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }

    const prompts = ctx.mcpManager.getAllPrompts();
    if (prompts.length === 0) {
      return { type: "text", value: "没有可用的 MCP 提示词" };
    }

    const lines = ["MCP 提示词:"];
    for (const { serverName, prompt } of prompts) {
      const argList =
        prompt.arguments?.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ") || "";
      const desc = prompt.description ? ` — ${prompt.description}` : "";
      lines.push(`  /mcp prompt ${serverName}:${prompt.name} ${argList}${desc}`);
    }

    return { type: "text", value: lines.join("\n") };
  }
}

/**
 * /mcp prompt <server>:<name> [k=v...] - 执行指定提示词并提交给 LLM
 *
 * B3：修复引导语指向的「/mcp prompt」命令此前不存在（承诺了不存在的命令，
 * 用户照做时命令回退到父命令 → 只列状态）。逻辑迁自原死代码 MCPCommand.usePrompt。
 */
export class MCPPromptRunCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }

    // 格式：<server>:<promptName> [arg1=val1 arg2=val2 ...]
    const match = args.trim().match(/^(\S+?):(\S+)(?:\s+(.*))?$/);
    if (!match) {
      return errorText(
        "用法: /mcp prompt <server>:<name> [arg1=val1 arg2=val2 ...]\n用 /mcp prompts 查看可用提示词",
      );
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
      const text = messages.map((m) => m.content).join("\n\n");
      if (!text.trim()) {
        return errorText(`提示词 ${serverName}:${promptName} 返回空内容`);
      }
      return { type: "submit_prompt", prompt: text };
    } catch (err: any) {
      return errorText(`获取提示词失败: ${err.message}`);
    }
  }
}

/** /mcp resources - 列出所有资源 */
export class MCPResourcesCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }

    const resources = ctx.mcpManager.getAllResources();
    if (resources.length === 0) {
      return { type: "text", value: "没有可用的 MCP 资源" };
    }

    const lines = ["MCP 资源:"];
    for (const { serverName, resource } of resources) {
      const desc = resource.description ? ` — ${resource.description}` : "";
      const mime = resource.mimeType ? ` [${resource.mimeType}]` : "";
      lines.push(`  ${serverName}: ${resource.name} (${resource.uri})${mime}${desc}`);
    }

    return { type: "text", value: lines.join("\n") };
  }
}
