import type { UnifiedCommand } from "../../types.ts";

/** /mcp 命令定义（轻量，启动时加载）。实现在 ./mcp.ts。 */
const mcp: UnifiedCommand = {
  type: "local",
  name: "mcp",
  aliases: [],
  description: "MCP 服务器管理（无参打开交互面板）",
  argumentHint:
    "[list|add|remove|enable|disable|test|authenticate|approve|reject|prompts|prompt|resources] [参数]",
  source: "builtin",
  outputPanel: true,
  subCommands: () => [
    {
      type: "local",
      name: "list",
      aliases: ["ls", "status"],
      description: "列出所有 MCP 服务器状态",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPListCommand()),
    },
    {
      type: "local",
      name: "add",
      aliases: [],
      description: "添加 MCP 服务器配置",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPAddCommand()),
    },
    {
      type: "local",
      name: "remove",
      aliases: ["rm", "delete"],
      description: "移除 MCP 服务器配置",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPRemoveCommand()),
    },
    {
      type: "local",
      name: "enable",
      aliases: [],
      description: "启用 MCP 服务器（当前项目，持久化）",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPEnableCommand()),
    },
    {
      type: "local",
      name: "disable",
      aliases: [],
      description: "禁用 MCP 服务器（当前项目，持久化，当场断开）",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPDisableCommand()),
    },
    {
      type: "local",
      name: "test",
      aliases: [],
      description: "测试 MCP 服务器连接",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPTestCommand()),
    },
    // 别名收窄为 ["auth"]：不再劫持 "login"（账户登录通用语义，CC /login=登录 Anthropic 账户）。
    // 释放顶层 login，避免未来账户体系硬冲突 + 语义误导。
    {
      type: "local",
      name: "authenticate",
      aliases: ["auth"],
      description: "对配置了 OAuth 的远程 MCP 服务器发起授权",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPAuthenticateCommand()),
    },
    {
      type: "local",
      name: "approve",
      aliases: [],
      description: "批准项目 .mcp.json 中待审批的 MCP 服务器并立即连接",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPApproveCommand()),
    },
    {
      type: "local",
      name: "reject",
      aliases: [],
      description: "拒绝项目 .mcp.json 中待审批的 MCP 服务器（后续启动不再询问）",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPRejectCommand()),
    },
    {
      type: "local",
      name: "prompts",
      aliases: [],
      description: "列出所有 MCP 提示词",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPPromptsCommand()),
    },
    {
      type: "local",
      name: "prompt",
      aliases: [],
      description: "执行 MCP 提示词：/mcp prompt <server>:<name> [arg=val ...]",
      argumentHint: "<server>:<name> [arg=val ...]",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPPromptRunCommand()),
    },
    {
      type: "local",
      name: "resources",
      aliases: [],
      description: "列出所有 MCP 资源",
      source: "builtin",
      load: () => import("./mcp.ts").then((m) => new m.MCPResourcesCommand()),
    },
  ],
  load: () => import("./mcp.ts").then((m) => new m.MCPEnhancedCommand()),
};

export default mcp;
