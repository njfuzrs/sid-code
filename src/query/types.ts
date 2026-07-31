/**
 * Query Loop 核心类型定义
 * 统一消息类型系统 + 循环状态 + 依赖注入接口
 */

import type {
  Message,
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "../llm/types.ts";

// ─── 扩展消息类型 ───

/** 压缩边界标记消息 */
export interface CompactBoundaryMessage {
  type: "compact_boundary";
  /** 压缩时间戳 */
  timestamp: number;
  /** 压缩前的消息数 */
  messageCountBefore: number;
  /** 压缩摘要 */
  summary?: string;
}

/** 墓碑消息：标记需撤回的消息（降级时使用） */
export interface TombstoneMessage {
  type: "tombstone";
  /** 被撤回的原始消息 */
  message: Message;
  /** 撤回原因 */
  reason: string;
}

/** 流式元数据消息 */
export interface StreamEventMessage {
  type: "stream_event";
  /** 事件子类型 */
  event: "stream_start" | "stream_end" | "fallback_start" | "fallback_end";
  /** 附加数据 */
  data?: Record<string, unknown>;
}

/** 系统通知消息 */
export interface SystemNotification {
  type: "system";
  level: "info" | "warning" | "error";
  text: string;
}

/** 进度消息 */
export interface ProgressNotification {
  type: "progress";
  toolName: string;
  status: "start" | "end";
  input?: unknown;
  result?: { isError?: boolean; elapsedMs?: number };
}

/** queryLoop yield 的消息类型 */
export type QueryLoopYield =
  // P1-G3：persistMeta 携带该次 API 调用的 usage/model/stopReason/msgId，仅用于会话落盘归因，
  // 不进 LLM 历史（不放 message._meta，避免污染后续请求体）。engine 持久化时透传给 store。
  | { kind: "assistant_message"; message: Message; persistMeta?: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }; model?: string; stopReason?: string; msgId?: string } }
  | { kind: "tool_start"; toolName: string; toolInput?: unknown }
  | { kind: "tool_end"; toolName: string; result?: { isError?: boolean; elapsedMs?: number } }
  | { kind: "stream_text"; text: string }
  // P1-3：压缩横幅**必须携带实据**，不能是与消息数组解耦的独立信号。
  // 事故背景（2026-07-29）：`yield { kind: "compact" }` 原本零字段，8 处调用点任一误发就画出
  // 「对话已压缩」横幅——而那次消息历史一条都没少。字段设为必填后，「没压动却画横幅」需要
  // 调用方编造两个数字才能做到，从"靠自觉"变成"靠类型强制"（对齐 CC 的 CompactionResult 思路）。
  // 不变式：**只有 messageCountAfter < messageCountBefore 时才允许 yield 这个事件。**
  | {
      kind: "compact";
      /** 压缩前消息数 */
      messageCountBefore: number;
      /** 压缩后消息数（必须 < before，否则不该 yield 本事件） */
      messageCountAfter: number;
      /** 节省的估算 token 数（可选，部分路径拿不到 token 口径） */
      savedTokens?: number;
    }
  | { kind: "context_warning"; remaining: number }
  | { kind: "max_turns"; maxTurns: number }
  | { kind: "loop_detected"; detail: string }
  | { kind: "loop_recovery"; attempt: number; maxAttempts: number }
  | { kind: "tombstone"; message: Message; reason: string }
  | {
      kind: "system";
      level: "info" | "warning" | "error";
      text: string;
      /**
       * 是否为"强制终止本轮"的系统消息（预算超限/配额耗尽/安全拒答等，紧跟 done 收尾）。
       * true 时即使 level 只是 warning，app.ts 也会推入统一错误面板常驻展示——
       * 否则这类"非正常结束"信息只在状态栏一闪而过，用户很容易错过（GAP-3）。
       * 未设置默认为 false（沿用原有 sticky/transient 状态栏行为，不影响既有分支）。
       */
      terminal?: boolean;
    }
  | { kind: "done"; turns: number };

// ─── 循环继续原因 ───

/** 循环继续的原因（可测试性：记录上一次为何 continue） */
export type ContinueReason =
  | { type: "tool_use" }
  | { type: "max_tokens_continuation" }
  | { type: "max_tokens_escalate" }
  | { type: "reactive_compact" }
  | { type: "loop_recovery" }
  | { type: "context_overflow_retry" }
  | { type: "stop_hook_retry" }
  | { type: "timeout_retry" }
  | { type: "todo_gate_retry" }
  | { type: "unanswered_retry" }
  | { type: "hypothesis_gate_retry" }
  | { type: "goal_gate_retry" }
  | { type: "goal_budget_warning" }
  | { type: "empty_param_retry" }
  | { type: "token_budget_continuation" };

