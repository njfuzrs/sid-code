import type { UnifiedCommand } from "../../types.ts";

/**
 * /btw（Side Question）命令定义（轻量，启动时加载）
 *
 * 用户在等待主 agent 执行时想顺手问个旁路问题——fork 一个共享完整上下文的
 * agent 单次回答，不打断、不污染主对话。实现代码在 ./btw.ts，按需 load()。
 */
const btw: UnifiedCommand = {
  type: "local",
  name: "btw",
  aliases: ["by-the-way", "ask"],
  description: "旁路提问：基于当前对话上下文快速回答，不打断也不写入主对话",
  argumentHint: "你的问题",
  source: "builtin",
  // 仅用户可调用——这是 UX 快捷入口，模型不应自行触发。
  userInvocable: true,
  disableModelInvocation: true,
  load: () => import("./btw.ts").then((m) => m.default),
};

export default btw;
