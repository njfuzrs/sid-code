import type { UnifiedCommand } from "../../types.ts";

/**
 * /status 命令定义（轻量，启动时加载）。
 *
 * 显示会话状态概览（对齐 CC /status）：模型/effort、会话 ID、工作目录、
 * 消息数与 token 用量、provider/fallback、激活的 skills/MCP 数量。
 *
 * 与 /context 分工：/status 是"会话概览一屏"，/context 是"token 深度拆解"。
 * 注意：IDE 连接状态是 /ide status（/ide 子命令），与本顶层命令不冲突。
 */
const status: UnifiedCommand = {
  type: "local",
  name: "status",
  aliases: [],
  description: "显示会话状态概览（模型/目录/token/provider/skills）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./status.ts").then((m) => m.default),
};

export default status;
