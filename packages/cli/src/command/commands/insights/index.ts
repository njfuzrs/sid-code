import type { UnifiedCommand } from "../../types.ts";

/**
 * /insights 命令定义（轻量，启动时加载）。对齐 claude-code §4.6。
 *
 * 生成会话分析报告：模型/耗时/API 调用/成本/token/工具序列/异常/子代理概览。
 * 复用 trace/digest.ts 已导出的分析函数（与 /debug、scripts/trace-digest.ts 同源）。
 * 无参分析当前会话，带 session-id/前缀/latest 分析历史会话。实现在 ./insights.ts。
 */
const insights: UnifiedCommand = {
  type: "local",
  name: "insights",
  aliases: ["analyze"],
  description: "生成会话分析报告（模型/成本/token/工具/异常概览）",
  argumentHint: "[session-id|latest]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./insights.ts").then((m) => m.default),
};

export default insights;