// ─── 循环状态 ───

/** queryLoop 跨迭代状态 */
export interface LoopState {
  /** 当前轮次 */
  turnCount: number;
  /** 最大轮次 */
  maxTurns: number;
  /** max_output_tokens 恢复次数 */
  maxOutputTokensRecoveryCount: number;
  /** max_tokens 上限提升覆盖值（首次截断时提升到模型硬上限） */
  maxOutputTokensOverride?: number;
  /**
   * Top 3（2026-07-07 约束型误伤修复）：max_tokens 续写递减收益检测命中后，是否已经做过
   * 一次"优雅让手"（停止自动续写、注入让手提示、把决定权交还模型）。one-shot 标志：
   * 第一次命中不再硬 `return` 终止整轮，而是让手让模型自己决定继续/收尾；若让手后模型
   * 仍撞 max_tokens 且再次命中递减收益，则说明确实收敛不了，此时才终止，避免无限续写。
   */
  diminishingReturnsHandoffDone?: boolean;
  /** 是否已尝试过响应式压缩。
   *
   *  P0-2（对齐 CC 死亡螺旋防御）：这是一个 one-shot 标志位，只允许在触发响应式压缩的两处
   *  （src/query/loop.ts 连接阶段 + 流式阶段的 prompt-too-long 分支）设为 `true`。
   *  **绝不能在任何 continue 分支中把它重置回 `false`**——CC 曾有过前车之鉴：
   *  有人在 stop hook blocking 分支里重置了同类一次性标志位，导致同一个不可恢复的
   *  prompt-too-long 场景每轮都重新触发压缩重试，"烧掉数千次 API 调用"才被发现。
   *  新增类似的"只能尝试一次"的恢复机制时，遵循同一模式：只有成功路径才置真，
   *  任何软重试/continue 路径都不得清零。 */
  hasAttemptedReactiveCompact: boolean;
  /**
   * P2-2：**连续**压缩失败次数（会话累计），达 MAX_CONSECUTIVE_COMPACT_FAILURES 后熔断，
   * 不再尝试注定失败的压缩，并给用户一条「建议 /compact 或开新会话」的明确提示。
   *
   * 对标 CC 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。修完 P0-1 后
   * `reactiveCompact` 会开始如实返回 `false`（此前谎报成功），若没有熔断器就会出现
   * 「反复尝试同一个压不动的历史」——CC 踩过的坑是单会话 3,272 次。
   *
   * 与 `hasAttemptedReactiveCompact` 互补而非重复：那个是「prompt-too-long 本轮只反应式
   * 压缩一次」的防抖（粒度=本轮）；这个是跨轮累计的失败熔断（粒度=本会话）。
   * 任一次压缩成功即清零——熔断只针对"连续"失败。
   */
  consecutiveCompactFailures?: number;
  /** 上一次 continue 的原因 */
  transition: ContinueReason | undefined;
  /**
   * 上一轮成功拿到响应的时刻（epoch ms）。用于 cached-microcompact 的缓存冷热判定：
   * 距上次响应超过 prompt cache 的 5min ephemeral TTL 时，视为缓存已冷，改走 direct-clear
   * 真正释放本地 token（对标 CC time-based microcompact：缓存反正要重写，趁机清老工具结果）。
   * 0/undefined 表示尚无上一轮（首轮），此时视为缓存冷（无前缀可保）。
   */
  lastResponseAt?: number;
  /** Stop Hook 重试次数 */
  stopHookRetryCount?: number;
  /**
   * Fix 7：当前请求的连续超时重试次数。替代此前的 (state as any).timeoutRetryCount 旁路。
   * 在 timeout catch 分支递增；成功拿到 response（未抛出 timeout 异常）后重置为 0。
   * 注意：不能在 while 循环顶部重置——timeout continue 也会回到那里，会导致每次
   * 重试后立即被清零、永远达不到 maxTimeoutRetries。只在"成功"路径重置，才能同时
   * 保证当前请求的重试计数正确递增、且不会"一次超时永久丧失后续轮次的重试能力"。
   */
  timeoutRetryCount: number;
  /**
   * P0-2：上次回注 todo system-reminder 时的轮次（两次回注间隔节流用）。
   * 0/undefined 表示尚未回注过。
   */
  lastTodoReminderTurn?: number;
  /**
   * P0-2：上次回注时观察到的 todo writeVersion 快照。
   * writeVersion 变化说明模型更新过清单，回注计时随之刷新。
   */
  lastSeenTodoWriteVersion?: number;
  /** P0-3：end_turn 完成度硬校验已软续命的次数 */
  todoGateRetryCount?: number;
  /**
   * P0-3 误判自愈：todo gate 续命期间，模型每次都产出了实质内容（文本/工具调用）
   * 却始终不更新 writeVersion 的累计次数。
   *
   * 语义：区分门禁面对的两种外部观测相同、本质不同的情况——
   *   A) 真没做完：模型收到续命提醒后继续干活、产出实质内容并推进清单（writeVersion 变化，会清零本计数）。
   *   B) 忘标记：任务其实已交付（报告已输出等），模型每轮都在实质应答，却没翻最后的状态位。
   * 若续命耗尽时本计数 ≥ 阈值，判定极可能是 B，收尾时不抛"仍有 N 项未完成"的假警报，
   * 改为中性收尾（warn 日志保留供排查）。writeVersion 变化时清零（见 loop.ts gate 复位处）。
   */
  todoGateProductiveNoUpdateCount?: number;
  /**
   * 方案②（deepseek-reasoning-leak 修复）：「未答复的 end_turn」已软续命的次数。
   * stream-processor 置 response._unansweredEndTurn（思考漂移进正文 / 只思考不答复）时，
   * 不依赖 todo 也回注一次收敛提示并续命，兜住例③"重试无反应"的机制级根因。
   * 有效答复或工具执行后清零，只对"连续未答复"计数。
   */
  unansweredRetryCount?: number;
  /**
   * 方案③（deepseek-reasoning-leak 修复）：近几轮的思考字符数历史（用于检测"思考发散"）。
   * 思考量连续单调递增且末轮超阈值时，回注收敛提示（早期哨兵 + 真因⓪的回归指标）。
   * 只保留最近 THINKING_DIVERGENCE_WINDOW 轮，滚动淘汰最旧的。
   */
  thinkingLenHistory?: number[];
  /** 方案③：思考发散熔断已触发的次数（限次，避免每轮刷屏） */
  thinkingDivergenceInterventions?: number;
  /**
   * 方案③：检测到思考发散，待下一轮循环开头经 reminderParts 注入收敛提示（pending）。
   * 与 pendingContradictions 同机制——不在 assistant/tool_result 之间插消息（破坏配对），
   * 而是跨轮暂存、下一轮 model 调用前经 reminder 通道注入。注入后清空。
   */
  pendingThinkingDivergenceReminder?: boolean;
  /**
   * P2-1：近几轮的产出量历史（assistant 文本长度 + 工具调用数加权，见 output-stall.ts）。
   * 连续 OUTPUT_STALL_WINDOW 轮都低于阈值时，回注一次"是否卡住"的软提醒。
   * 只保留最近 OUTPUT_STALL_WINDOW 轮，滚动淘汰最旧的。
   */
  outputVolumeHistory?: number[];
  /** P2-1：产出停滞提醒已触发的次数（限次，避免每轮刷屏） */
  outputStallInterventions?: number;
  /**
   * P2-1：检测到产出停滞，待下一轮循环开头经 reminderParts 注入提醒（pending）。
   * 与 pendingThinkingDivergenceReminder 同机制——不在 assistant/tool_result 之间插消息
   * （破坏配对），而是跨轮暂存、下一轮 model 调用前经 reminder 通道注入。注入后清空。
   */
  pendingOutputStallReminder?: boolean;
  /** P2-2：上次回注工作日志摘要时的轮次（每 N 轮回注一次） */
  lastProgressReminderTurn?: number;
  /**
   * 去重（对话重播幻觉修复）：上次注入的 todo 回注 reminder 文本。
   * 本轮候选与之逐字节相同 → 期间无进展 → 跳过注入，避免造"幻影用户消息"。
   * 见 reminder-throttle.ts decideNagInjection。
   */
  lastInjectedTodoReminderText?: string;
  /**
   * 去重（对话重播幻觉修复）：上次注入的工作日志摘要 reminder 文本。
   * 语义同 lastInjectedTodoReminderText，针对 P2-2 progress 摘要通道。
   */
  lastInjectedProgressReminderText?: string;
  /**
   * 封顶（对话重播幻觉修复）：连续注入 **todo 回注**催促而 todo 无进展
   * （writeVersion 未变化）的累计次数。达 MAX_NO_PROGRESS_NAGS 后本条用户消息
   * 剩余轮次停止注入该催促——模型显然不会再改 todo，继续催只会造更多幻影。
   * writeVersion 变化（模型确实更新了清单=有进展）时清零。
   *
   * ★为什么与 progressNagCount 分成两个字段（负收益防线审计 发现 3，2026-07-30）：
   * 二者原先共用一个 `noProgressNagCount`，而 cap 只有 2——先到的一方会**静默吃掉
   * 另一方的全部额度**。极端情形已用真实 decideNagInjection 复现：todo 连注 2 次耗尽
   * cap 后，work-log 摘要**首次**尝试注入（lastInjectedText=undefined，绝无重复可能）
   * 就被抑制，它一次都没注过就已经没额度了（互相饿死，D 类反向失效）。
   * 而两者各自本就有独立的逐字节去重字段（lastInjectedTodoReminderText /
   * lastInjectedProgressReminderText），说明设计意图一直是彼此独立——共享封顶是实现疏漏。
   * 注意修法是**拆计数器、不是提高 cap**：cap=2 本身经实证是合理的，串台才是问题。
   */
  todoNagCount?: number;
  /**
   * 封顶：连续注入 **work-log 摘要**催促而 todo 无进展的累计次数。
   * 语义与预算均与 todoNagCount 完全对称、彼此独立（见该字段注释里的饿死复现）。
   */
  progressNagCount?: number;
  // 审计第 9 条：lastSeenContextPressureLevel 已上移到 SessionState（跨消息持久），
  // 不再挂在每消息重建的 LoopState 上。见 loop.ts 缺口 A 注入段。
  /** 上次注入上下文压力提醒的轮次（同档持续时按 CONTEXT_PRESSURE_REMINDER_INTERVAL 低频重述）。 */
  lastContextPressureReminderTurn?: number;
  // 审计第 9 条：lastSeenPermissionMode 已上移到 SessionState（跨消息持久），
  // 不再挂在每消息重建的 LoopState 上。见 loop.ts 缺口 C 注入段。
  /**
   * 缺口 C：上次注入 permission mode reminder 的轮次（非 default mode 持续时低频重述节流）。
   */
  lastPermissionModeReminderTurn?: number;
  /**
   * 去重：上次注入的 permission mode reminder 文本（负收益防线审计 发现 4，2026-07-30）。
   *
   * 为什么这条也需要逐字节去重（它原先刻意绕开了 decideNagInjection）：实测 481 轮里
   * 它注入 **34 次（7.1%，8 个会话）——是所有周期性提醒里最频繁的一条**，而把 34 条
   * 文案去重后**不同文案数 = 1**：145 字符 × 34 次 ≈ 4930 字符零新信息的重复注入。
   * 它与 context-pressure 的区别正在这里：pressure 文案嵌实时百分比、逐字节去重对它
   * 天然无效（故只能走 cadence），而 mode 文案在同一 mode 下**恒定不变**，去重 100% 适用。
   * 重复注入 user 通道提醒正是"对话重播/截断幻觉"的根因（见 context-pressure.ts:41-45）。
   *
   * 注意：mode 刚切换那一轮（changed=true）仍**强制注入**、绕过去重——那一次有真实的
   * 时机价值（模型必须立刻知道约束变了），且切换本身即是"有新信息"。
   */
  lastInjectedPermissionModeText?: string;
  /**
   * F1：空参数 tool_use 退化的连续重试次数（DeepSeek 大上下文退化兜底）。
   * 工具成功执行或正常 end_turn 收尾后清零，确保只对"连续退化"计数。
   */
  emptyParamRetryCount?: number;
  /**
   * 方向 2/4/6（git-status 快照冻结死循环止损阀）：连续相同只读探查命令
   * （git status/diff/log、ls/cat 等）+ 输出稳定不变的检测状态。跨轮累积，
   * 达阈值先注入携带**实时** git 状态的收敛提醒（压制冻结快照带偏认知），
   * 注满上限仍空转则强制收尾。见 repeated-readonly-guard.ts。
   */
  repeatedReadonly?: import("./repeated-readonly-guard.ts").RepeatedReadonlyState;
  /**
   * 方向 2/4/6：检测到"卡在只读命令上"，待下一轮循环开头经 reminderParts 注入的收敛提醒文本。
   * 与 pendingContradictions 同机制——检测发生在工具结果回流（本轮末尾），注入发生在下一轮
   * 循环开头的 reminder 通道（走 injectReminders，仅本轮注入、不落历史、缓存友好），
   * 而非在此直接 addMessage（那样会永久留在上下文里，长任务持续膨胀）。注入后清空。
   */
  pendingStuckReminder?: string;
  /**
   * 环节③ 机制2：上一轮工具结果检出的、与 open 假设矛盾的命中（pending 注入）。
   * 检测发生在工具结果回流时，注入发生在下一轮循环开头的 reminder 通道——
   * 用此字段跨轮暂存。注入后清空。
   */
  pendingContradictions?: import("./hypothesis-ledger.ts").ContradictionHit[];
  /**
   * 环节③ 机制3：假设交付门禁已软续命的次数。模型试图收尾但仍有未确认
   * （open 或 refuted）假设时，注入门禁提醒并续命，最多 N 次，避免无限循环。
   * 续命上限按"还有没有可推进动作"分档：有 open → 2 次；全 refuted（终态，
   * 无动作可做）→ 1 次。见 loop.ts 交付门禁段。
   */
  hypothesisGateRetryCount?: number;
  /**
   * 缺陷3：连续推翻 → 换策略提示的待注入条数（跨轮暂存）。
   *
   * 检测发生在假设裁决回流时（连推 N 条且零 confirm），注入发生在下一轮循环开头的
   * reminder 通道——与 pendingContradictions 同机制。注入后清空。
   */
  pendingHypothesisStrategyShift?: number;
  /**
   * 缺口2 层次2：假设登记表"空转"续期提醒的待注入文本（跨轮暂存）。
   *
   * 检测发生在工具结果回流时，注入发生在下一轮循环开头的 reminder 通道——
   * 与 pendingContradictions 同机制。注入后清空。「只给一次」的标志挂在 ledger
   * （会话级），故此字段随消息重建不会导致重复提醒。
   */
  pendingHypothesisStaleReminder?: string;
  /**
   * 缺口2 层次1：交付物复用检查的软续命次数（避免与门禁续命共用预算互相饿死）。
   *
   * 单独一个计数器而不是复用 hypothesisGateRetryCount：共用会让先触发的那道把预算
   * 吃光、另一道永久哑火——正是上一轮修复里 todo/work-log 共享计数器踩过的坑。
   */
  refutedReuseGateRetryCount?: number;
  /**
   * 缺口2 层次1：交付物复用检查是否已做过（一次性）。
   *
   * 必须一次性：交付物文本持续增长，不置位的话模型改完再收尾又会命中同一批标识符
   * （而它可能只是在如实标注"该假设已被证伪"，那正是门禁要求的正确做法），
   * 结果变成反复质疑模型写对的东西——纯负收益。
   */
  pendingRefutedReuseCleared?: boolean;
  /**
   * 缺口3：本条用户消息内是否已注入过"假设纪律引导"的事件驱动版本。
   *
   * 与 hypothesisGuideInjected 分开：后者记的是"turn-1 兜底引导是否注入过"，
   * 本字段记的是"事件驱动引导是否注入过"。合用一个会让兜底注入吃掉事件驱动的机会
   * （或反之），而两者的触发时机与文案强度不同，必须各自计数。
   */
  hypothesisEventGuideInjected?: boolean;
  /**
   * 缺口3：事件驱动引导的待注入标记（跨轮暂存）。
   *
   * 检测在 assistant 文本回流时（本轮中段），注入在下一轮循环开头的 reminder 通道
   * ——与 pendingContradictions 同机制。注入后清空。
   */
  pendingJudgmentGuide?: boolean;
  /**
   * G4：LSP 健康告警是否已向用户展示过（一次性，避免每轮刷屏）。
   * 首轮检查 getLSPHealthWarning()，有异常则 yield 一次 system 警告并置位。
   */
  lspHealthWarned?: boolean;
  /**
   * §12 P2-1：思考预算被 maxThinkingTokens 上限钳制的提示是否已展示过（一次性，避免每轮刷屏）。
   */
  thinkingBudgetCapNotified?: boolean;
  /**
   * /goal：上次注入 Goal reminder 的轮次（周期回注节流用）。
   * 0/undefined 表示尚未回注过。
   */
  lastGoalReminderTurn?: number;
  /**
   * /goal：compact 后强制下一轮注入 Goal reminder（防止目标意识断裂）。
   * 每次 compact 后设为 true，reminder 注入后消费（设回 false）。
   */
  goalReminderPendingAfterCompact?: boolean;
  /**
   * todo：compact 后强制下一轮注入 todo reminder（防止任务列表在压缩后丢失）。
   * 每次 compact 后设为 true，reminder 注入后消费（设回 false）。
   */
  todoReminderPendingAfterCompact?: boolean;
  /**
   * 延迟工具列表：compact 后强制重新**全量**播报一次 `<available-deferred-tools>`。
   *
   * 背景：延迟工具播报已 delta 化（每轮只发 added/removed，无变化不注入），依赖
   * sessionState 里的 announcedDeferredTools 集合判断"哪些已经告诉过模型"。压缩会
   * 把历史里的播报内容裁掉，但集合还在 → 模型上下文里再也看不到那批工具、delta 又
   * 认为"已播报过"，净效果是延迟工具对模型永久隐身。故 compact 后清空集合重播一次。
   *
   * 每次 compact 后设为 true，播报后消费（设回 false）。对标 CC 在 compact 路径
   * 对 deferred tools attachment 的同类处理。
   */
  deferredToolsPendingAfterCompact?: boolean;
  /**
   * 假设纪律首轮引导是否已注入（每条用户消息内仅一次）。
   * queryLoop 每条用户消息新建 state，此字段保证同一条消息多轮里不重复注入。
   */
  hypothesisGuideInjected?: boolean;
  /**
   * P0-3：本条用户消息解析出的 Token Budget 目标（如 "+500k" → 500000）。
   * undefined 表示本条消息未带预算指令，Budget Continuation Gate 直接跳过。
   * 在 queryLoop 顶部解析一次（state 创建后），随每条新用户消息的新 state 天然重置。
   */
  tokenBudgetTarget?: number;
  /**
   * P0-3：设置预算目标那一刻的累计 usage 基线（inputTokens+outputTokens+cacheCreation）。
   * 之后每次判定"还剩多少预算"都用当前累计值减去这个基线，而不是从 0 算——
   * sessionState.getTotalUsage() 是整个会话的累计口径，不是"这次任务"专属的。
   */
  tokenBudgetBaselineUsage?: number;
  /** P0-3：预算续写已触发的次数（供日志/可观测性使用，真正的停止条件是预算耗尽或递减检测） */
  tokenBudgetContinuationCount?: number;
  /**
   * 【第四层·兜底】SID_MAX_TURNS 软阈值提醒是否已注入（每条用户消息内仅一次）。
   * 默认关闭（未设 SID_MAX_TURNS 则永不置位）；达阈值注入一次软提醒后置真，避免每轮刷屏。
   * queryLoop 每条用户消息新建 state，随新消息天然重置。
   */
  softTurnLimitReminded?: boolean;
}

