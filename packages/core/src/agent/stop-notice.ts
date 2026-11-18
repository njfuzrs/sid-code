/**
 * 停止原因 → 给父代理看的一句话（PR11 / D1 的可见部分）。
 *
 * ## 为什么需要这个模块
 *
 * `stop_action` 以前只写进遥测与日志。于是父代理看到的永远是一句「[子代理完成]」——
 * 无论子代理是正常收工、打满轮次被强制总结、被父代理叫停，还是撞了上下文上限。
 * 三种完全不同的可信度被压成同一句话，父代理的唯一选择就是「全都当正常结论用」，
 * 或者「全都怀疑」——前者会拿到被截断的结论当完整结论，后者白白丢掉可用结论。
 *
 * ## 为什么不新增状态枚举
 *
 * 这三个出口（打满 / 被父代理停 / 窗口耗尽）产出的都是**可用结论**，任务状态仍应是
 * completed（TUI 面板、任务统计、changelog 口径全都不必改）。差异只在**附注**：
 * 「这份结论是在什么条件下挤出来的」。所以这里只产出附注文本，不碰 status。
 *
 * ## 为什么 `finalize` 返回 undefined
 *
 * 正常收尾不该多一行噪音——每一份正常完成的通知都挂一句「正常完成」是纯负担，
 * 而且会让真正需要警惕的那几条淹没在重复文案里。
 */

/** 各出口的一句话说明。键是 `stop_action` 的取值（见 agentic-loop 各 return 点）。 */
const STOP_NOTICES: Readonly<Record<string, string>> = {
  max_turns: "已达轮次上限，以下为强制总结，结论可能不完整",
  stopped_by_parent: "被父代理停止，以下为停止前的总结",
  context_window_exhausted: "上下文撞到模型窗口上限，以下为压缩后的总结",
  loop_recovery_exhausted: "检测到循环且恢复次数耗尽，以下为收尾总结",
  empty_param_exhausted: "工具参数连续为空，以下为收尾总结",
  // `max_tokens_exhausted` 是一条 **success: true** 的出口（续写收益递减后停止续写，
  // 见 agentic-loop 的 maxTokensRecovery.decide → action === "stop"）。没有专属文案时
  // 它落到兜底分支，父代理会读到 `非正常结束（max_tokens_exhausted）…` —— 英文枚举名
  // 直接进模型上下文，既不可读也不符合「每种非 finalize 出口都有说明」的要求。
  max_tokens_exhausted: "输出续写收益耗尽，以下为已产出的部分",
  aborted: "执行被中止，以下为已产出的部分",
};

/**
 * 取本次停止原因对应的附注。
 *
 * @returns 需要提示时返回一句话；`finalize`（正常收尾）与未标注时返回 undefined，
 *   调用方据此**完全不插入这一行**（而不是插一个空字符串）。
 */
export function describeStopNotice(stopAction: string | undefined | null): string | undefined {
  if (!stopAction) return undefined;
  // finalize 是唯一「不需要解释」的出口：模型自己说完了，没有需要打折的前提。
  if (stopAction === "finalize") return undefined;
  return STOP_NOTICES[stopAction] ?? `非正常结束（${stopAction}），以下内容可能不完整`;
}
