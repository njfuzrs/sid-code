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
  | { kind: "assistant_message"; message: Message }
  | { kind: "tool_start"; toolName: string; toolInput?: unknown }
  | { kind: "tool_end"; toolName: string; result?: { isError?: boolean; elapsedMs?: number } }
  | { kind: "stream_text"; text: string }
  | { kind: "compact"; }
  | { kind: "context_warning"; remaining: number }
  | { kind: "max_turns"; maxTurns: number }
  | { kind: "loop_detected"; detail: string }
  | { kind: "loop_recovery"; attempt: number; maxAttempts: number }
  | { kind: "tombstone"; message: Message; reason: string }
  | { kind: "system"; level: "info" | "warning" | "error"; text: string }
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
  /** 上一次 continue 的原因 */
  transition: ContinueReason | undefined;
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
   * 封顶（对话重播幻觉修复）：连续注入 todo/progress 催促而 todo 无进展
   * （writeVersion 未变化）的累计次数。达 MAX_NO_PROGRESS_NAGS 后本条用户消息
   * 剩余轮次停止注入催促——模型显然不会再改 todo，继续催只会造更多幻影。
   * writeVersion 变化（模型确实更新了清单=有进展）时清零。
   */
  noProgressNagCount?: number;
  /**
   * 缺口 C：上轮观察到的 permission mode。与本轮不同 → 视为切换，强注入一次 mode 指南。
   * undefined 表示尚未观察过。
   */
  lastSeenPermissionMode?: string;
  /**
   * 缺口 C：上次注入 permission mode reminder 的轮次（非 default mode 持续时低频重述节流）。
   */
  lastPermissionModeReminderTurn?: number;
  /**
   * F1：空参数 tool_use 退化的连续重试次数（DeepSeek 大上下文退化兜底）。
   * 工具成功执行或正常 end_turn 收尾后清零，确保只对"连续退化"计数。
   */
  emptyParamRetryCount?: number;
  /**
   * 环节③ 机制2：上一轮工具结果检出的、与 open 假设矛盾的命中（pending 注入）。
   * 检测发生在工具结果回流时，注入发生在下一轮循环开头的 reminder 通道——
   * 用此字段跨轮暂存。注入后清空。
   */
  pendingContradictions?: import("./hypothesis-ledger.ts").ContradictionHit[];
  /**
   * 环节③ 机制3：假设交付门禁已软续命的次数。模型试图收尾但仍有 open 假设时，
   * 注入门禁提醒并续命，最多 N 次，避免无限循环。
   */
  hypothesisGateRetryCount?: number;
  /**
   * G4：LSP 健康告警是否已向用户展示过（一次性，避免每轮刷屏）。
   * 首轮检查 getLSPHealthWarning()，有异常则 yield 一次 system 警告并置位。
   */
  lspHealthWarned?: boolean;
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
   * Trace 事件写入（Goal Gate、评估器等关键决策写入结构化事件到 events.jsonl）。
   * 可选——未注入则不写 trace 事件。
   */
  traceAppendEvent?: (event: { event: string; session_id: string; timestamp: string; data?: Record<string, unknown> }) => void;
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
