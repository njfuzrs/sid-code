import type { UnifiedCommand } from "../../types.ts";

/**
 * /login 命令定义（轻量，启动时加载）。实现在 ./login.ts。
 *
 * 在 TUI 里用飞书身份登录企业后端（backend.url），等价于终端里的 `sid-code login`。
 * 登录的是企业后端，不是模型厂商账户。
 *
 * 注意：`/auth` 是 MCP 认证的别名（mcp-enhanced.ts），这里刻意不用它。
 */
const login: UnifiedCommand = {
  type: "local",
  name: "login",
  aliases: [],
  description: "用飞书身份登录企业后端（浏览器授权，不阻塞输入）",
  argumentHint: "[cancel]",
  source: "builtin",
  userInvocable: true,
  immediate: true,
  load: () => import("./login.ts").then((m) => m.default),
};

export default login;
