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
  // 无参数（问题）就只能打印用法，故补全列表回车仅回填等待用户输入问题。
  requiresArgs: true,
  source: "builtin",
  // 无头三形态放行（T8）：只读问答，依赖的 ctxMgr / provider / toolRegistry / config
  // 全部已注入；无参打印用法、无上下文给提示、失败走 errorText（非 0），没有 dialog/confirm/quit。
  // `-p` 单轮无 `-c` 时 ctxMgr 为空 → 不调 LLM，只回「当前还没有对话上下文」；`-p -c` 与
  // stream-json / Bridge 下有真实历史，旁路提问有实际价值。
  headless: true,
  // 仅用户可调用（内置命令本就没有模型调用路径，见 CommandBase.disableModelInvocation 注释）。
  userInvocable: true,
  load: () => import("./btw.ts").then((m) => m.default),
};

export default btw;
