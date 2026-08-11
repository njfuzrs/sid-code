import type { UnifiedCommand } from "../../types.ts";

/**
 * /context 命令定义（轻量，启动时加载）。
 *
 * 打开上下文用量可视化对话框：把上下文窗口按类别（系统提示词/工具定义/
 * 用户消息/助手回复/工具调用/工具结果/结构开销）拆分，彩色网格 + token 汇总。
 * 对齐 claude-code /context。实现在 ./context.ts。
 *
 * 与 /status 分工：/context 是"token 深度拆解"，/status 是"会话概览一屏"。
 */
const context: UnifiedCommand = {
  type: "local",
  name: "context",
  aliases: [],
  description: "上下文用量可视化（分类 token 拆解 + 距压缩阈值）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./context.ts").then((m) => m.default),
};

export default context;
