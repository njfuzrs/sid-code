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

/**
 * todo 通道的**条件式**封顶上限（P1-4 item 2）。
 *
 * ⚠ 读这段之前先读下面 `decideTodoNagInjection` 的注释——它解释了为什么这个 cap
 * 不能像 work-log 那样无条件生效。取 2 与 MAX_NO_PROGRESS_NAGS 对齐：给模型两次
 * "看见提醒后顺手更新清单"的机会。
 */
export const MAX_TODO_BOOKKEEPING_NAGS = 2;

/** todo 通道条件封顶计数器在 SessionState 里的键（跨用户消息持久，见函数注释）。 */
export const TODO_BOOKKEEPING_NAG_COUNT_KEY = "todoBookkeepingNagCount";

/**
 * 决定 todo 清单回注是否注入（在节流判定之后、注入之前调用）。
 *
 * ─── 为什么不能直接给 todo 通道加一个无条件 cap（P1-4 item 2 的核心取舍）───
 *
 * 修复方案文档（20260811）§4.4 item 2 的字面处方是"给 todo 通道加 cap，对齐 work-log 的
 * MAX_NO_PROGRESS_NAGS"。**照字面实现会直接回退 2026-08-01 那轮修复**，故此处刻意偏离：
 *
 * todo 通道的去重与封顶是 2026-08-01 **实测数据驱动**删掉的（见 types.ts 的注释块与
 * loop.ts 无状态扫描段）：60 轮停滞会话只注入 1 次、nagCount 最终 1 / cap 2 —— 封顶连触发
 * 机会都没有，去重先把通道锁死了。机理是 `buildTodoReminder(todos)` 的文本只随清单内容
 * 变化，模型一停滞清单就不变 → 文本恒定 → 从第 2 次起永久静音。而"模型停滞"恰恰是**最需要
 * 催更的时刻**：那道闸把"该催"与"不该催"判反了，属**防线过度生效导致主功能失效**。
 * 对标实现（attachments.ts）在此处同样没有任何去重和封顶。
 *
 * 但文档 item 2 的**另一半**是对的、且与已有修复相容：**绑真实进展**。区别在于"催什么"：
 *
 *   | 态 | 事实 | 催促的性质 | 处置 |
 *   |---|---|---|---|
 *   | 有真实副作用进展，但清单没动 | 模型在干活，只是没记账 | 催的是**记账**，不是干活 | 催 N 次无效即停手 |
 *   | 无真实副作用进展 | 模型真的卡住了 | 催的是**干活**，是主功能 | **永不封顶**（保住 2026-08-01） |
 *
 * 第一态封顶是安全的：模型已经在推进，清单只是滞后的元数据，反复催记账纯属噪音
 * （而重复注入 user 通道提醒正是"对话重播/截断幻觉"的根因，见本文件顶部）。
 * 第二态不封顶，2026-08-01 证明必须保住的那条路径完整不变。
 *
 * 计数器挂 SessionState 而非 LoopState：LoopState 每条用户消息重建，计数会归零，
 * 封顶等于形同虚设（审计第 9 条同源教训）。
 *
 * @param hasRealProgress 本会话是否存在真实副作用进展（见 measured-progress.ts hasRealProgress）
 * @param bookkeepingNagCount 已累计的"有进展但没记账"催促次数
 * @param cap 封顶阈值，默认 MAX_TODO_BOOKKEEPING_NAGS
 */
export function decideTodoNagInjection(args: {
  hasRealProgress: boolean;
  bookkeepingNagCount: number;
  cap?: number;
}): NagDecision {
  const cap = args.cap ?? MAX_TODO_BOOKKEEPING_NAGS;

  // 无真实进展 = 模型真卡住 = 催更是主功能，永不封顶（2026-08-01 修复的语义，不得回退）。
  if (!args.hasRealProgress) return { inject: true, countedAsNoProgress: false };

  // 有真实进展但清单没动 → 催的只是记账。已催满则停手。
  if (args.bookkeepingNagCount >= cap) return { inject: false, countedAsNoProgress: false };
  return { inject: true, countedAsNoProgress: true };
}

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