/** 创建初始循环状态 */
export function createInitialLoopState(maxTurns: number): LoopState {
  return {
    turnCount: 0,
    maxTurns,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    transition: undefined,
    timeoutRetryCount: 0,
    repeatedReadonly: { repeatCount: 0, reminderCount: 0 },
  };
}

// ─── 依赖注入 ───

/** queryLoop 的可 mock 依赖 */
export interface QueryDeps {
  /** 调用 LLM（含重试和回退） */
  sendWithRetry: (params: SendParams, signal?: AbortSignal) => AsyncIterable<StreamEvent>;
  /** 处理流式响应，累积内容块。onThinking 对标 Claude Code 的独立思考流通道 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
    onThinking?: (text: string) => void,
    /**
     * Fix 3（同类路径根治）：本轮 turn 级 AbortController。stream-processor 内部的
     * 心跳（60s）/ 整体（300s）超时触发时应 abort 这个 turn 级 controller，而非会话级
     * 共享 controller——否则正常完成/超时重试后会话 signal 被毒化，后续 turn 出生即死、
     * 整条用户消息被误报"已取消"（与 loop.ts 已修的 finally abort 同源）。可选：不传时
     * stream-processor 退化为旧行为（abort 会话级），保持向后兼容。
     */
    turnAbortController?: AbortController,
  ) => Promise<AccumulatedResponse>;
  /** 执行工具调用（含权限检查）。返回 results + 可选 followup（ADR-019） */
  executeTools: (content: ContentBlock[]) => Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }>;
  /** 自动压缩。返回压缩结果：summarized=摘要成功 / truncated=降级为有损截断 / skipped=未压缩。
   *  静默-9：loop 侧据此对 truncated 结果 yield warning 提示用户上下文有损。
   *  用宽松的 string 返回类型以避免 types.ts 反向依赖 auto-compact.ts（保持底层模块无依赖）。 */
  autoCompact: () => Promise<"summarized" | "truncated" | "skipped" | void>;
  /**
   * §2.2 Context Collapse：autoCompact 前置层（分段摘要老消息）。
   * 返回 true 表示已达目标可跳过 autoCompact。可选——不提供则 hard 级压缩直接走 autoCompact。
   */
  contextCollapse?: (currentUsageRatio: number) => Promise<boolean>;
  /** 处理上下文溢出，返回调整后的 maxTokens 或 null */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
  /**
   * 主动中断当前 LLM 请求（abort 当前 AbortController）。可选。
   * 用途：L1 单轮硬超时触发时，配合 Promise.race 让出控制权的同时，
   * 主动 abort 上游 fetch，尽量让已 hang 的底层流尽快释放（双保险）。
   * 注意：即使 abort 对已 hang 的 reader 无效，race 也已让 queryLoop 恢复——
   * 此回调是"尽力而为"的资源释放，不是兜底的唯一手段。
   */
  abortCurrentRequest?: (reason?: string) => void;
  /**
   * L1 单轮硬超时阈值（毫秒）。默认 10 分钟。
   * 仅用于覆盖（如单测传短值快速触发超时路径）。生产无需注入。
   */
  maxTurnDurationMs?: number;
  /** UUID 生成（可 mock） */
  uuid: () => string;
  /** 检查本轮是否发生了模型降级（用于 tombstone） */
  checkFallbackOccurred?: () => boolean;
  /** 重置降级标志 */
  resetFallbackFlag?: () => void;
  /** Plan Mode 系统提醒（对标 Claude Code 每轮 system-reminder 注入） */
  getPlanModeReminder?: () => Promise<string | null>;
  /**
   * 缺口 C：读取当前 permission mode（运行时可变）。queryLoop 每轮取最新值，
   * 切换或长任务低频重述时注入 mode 指南到消息流（system prompt 有缓存、不刷新）。可选。
   */
  getCurrentPermissionMode?: () => string | undefined;
  /**
   * Effort/Thinking 旋钮：读取当前运行时态（用户经 /effort、/think 切换）。
   * queryLoop 每轮取最新值，经 effort.ts 能力映射层翻译成各 provider 线格式（照搬
   * getCurrentPermissionMode 的「每轮取 getter」模式，保证运行时切换当轮生效）。可选——
   * 未注入则回退到 thinking hint 旧逻辑（向后兼容）。
   */
  getEffortSetting?: () => import("../llm/effort.ts").EffortSetting;
  getThinkingSetting?: () => import("../llm/effort.ts").ThinkingSetting;
  /**
   * P0-2 / P0-3：读取当前 todo 状态快照（用于回注 + 完成度校验）。
   * 返回 null 表示无 todo 工具或无 todo 项。可 mock。
   */
  getTodoState?: () => { todos: import("../tool/todo-write.ts").TodoItem[]; writeVersion: number } | null;
  /**
   * 环节③ 假设登记表(Hypothesis Ledger)接入。返回 harness 持有的登记表实例,
   * queryLoop 每轮工具结果回流后用它做"新证据 vs open 假设证伪条件"匹配(机制2 矛盾中断),
   * 并在收尾前做交付门禁(机制3)。返回 null 表示未启用(无登记表工具)。可 mock。
   */
  getHypothesisLedger?: () => import("./hypothesis-ledger.ts").HypothesisLedger | null;
  /**
   * B2：会话持久化写入端（方案 a）。queryLoop 在 ctxMgr.addMessage(toolResults) 的同时，
   * 通过它把 tool_result 直接写入 jsonl。可选——未注入则不持久化。
   */
  sessionStore?: import("../session/store.ts").SessionStore;
  /**
   * Step 0：Session Memory 提取触发（每轮收尾调用，fire-and-forget）。
   * 内部按双阈值（token 增长 + 工具调用次数/自然断点）决定是否真正提取。可选。
   */
  updateSessionMemory?: () => Promise<void>;
  /**
   * Step 0：记录一次工具调用（用于 Session Memory 双阈值计数）。可选。
   */
  recordSessionMemoryToolCall?: () => void;
  /**
   * 后台记忆提取触发（每轮 end_turn 收尾调用，fire-and-forget）。
   * 内部判断主代理本轮是否已写入记忆（互斥），未写则跑 forked agent 提取。可选。
   */
  extractMemories?: () => Promise<void>;
  /**
   * /goal：读取当前活跃目标状态。返回 null 表示无目标。
   * queryLoop 在 reminder 管道和 end_turn Gate 链中使用。可选——未注入则跳过所有 goal 逻辑。
   */
  getGoalState?: () => import("../goal/state.ts").GoalState | null;
  /**
   * /goal：更新目标状态（由 Goal Gate 在判定 complete/blocked/budget_limited 时调用）。
   * 可选。
   */
  updateGoalState?: (updater: (goal: import("../goal/state.ts").GoalState) => void) => void;
  /**
   * G2：获取 cachedMicrocompact 状态机（provider 感知的缓存友好压缩）。
   * queryLoop 每轮发送前调用 cachedMicrocompact(messages, {state, ...})，
   * 将产出的 pendingCacheEdits 注入 sendParams.cacheEdits。可选——未注入则跳过。
   */
  getCachedMicrocompactState?: () => import("./compact/cached-microcompact.ts").CachedMicrocompactState | undefined;
  /**
   * G2：当前 provider 名称（用于 cachedMicrocompact 路径判断）。可选。
   */
  getProviderName?: () => string;
  /**
   * MCP server instructions 增量拉取（对标 CC 的 mcp_instructions_delta 路径）。
   * 每轮循环调用一次：返回自上次以来"新连接且尚未播报过的" MCP server 使用说明文本块，
   * 由 loop 经 reminderParts 注入到 user 消息（cache-safe，不碰 system prompt 静态前缀）。
   * 内部维护 announcedServers 去重集，无新增时返回 null。可选——未注入则不注入 MCP 说明。
   */
  getMcpInstructionsDelta?: () => string[] | null;
  /**
   * G7：排空异步 hook 的 asyncRewake 通知（对标 CC 的 async hook rewake 路径）。
   * 每轮循环开始调用一次：返回已完成且 exit 2 的 asyncRewake hook 的 stderr 文本块，
   * 由 loop 经 reminderParts 注入 user 消息（作为 system-reminder 唤醒模型处理 hook 反馈）。
   * 内部维护 rewake 队列，无待处理通知时返回空数组。可选——未注入则不回灌 async hook 反馈。
   */
  drainAsyncHookRewakes?: () => string[];
  /**
   * 审计第 22 条：IDE 上下文（选区 / @提及）增量拉取，与 getMcpInstructionsDelta 同模式。
   * 每轮循环开始调用一次：返回本轮新增的 `<ide-selection>` / `<ide-mentions>` 文本块，
   * 由 loop 经 reminderParts 注入 user 消息。
   *
   * 为什么走消息通道而不是 system prompt：IDE 连接是后台异步的（启动瞬间必然未连上），
   * 且选区随用户操作变化——塞静态前缀既赶不上时序又每次击穿 prompt cache。
   * 内部对选区做指纹去重（同一份只注入一次），@提及为消费语义。无新增时返回 null。
   */
  drainIDEContextDelta?: () => string | null;
  /**
   * P1-2/P2-2/P3-2：Skill 运行时激活协调。每轮工具执行后调用 onSkillToolResults 喂入工具
   * 输入（条件激活 + 动态发现）；每轮开始调用 drainSkillListingDelta 取增量 skill 摘要
   * （首轮全量、后续只增量），由 loop 经 reminderParts 注入（cache-friendly）。
   * 可选——未注入则 skill 激活/增量 listing 不生效（向后兼容）。
   */
  onSkillToolResults?: (toolInputs: unknown[]) => Promise<void>;
  drainSkillListingDelta?: () => string | null;
  /**
   * Trace 事件写入（Goal Gate、评估器等关键决策写入结构化事件到 events.jsonl）。
   * 可选——未注入则不写 trace 事件。
   */
  traceAppendEvent?: (event: { event: string; session_id: string; timestamp: string; data?: Record<string, unknown> }) => void;
  /**
   * 上报重试状态到 TUI（app.ts 注入 → 写 TUIState.retryStatus，由 RetryStatus 组件渲染，
   * 带实时倒计时 + 限流建议）。超时重试用它替代此前 yield system 文本，与 fallback 引擎的
   * onRetry/onFallback 统一走同一个 RetryStatus 通道，避免消息流里出现重复的重试提示行。
   * 可选——未注入（如无头模式）则不上报，超时重试仍照常执行。
   */
  reportRetryStatus?: (info: {
    kind: "retry" | "rate_limit" | "overloaded" | "fallback";
    attempt: number;
    delayMs: number;
    model: string;
    error?: string;
  }) => void;
  /**
   * 优化 1：把 queryLoop 内层 catch 捕获的异常持久化到 errors.jsonl。
   * 此前 recordError 只在 engine.ts 最外层 catch 调用；loop.ts 里降级/重试（如超时重试
   * continue、上下文溢出响应式压缩 continue）与观测类 warn 吞掉的异常，engine 层看不到，
   * 排查时只见「重试后成功」而看不到最初为什么失败。用 phase 区分层级（connection/stream/
   * post_stream…），context.willRetry 标注是否会被重试，让间歇性故障可复盘。
   * 可选——未注入（如无头模式无 collector）则跳过，不影响主流程。
   */
  recordError?: (input: {
    phase: "connection" | "stream" | "post_stream" | "tool_execution" | "hook" | "engine";
    index: number;
    error: string;
    stack?: string;
    context?: Record<string, unknown>;
  }) => void;
}

// ─── QueryEngine 配置 ───

/** QueryEngine 提交消息的选项 */
export interface SubmitOptions {
  /** Extended Thinking 配置 */
  thinking?: { enabled: boolean; budgetTokens: number };
  /** 是否跳过 hook */
  skipHooks?: boolean;
}

/** QueryEngine 事件（yield 给外部消费者） */
export type QueryEngineEvent =
  | QueryLoopYield
  | { kind: "user_message_added" }
  | { kind: "hook_blocked"; reason: string }
  // §3.2（fdb47f30）：queryLoop 内部抛出的异常（如 processStream throw）原会穿透
  // engine.ts 的 for-await，跳过 done 收尾。现统一封装为此事件走 yield 通道，
  // 让 done 收尾可达、app 层把具体错误持久化展示（对标 §3.3）。
  // recoverable=false 表示本轮已无法继续（与用户 ESC 主动中断区分）。
  | { kind: "fatal_error"; message: string; stack?: string; recoverable: boolean };
