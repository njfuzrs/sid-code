/**
 * 催促类 reminder 注入节流（去重 + 封顶）
 *
 * 背景（对话重播/消息被截断幻觉根因，会话 20260707-155324-1fb62e56）：
 * queryLoop 每轮把 todo 回注 / 工作日志摘要作为 system-reminder 注入到**最后一条 user 消息**。
 * 在"长任务 + todo 收尾卡壳 + 纯工具轮密集"三条件叠加时，这些注入会连续生成
 * "内容近似、无新用户指令"的消息块。弱模型（DeepSeek）无法区分"这是系统提醒"还是
 * "用户又发了半句话"，于是判定"消息被截断 / 这是上一轮的重播"并空转。
 *
 * 本模块提炼两条独立纪律（纯函数，便于单测，不耦合具体循环）：
 * - 去重：候选文本与"上次注入的同类文本"逐字节相同 → 期间毫无进展 → 跳过注入。
 * - 封顶：连续 N 次注入催促而 todo 无进展（writeVersion 未变化）后 → 停止催促，
 *   因为模型显然不会再改 todo，继续催只会造更多"幻影用户消息"。
 *   end_turn 处的 todo gate（MAX_TODO_GATE_RETRIES）仍兜底，不会假装完成。
 */

/**
 * "无进展催促"注入次数上限。达到后本条用户消息剩余轮次不再注入 todo/progress 催促。
 * 取 2：给模型两次"看见提醒后自我修正"的机会，仍无进展则判定催促无效，停手。
 */
export const MAX_NO_PROGRESS_NAGS = 2;

/** 注入决策结果 */
export interface NagDecision {
  /** 是否应当注入该催促 */
  inject: boolean;
  /**
   * 本次是否应计入"无进展催促"计数。
   * 仅当"确实注入了"且调用方判定期间 todo 无进展时才为 true——
   * 由调用方结合 writeVersion 是否变化决定是否真正 +1（本函数不感知 writeVersion）。
   * 未注入（去重/封顶/空候选）时恒为 false。
   */
  countedAsNoProgress: boolean;
}

/**
 * 决定一条催促类 reminder 是否注入。
 *
 * 判定顺序：
 *   1. candidate 为 null（builder 判定无需提醒，如无待办）→ 不注入。
 *   2. 与 lastInjectedText 逐字节相同（期间毫无进展）→ 不注入（去重）。
 *   3. noProgressNagCount 已达 cap（连续催促无效）→ 不注入（封顶）。
 *   4. 否则 → 注入。
 *
 * @param candidate       本轮 builder 产出的 reminder 文本，或 null
 * @param lastInjectedText 上次注入的同类 reminder 文本（undefined 表示尚未注过）
 * @param noProgressNagCount 当前累计的"无进展催促"次数
 * @param cap             封顶阈值，默认 MAX_NO_PROGRESS_NAGS
 */
export function decideNagInjection(args: {
  candidate: string | null;
  lastInjectedText: string | undefined;
  noProgressNagCount: number;
  cap?: number;
}): NagDecision {
  const { candidate, lastInjectedText, noProgressNagCount } = args;
  const cap = args.cap ?? MAX_NO_PROGRESS_NAGS;

  // 1. 空候选：builder 判定无需提醒
  if (candidate == null) return { inject: false, countedAsNoProgress: false };

  // 2. 去重：与上次注入内容完全相同 → 期间无进展，跳过
  if (lastInjectedText !== undefined && candidate === lastInjectedText) {
    return { inject: false, countedAsNoProgress: false };
  }

  // 3. 封顶：连续催促已达上限 → 停手（即便文本有细微变化，如"仍待办 N 项"的 N 变了，
  //    只要模型持续不动 todo，继续催仍是幻影；封顶以 count 为准，不看文本差异）
  if (noProgressNagCount >= cap) {
    return { inject: false, countedAsNoProgress: false };
  }

  // 4. 注入。是否计入"无进展"由调用方结合 writeVersion 决定，这里给出候选信号。
  return { inject: true, countedAsNoProgress: true };
}
