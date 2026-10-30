/**
 * queryLoop — 核心执行循环（async generator）
 *
 * 职责：
 * - 消息窗口构建（压缩/截断/预算）
 * - API 调用（流式）
 * - 工具调度和执行
 * - 错误恢复（prompt-too-long / max_tokens）
 * - 循环终止判定
 *
 * 通过 yield QueryLoopYield 与上层通信，天然支持背压控制
 */

import type { Config } from "../config/config.ts";
import type { Message, SendParams } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import type { HookSystem } from "../hook/system.ts";
import { fireStopFailure } from "./stop-failure.ts";
import type { QuotaManager } from "../llm/quota.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import type { BudgetTracker } from "../telemetry/metrics/budget-tracker.ts";
import {
  checkLoadedRemoteBudget,
  formatBudgetUsd,
  formatRemoteBudgetWarning,
} from "../telemetry/remote-budget.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { resolveToolSearchEnabled } from "../tool/tool-search-auto.ts";
import { snapshotMcpToolNames, withholdLateMcpTools } from "../tool/late-mcp-freeze.ts";
import { stripReadEfficiencyHint } from "../tool/read.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../tool/structured-output-tool.ts";
import { TOKEN_THRESHOLDS } from "../context/auto-compact.ts";
import { logContextAssembled } from "../analytics/events.ts";
import { ModelFallback } from "../llm/fallback.ts";
// F4 顺带（原为 require()）：两个 package 都是 "type": "module"，require 在 Bun 下
// 实测可用，但换到 Node ESM 会 ReferenceError。这里只作 getProviderForModel 未注入时的兜底。
import { AnthropicProvider } from "../llm/anthropic.ts";
import { OpenAIProvider } from "../llm/openai.ts";
import { isAwaitingHumanInput } from "./human-input-gate.ts";
import { trackRetryBackoff } from "./retry-backoff-window.ts";
import { setSseDumpContext } from "../llm/sse-chunk-dumper.ts";
import { takeLastRequestId } from "../api/request-id.ts";
import { resolveWireModel } from "../llm/wire-model.ts";
import { resolveLoopTimeouts, computeBackoffMs } from "../config/network-profile.ts";
import {
  emitTimeoutFired,
  emitTimeoutRetry,
  emitTimeoutRetryExhausted,
  armIneffectiveCheck,
  emitWatchdogKill,
  emitTimerDrift,
  TIMER_DRIFT_RATIO,
  getStreamSnapshot,
  clearStreamSnapshot,
  clearAllSnapshots,
  takeFirstContentTtft,
} from "../trace/stream-observer.ts";
import { runBackgroundTask } from "../agent/background-task-gate.ts";
import { getSleepLedger, describeSleep } from "@sid-code/shared/utils/sleep-detect.ts";
import { SessionState } from "../session/state.ts";
import { getLogger, getSessionMetrics, getPerfTimer } from "../debug/index.ts";
import { noteStopReasonMismatch } from "../agent/stop-reason-mismatch.ts";
import {
  LoopDetector,
  LOOP_RECOVERY_PROMPT,
  LOOP_RECOVERY_FINAL_PROMPT,
  // P1-3：同参状态轮询的专用恢复文案（搜索类建议对轮询场景一条都不适用）。
  LOOP_RECOVERY_POLLING_PROMPT,
} from "../agent/loop-detection.ts";
import type { LLMLoopCheckResult } from "../agent/loop-detection.ts";
import { buildPendingToolResults, finalizeMessagesForSend } from "../agent/message-invariants.ts";
import {
  isAbortError,
  isInternalTimeoutAbortReason,
  isSessionTimeoutAbortReason,
  RequestAbortedError,
} from "../llm/errors.ts";
import {
  resolveEffortCapability,
  resolveAppliedEffort,
  resolveThinking,
  resolveThinkingState,
  getEffortEnvOverride,
  getThinkingEnvOverride,
} from "../llm/effort.ts";
import {
  isPromptTooLongError,
  reactiveCompact,
  DiminishingReturnsDetector,
} from "./reactive-compact.ts";
import type { ReactiveCompactResult } from "./reactive-compact.ts";
import {
  parseTokenBudgetDirective,
  tokenBudgetConsumed,
  buildBudgetContinuationMessage,
  buildBudgetExhaustedNotice,
  buildBudgetDiminishingNotice,
} from "./token-budget-continuation.ts";
import {
  measureTurnOutputVolume,
  isOutputStalling,
  pushOutputVolume,
  buildOutputStallMessage,
  MAX_OUTPUT_STALL_INTERVENTIONS,
  OUTPUT_STALL_WINDOW,
  isOutputStallDetectionEnabled,
} from "./output-stall.ts";
import { runCompactPipeline, pipelineTargetRatioFrom } from "./compact/index.ts";
import {
  judgeCompaction,
  type CompactionJudgement,
  type CompactionOutcomeKind,
  type CompactionTrigger,
  type CompactNoopReason,
} from "./compact/outcome.ts";
import {
  MAX_EMPTY_PARAM_RETRIES,
  summarizeToolUseParams,
  buildEmptyParamRetryData,
  type EmptyParamHit,
  detectEmptyParamToolUses,
  replaceEmptyParamToolUses,
  buildEmptyParamRetryMessage,
} from "./empty-param.ts";
import { describeUnansweredRetry, describeUnansweredExhausted } from "./unanswered-end-turn.ts";
import {
  TODO_REMINDER_CONFIG,
  MAX_TODO_GATE_RETRIES,
  MAX_UNANSWERED_RETRIES,
  TODO_GATE_FORGOT_MARK_THRESHOLD,
  TODO_GATE_PRODUCTIVE_TEXT_MIN,
  buildTodoReminder,
  buildTodoGateMessage,
  buildTodoGateExhaustedMessage,
  buildTodoGateForgotMarkMessage,
  buildUnansweredEndTurnMessage,
  buildTodoBlockedHandoffMessage,
  countUnfinished,
  blockedTodos,
  blockedSignature,
  advanceTodoGateBudget,
  TODO_GATE_BUDGET_KEY,
  type TodoGateBudget,
} from "./todo-reminder.ts";
import {
  resolveStallSwitches,
  createStallState,
  observeStallTurn,
  buildStallSummaryPrompt,
  buildStallGateHandoffMessage,
  STALL_GATE_OSCILLATION_THRESHOLD,
  type StallTurnObservation,
} from "./stall-escalation.ts";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  TODO_REWORK_KEY,
  createTodoReworkState,
  recordTodoWrite,
  recordFileEditForRework,
  drainTodoReworkReminder,
  type TodoReworkState,
} from "./todo-rework.ts";
import {
  getTodoReminderTurnCounts,
  shouldInjectTodoReminder,
  LAST_TODO_REMINDER_TURN_KEY,
  LAST_TODO_WRITE_VERSION_KEY,
} from "./todo-reminder-scan.ts";
import {
  PROGRESS_REMINDER_INTERVAL,
  snapshotFromTodos,
  persistProgress,
  buildProgressReminder,
} from "./work-log.ts";
import {
  observeLowYieldTurn,
  buildLowYieldSpinReminder,
  createLowYieldSpinState,
  LOW_YIELD_SPIN_THRESHOLD,
  MAX_LOW_YIELD_INTERVENTIONS,
} from "./low-yield-spin.ts";
import {
  observeToolResult,
  createUnchangedObservationState,
  UNCHANGED_OBSERVATION_THRESHOLD,
} from "./unchanged-observation.ts";
import {
  type MeasuredProgressState,
  MEASURED_PROGRESS_KEY,
  FILE_MUTATING_TOOLS,
  createMeasuredProgressState,
  recordFileChange,
  recordScalarObservation,
  hasRealProgress,
} from "./measured-progress.ts";
import {
  dequeuePendingNotifications,
  evictTerminalTasks,
  hasPendingNotifications,
  hasRunningBackgroundTasks,
  markMainTurnCompleted,
  markNotificationsDelivered,
  isTerminalStatus,
} from "../task/index.ts";
import { buildInternalMessage, hasInternalOrigin } from "../context/internal-message.ts";
import {
  classifyEndTurnShape,
  decidePromiseNudge,
  initialS1Carry,
  isPromiseNudgeDisabled,
  MAX_PROMISE_NUDGES,
  reasoningShare,
  S1_PROMPT_CARRY_KEY,
  type S1PromptCarry,
  PROMISE_NUDGE_MESSAGE,
  PLAIN_TEXT_END_TURN_NOTICE,
  type EndTurnShape,
  type PromiseLang,
} from "./promise-nudge.ts";
import { drainByPriorityAndKind, hasPending, type QueuedCommand } from "./message-queue-manager.ts";
import {
  measureThinkingLen,
  isThinkingDiverging,
  pushThinkingLen,
  buildThinkingDivergenceMessage,
  MAX_THINKING_DIVERGENCE_INTERVENTIONS,
  isThinkingDivergenceDetectionEnabled,
} from "./thinking-divergence.ts";
import { injectReminders } from "./reminder-inject.ts";
import {
  decideNagInjection,
  decideTodoNagInjection,
  MAX_NO_PROGRESS_NAGS,
  MAX_TODO_BOOKKEEPING_NAGS,
  TODO_BOOKKEEPING_NAG_COUNT_KEY,
} from "./reminder-throttle.ts";
import {
  processObservation as observeRepeatedReadonly,
  isReadonlyProbeCommand,
  isReadFamilyTool,
  makeToolProbeCommand,
  buildStuckReminder,
  buildTerminateNotice,
  createRepeatedReadonlyState,
} from "./repeated-readonly-guard.ts";
import {
  parseSoftTurnLimit,
  shouldRemindSoftTurnLimit,
  buildSoftTurnLimitReminder,
} from "./soft-turn-limit.ts";
import {
  buildContextPressureReminder,
  contextPressureLevel,
  CONTEXT_PRESSURE_REMINDER_INTERVAL,
} from "./context-pressure.ts";
import {
  buildJudgmentGuideReminder,
  buildMinimalGuideReminder,
  detectInvestigateToEditTransition,
  detectInvestigationContext,
  detectUnregisteredJudgment,
  hasReadOnlyProbe,
} from "./hypothesis-guide.ts";
import { collectDiagnosticText, getLSPHealthWarning } from "../lsp/manager.ts";
import {
  buildPermissionModeReminder,
  isRuntimeModeSwitch,
  PERMISSION_MODE_REMINDER_INTERVAL,
} from "./permission-reminder.ts";
import {
  buildContradictionReminder,
  buildDeliveryGateReminder,
  buildRefutedReuseReminder,
  buildStaleLedgerReminder,
  buildStrategyShiftReminder,
  collectEvidenceTexts,
  CONSECUTIVE_REFUTATION_NAG_THRESHOLD,
  detectRefutedReuse,
  HYPOTHESIS_STALE_TURNS,
} from "./hypothesis-ledger.ts";
import {
  appendDeliverableText,
  getDeliverableText,
  resetDeliverableText,
} from "./deliverable-text.ts";
import { buildGoalReminder } from "../goal/reminder.ts";
import { collectEvidenceFromTurn } from "../goal/evidence-collector.ts";
import { handleGoalGate } from "./goal-gate.ts";
import { BlockedDetector } from "../goal/blocked-detector.ts";
import { DEFAULT_GOAL_CONFIG, resolveGoalEvaluatorModel } from "../goal/config.ts";
import {
  checkResponseForCacheBreak,
  recordPromptState,
  recordCacheBreak,
  formatCacheBreakReport,
  notifyCompaction,
} from "../api/cache-detection.ts";
import {
  MAX_PROMPT_CACHE_TTL_MS,
  isPrefixCacheProvablyCold,
  msSincePrefixTouch,
} from "../api/cache-warmth.ts";
import { getEffectiveBetaHeaders } from "../api/beta-header-latch.ts";
import type { QueryLoopYield, QueryDeps, LoopState } from "./types.ts";
import { createInitialLoopState } from "./types.ts";
import { setTransition } from "./transition.ts";
import { classifyStopReason } from "./stop-reason-policy.ts";
import { settleOrphanToolUses } from "./terminal-finalize.ts";
import { emitGateExhausted, type ExhaustibleGate } from "./gate-exhaustion.ts";
import { MAX_STOP_HOOK_RETRIES } from "./stop-hooks.ts";
import {
  beginTurn,
  emitTurnComplete,
  normalizeTurnStopReason,
  type TurnStopReason,
} from "./turn-complete.ts";
import { resolveRegistryMaxOutputTokens } from "../llm/model-lookup.ts";
import { recordContextOverflow } from "../llm/learned-window.ts";

/**
 * 计算本轮请求真实携带的 beta headers（供 cache-break 检测器归因）。
 *
 * 此前两处快照点（请求前 / 响应后）均硬编码 `betaHeaders: []`，导致 cache-detection
 * 里的"Beta headers 变化"归因分支在主循环路径永远不触发（静默失效的检测维度）。
 * 真实的 beta header 由 provider（anthropic.ts）经 sticky latch（G7）注册，
 * 这里以纯读方式（传空数组不注册新项）取回同一份 sticky 集合，与实际发送保持一致。
 *
 * 仅 anthropic 直连族有 anthropic-beta header 概念；其它 provider 恒空（与实际请求一致）。
 * 注：latch 是全局单例，读的是"截至此刻已 sticky 的集合"。请求前快照时 provider 可能
 * 尚未注册本轮新增 header，但 sticky-on 语义下 header 只增不减——一旦某 header 首次出现
 * 就会被下一轮请求前快照捕获，配对检测因此能正确归因到"新增 beta header 那一轮"。
 */
function currentBetaHeaders(providerName: string): string[] {
  if (providerName !== "anthropic") return [];
  try {
    return getEffectiveBetaHeaders([]);
  } catch {
    return [];
  }
}

/**
 * 判断是否为超时类错误（用于 timeout 重试逻辑）。
 *
 * 三条判据（任一命中即为超时，按可靠性从高到低）：
 *
 * 1. **结构性 reason（最可靠，2026-07 根治）**：turn 级 AbortController 被 abort 时
 *    锁定的 reason 属于 INTERNAL_TIMEOUT_ABORT_REASONS（单轮硬超时 / 看门狗 /
 *    流式心跳-整体超时）。reason 在首次 abort() 时被 AbortSignal 永久锁定，
 *    天然免疫"更具体的 timeoutError 被更通用的 abort-race 错误在 Promise.race
 *    中抢先覆盖"这一整类问题。同时兜住 err 自身携带的 abortReason
 *    （RequestAbortedError.abortReason），即便调用方没传 turnSignal 也能识别。
 *
 * 2. **错误消息文本（回退）**：/timeout|超时|timed out/i。保留以兼容那些不经由
 *    turn signal、直接以文本抛出的超时（如底层 SDK 的原生超时错误）。
 *
 * @param turnSignal 本轮 turn 级 AbortController 的 signal（可选）。传入后可读其
 *   已锁定的 reason 做结构性判定，不依赖易被覆盖的错误消息文本。
 */
function isTimeoutError(err: unknown, turnSignal?: AbortSignal | null): boolean {
  // 判据 1a：turn signal 已 abort 且 reason 属于内部超时白名单
  if (turnSignal?.aborted && isInternalTimeoutAbortReason(turnSignal.reason)) {
    return true;
  }
  // 判据 1b：错误自身携带的 abortReason（stream-processor 的 abort-race 错误会挂载）
  if (err instanceof RequestAbortedError && isInternalTimeoutAbortReason(err.abortReason)) {
    return true;
  }
  // 判据 2：错误消息文本回退
  if (err instanceof Error && /timeout|超时|timed out/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * 可被 abort 提前唤醒的 sleep（用于重试退避）。
 *
 * 根因（轨迹 20260730-142920-d98e7f16）：超时重试的退避此前是裸
 * `await new Promise(r => setTimeout(r, backoffMs))`——睡满才醒，期间会话被
 * abort 也感知不到。实测 07:37:49.077 触发 session-timeout abort，退避仍睡到
 * 07:37:53.491 才醒并发出新请求，于是 UI 先弹「已自动结束本轮」、紧接着又弹
 * 「⟳ 正在重试」。退避基数默认 5s、上限 120s（network-profile DEFAULTS），
 * 封顶时最坏要拖 2 分钟才能响应中断。
 *
 * 语义：正常睡满 → resolve；睡眠期间 signal abort → 立即 resolve（**不 reject**）。
 * 由调用方在 await 之后复检 `signal.aborted` 决定怎么收尾——这样这个工具既能给
 * 退避用，也不会把「中断」变成一个需要 catch 的异常路径。
 * 传入时已 aborted 则同步返回，不白等一轮。
 * 无论走哪条路径都清理 timer 与 listener（避免 timer 吊住事件循环、listener 泄漏）。
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * P2-2：连续压缩失败的熔断阈值（对标 CC 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）。
 * 达到该次数后停止自动压缩尝试，改为如实提示用户手动 /compact 或开新会话。
 */
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;
/**
 * 撞 `model_context_window_exceeded` 后「压缩 → 续写」的每条用户消息上限（2026-10-24）。
 *
 * 与子代理 `MAX_CTX_WINDOW_RECOVERY = 2`（agent/agentic-loop.ts）同值同取向：
 * 压不动立即收尾（再来一轮必撞同一上限）；压得动也只给有限次，防「压一点、又撞上限」的慢速空转。
 * 主循环此前**没有任何封顶**：失败只给 consecutiveCompactFailures +1 却从不检查熔断，
 * 交互模式 maxTurns=Infinity 下会一直空烧到用户 ESC。
 */
export const MAX_CTX_WINDOW_RECOVERIES = 2;

/**
 * 「压缩救不了」的判据：常驻开销（系统提示词 + 工具定义）占**本次请求估算总量**的比例。
 *
 * 为什么不按「占窗口比例 ≥ 某值」判：走到熔断时 API 已经实锤超窗，要回答的只是
 * 「超出来的那部分是不是历史」。按窗口比例判是在跟启发式估算误差赌阈值——事故现场
 * 常驻 ~89 万 / 窗口 ~98 万，恰好 91%，0.9 的阈值差一点就判错，且换个窗口就漂。
 * 按「常驻占总量」判：总量里八成以上是常驻，压缩掉全部历史也腾不出超窗那截。
 */
const FIXED_OVERHEAD_DOMINANT_RATIO = 0.8;

/**
 * 「本轮输入自己就超窗」的判据：最新一条用户输入占**本次请求估算总量**的比例。
 *
 * 取 0.5 而不是常驻那条的 0.8：输入之外还有常驻开销与历史，过半就意味着把全部历史
 * 压成零，剩下的「常驻 + 本轮输入」仍占超窗请求的一半以上——而走到熔断时历史已连压
 * 三轮都压不动。事故现场是 4500 万 / 4500 万，远离阈值；阈值只防「长历史 + 中等输入」
 * 被误判成输入问题。
 */
const USER_INPUT_DOMINANT_RATIO = 0.5;
/**
 * 第三态还要求输入**自己**至少占窗口这个比例。只看「占总量」会在短会话里误判：
 * 历史只有一两条时最新输入天然占总量大半，几百 token 的输入被说成「本身超窗」
 * （`false-compaction-banner.test.ts` §八 #14 实测）。取 0.5：输入不到半个窗口时，
 * 超窗的主因不可能是它。
 */
const USER_INPUT_MIN_WINDOW_RATIO = 0.5;

/**
 * 压缩失败熔断时给用户的文案。
 *
 * 两种成因的下一步动作完全不同，必须分开说：
 * - 常驻开销自己就超窗（典型：CLAUDE.md / 规则文件过大、MCP 工具过多）——压缩只动
 *   消息历史，`/compact` 与开新会话都**必然再失败**，只能减常驻内容；
 * - 历史压不动——`/compact` 或开新会话才有用。
 * 此前一律报后者，实测一句「你好」就熔断的会话被引去执行注定无效的 /compact。
 */
export function buildCompactCircuitBreakerText(
  failures: number,
  probe: {
    fixedTokens: number;
    totalTokens: number;
    memoryTokens: number;
    maxTokens: number;
    /** 最新一条用户输入的估算 token（缺省 0 = 不判第三态） */
    latestUserInputTokens?: number;
  },
): string {
  const { fixedTokens, totalTokens, memoryTokens, maxTokens } = probe;
  const latestUserInputTokens = probe.latestUserInputTokens ?? 0;
  if (
    maxTokens > 0 &&
    totalTokens > 0 &&
    fixedTokens >= totalTokens * FIXED_OVERHEAD_DOMINANT_RATIO
  ) {
    const pct = Math.round((fixedTokens / maxTokens) * 100);
    const k = (n: number) => `${Math.round(n / 1000)}K`;
    const memoryHint =
      memoryTokens > fixedTokens * 0.5
        ? `其中 CLAUDE.md / 规则文件约 ${k(memoryTokens)} tokens，是主要来源——用 /context 查看明细，精简或拆分规则文件。`
        : `用 /context 查看是哪一类常驻内容（工具定义 / MCP 工具 / 系统提示词）占满了窗口。`;
    return (
      `上下文已超出模型窗口：系统提示词与工具定义本身就占了约 ${k(fixedTokens)} tokens` +
      `（窗口 ${k(maxTokens)}，${pct}%），对话历史为空也发不出去，压缩无法解决，已停止重试。` +
      memoryHint
    );
  }
  // 第三态：本轮输入自己就超窗（2026-10-22 事故：@ 误命中 78MB 二进制，单条 user 消息
  // 估算 4500 万 token）。压缩层只按消息删 / 摘要，不删本轮输入也不缩短它，
  // /compact 必然再失败。下一步是缩小这条输入——app 层据专用码把输入退回输入框。
  if (
    maxTokens > 0 &&
    totalTokens > 0 &&
    latestUserInputTokens >= totalTokens * USER_INPUT_DOMINANT_RATIO &&
    latestUserInputTokens >= maxTokens * USER_INPUT_MIN_WINDOW_RATIO
  ) {
    const k = (n: number) => `${Math.round(n / 1000)}K`;
    return (
      `本轮输入本身约 ${k(latestUserInputTokens)} tokens，超出模型窗口（${k(maxTokens)}），` +
      `压缩无法缩短本轮输入，已停止重试。请缩小引用的文件 / 粘贴内容，或拆成多轮发送。`
    );
  }
  return (
    `上下文已超出模型窗口，且连续 ${failures} 次自动压缩都未能减少历史，` +
    `已停止重试以免空烧 API 调用。建议手动执行 /compact 精简上下文，或开一个新会话继续。`
  );
}

/** settleCompaction 产出的横幅（= 要 yield 的那条 compact 事件） */
type CompactBanner = {
  kind: "compact";
  messageCountBefore: number;
  messageCountAfter: number;
  savedTokens?: number;
};

interface SettleCompactionResult {
  /** 仅 outcome === "applied" 时非 null */
  banner: CompactBanner | null;
  outcome: CompactionOutcomeKind;
  judgedBy: CompactionJudgement["judgedBy"];
  noopReason?: CompactNoopReason;
  /** 本次调用是否**新开启**了 loop 层熔断 */
  circuitOpened: boolean;
}

/**
 * P1-3 + P2-1：把一次压缩尝试收敛成「唯一的结局判定 + 唯一的计数/熔断写入点 + 唯一的埋点出口」。
 *
 * 事故背景（2026-07-29 假压缩误报）：`yield { kind: "compact" }` 是与消息数组**完全解耦**的
 * 独立 UI 信号，8 处调用点任一误发就画出「对话已压缩」横幅。那次消息历史一条都没少，横幅
 * 却照画，还顺带给模型注入了「系统已为你精简对话上下文」——模型随后 30 条回复自我否定。
 *
 * 本函数做三件事：
 * ①结局判定（judgeCompaction）：`after < before` 或 `savedTokens > 0` 为 `applied`（实测证据优先）；
 *   否则主动压缩类 trigger 带 `noopReason` 为 `noop`，其余为 `failed`。只有 applied 才给横幅。
 * ②维护失败计数与 loop 层熔断（唯一写入点，2026-10-29）：applied 清零、failed +1、noop 不动；
 *   计数达阈值时置 `state.compactCircuitOpen` 并落 CompactionCircuitBreaker。此前计数只手写在
 *   流内 4 条恢复路径上，阈值三档 0 处计数；收进这里后新增 trigger 也自动覆盖。
 * ③往 events.jsonl 落 CompactionAttempt（成败都落），放在②之后，带的计数是判定后的值。
 *
 * generator 的 yield 不能跨函数边界，所以这里只造事件不 yield。
 */
function settleCompaction(
  deps: QueryDeps,
  sessionId: string,
  scope: { state: LoopState; promptSeq: number },
  info: {
    /** 触发来源，用于区分「阈值压缩」与「错误恢复」两类性质完全不同的压缩 */
    trigger: CompactionTrigger;
    messageCountBefore: number;
    messageCountAfter: number;
    tokensBefore?: number;
    tokensAfter?: number;
    /** 生效策略（reactiveCompact 会给出 snip/emergency/none） */
    strategy?: string;
    /** 本次尝试中**最后执行的那个动作**报告的「没事可做」原因（是否采信由 trigger 决定） */
    noopReason?: CompactNoopReason;
  },
): SettleCompactionResult {
  const { state, promptSeq } = scope;
  const savedTokens =
    info.tokensBefore !== undefined && info.tokensAfter !== undefined
      ? info.tokensBefore - info.tokensAfter
      : undefined;
  // 发现 3a/3c：调用方负责让 before/after 同源（都用不套锚点的 estimateTokensFor，
  // 且都不含本次新插的边界消息）。只看消息数会漏掉原地替换（toolResultBudget /
  // microcompact）：实测 input 865K → 250K 却报失败。
  const judgement = judgeCompaction({
    trigger: info.trigger,
    messageCountBefore: info.messageCountBefore,
    messageCountAfter: info.messageCountAfter,
    savedTokens,
    noopReason: info.noopReason,
  });
  const { outcome } = judgement;

  // ② 按 outcome 维护计数。noop 不改变计数——「无事可做不该熔断」的唯一实现处。
  if (outcome === "applied") state.consecutiveCompactFailures = 0;
  else if (outcome === "failed")
    state.consecutiveCompactFailures = (state.consecutiveCompactFailures ?? 0) + 1;
  const failures = state.consecutiveCompactFailures ?? 0;
  // 开闸后 latch：applied 只清零计数、不关闸，避免开关抖动。
  const circuitOpened = failures >= MAX_CONSECUTIVE_COMPACT_FAILURES && !state.compactCircuitOpen;
  if (circuitOpened) state.compactCircuitOpen = true;

  if (deps.traceAppendEvent) {
    try {
      deps.traceAppendEvent({
        event: "CompactionAttempt",
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        data: {
          trigger: info.trigger,
          // 兼容字段：恒等于 outcome === "applied"
          success: outcome === "applied",
          outcome,
          judged_by: judgement.judgedBy,
          ...(judgement.noopReason ? { noop_reason: judgement.noopReason } : {}),
          prompt_seq: promptSeq,
          turn: state.turnCount,
          // 判定**之后**的值：离线验收逐条比对，不让脚本拿被测规则自己重算
          consecutive_failures: failures,
          circuit_open: state.compactCircuitOpen === true,
          messageCountBefore: info.messageCountBefore,
          messageCountAfter: info.messageCountAfter,
          ...(savedTokens !== undefined ? { savedTokens } : {}),
          ...(info.strategy ? { strategy: info.strategy } : {}),
        },
      });
      if (circuitOpened) {
        deps.traceAppendEvent({
          event: "CompactionCircuitBreaker",
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          data: {
            prompt_seq: promptSeq,
            turn: state.turnCount,
            failure_count: failures,
            last_trigger: info.trigger,
          },
        });
      }
    } catch {
      /* 埋点失败绝不阻断主循环 */
    }
  }
  if (circuitOpened) {
    getLogger().error(
      "QUERY_LOOP",
      `连续 ${failures} 次压缩失败（最后一次 trigger=${info.trigger}），loop 层压缩熔断开启`,
    );
  }

  if (outcome !== "applied") {
    getLogger().warn(
      "QUERY_LOOP",
      `压缩未生效（trigger=${info.trigger}，outcome=${outcome}` +
        (judgement.noopReason ? `/${judgement.noopReason}` : "") +
        `）：消息数 ${info.messageCountBefore} → ${info.messageCountAfter}` +
        (savedTokens !== undefined
          ? `，估算 token ${info.tokensBefore} → ${info.tokensAfter}`
          : "") +
        `，不画压缩横幅`,
    );
    return {
      banner: null,
      outcome,
      judgedBy: judgement.judgedBy,
      ...(judgement.noopReason ? { noopReason: judgement.noopReason } : {}),
      circuitOpened,
    };
  }

  // 压缩真的发生了 → 前缀必然改变、cache 必然脱落，这是预期而非异常。
  // P1-4：抑制紧接的一次 cache break 误报，避免把压缩导致的脱落误归因成「服务端波动」
  // （那会污染项目北极星「更省」赖以度量的 cache 归因数据）。
  notifyCompaction("main");

  return {
    banner: {
      kind: "compact",
      messageCountBefore: info.messageCountBefore,
      messageCountAfter: info.messageCountAfter,
      ...(savedTokens !== undefined ? { savedTokens } : {}),
    },
    outcome,
    judgedBy: judgement.judgedBy,
    circuitOpened,
  };
}

/**
 * loop 层熔断开着时，跳过一个花钱的压缩动作并落一条 CompactionSkipped（每次跳过都发：
 * 「熔断挡掉了多少次 LLM 调用」正是熔断省下的成本，只发一次就丢了这个口径）。
 */
function recordCompactionSkipped(
  deps: QueryDeps,
  sessionId: string,
  scope: { state: LoopState; promptSeq: number },
  skipped: "context_collapse" | "auto_compact",
  trigger: "threshold_hard" | "context_overflow",
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "CompactionSkipped",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data: {
        prompt_seq: scope.promptSeq,
        turn: scope.state.turnCount,
        reason: "circuit_open",
        skipped,
        trigger,
      },
    });
  } catch {
    /* 埋点失败绝不阻断主循环 */
  }
}

/**
 * 把一次"无进展催促"注入落成结构化 trace 事件（events.jsonl）。
 *
 * 为什么需要它（负收益防线审计 发现 3，2026-07-30）：todo / work-log 两条催促通道原先
 * 只有 `log.info`，而 log.info **不落盘**——`~/.sid-code/` 下搜不到任何"无进展催促"字样。
 * 后果是这两条通道的封顶行为在现网**完全不可观测**：审计要核"共享计数器是否真饿死了某条
 * 通道"，只能靠离线重放 decideNagInjection 模拟，拿不到真实注入证据。
 * 落成事件后，`kind` 字段把两条通道分开计数，trace-digest 可直接统计各自的注入次数与
 * 封顶命中——发现 3 修完到底有没有生效，下一轮审计能用真实数据回答而不是再模拟一遍。
 *
 * 与 HypothesisGuideInjected / GoalGateDecision 同机制：deps 未提供 sink 时静默跳过，
 * 写入异常一律吞掉——可观测性埋点绝不能反过来阻断主循环。
 */
/**
 * 缺口7：统一的"轮次口径"三件套，供所有按轮落 trace 的事件复用。
 *
 * 为什么必须三个字段一起给，而不是把 `turn` 直接改成累计值：
 *   - `turn`（消息内，`LoopState.turnCount`）保留兼容——已落盘的 events.jsonl 里
 *     全部是这个口径，直接改语义会让历史数据与新数据同名不同义，比口径分裂更糟；
 *   - `absoluteTurn`（会话累计）才是"会话进行到第几轮"，跨消息可比较、可相减；
 *   - `promptSeq`（第几条用户消息）让 `turn` 的回绕可还原——实测 `135709-1a73c7a1`
 *     会话出现 `turn=20` 之后又是 `turn=3`，没有 promptSeq 就无法与"真的退回第 3 轮"区分。
 *
 * 这是缺口 1/2/4 效果验证的地基：先改行为再补埋点，等于拿有系统误差的尺子量自己的
 * 改动效果（设计文档 §2.3 初稿把 44 轮写成 52 轮就是这么来的）。
 */
function turnMetrics(
  state: LoopState,
  sessionState: SessionState,
  promptSeq: number,
): { turn: number; absoluteTurn: number; promptSeq: number } {
  return {
    turn: state.turnCount,
    absoluteTurn: sessionState.getAbsoluteTurn(),
    promptSeq,
  };
}

/**
 * 取本会话的"实测进展"状态（P1-4 item 1），不存在则创建并挂上 SessionState。
 *
 * 为什么挂 SessionState 而不是 LoopState：LoopState 每条用户消息重建，而"这个会话已经改过
 * 哪些文件、某个观测值从多少变到多少"是**跨用户消息的会话级事实**。放 LoopState 会让用户
 * 追问一句就把已有进展清零，work-log 立刻退回报"已完成 0 项"——本次要修的假信号会复活。
 * 同构参照 LAST_TODO_WRITE_VERSION_KEY（那处注释记录了同一个坑：基线放 LoopState 导致
 * 第二条用户消息后计数虚增）。
 */
function getMeasuredProgress(sessionState: SessionState): MeasuredProgressState {
  let s = sessionState.get(MEASURED_PROGRESS_KEY) as MeasuredProgressState | undefined;
  if (!s) {
    s = createMeasuredProgressState();
    sessionState.set(MEASURED_PROGRESS_KEY, s);
  }
  return s;
}

/** 取本会话的「标完成后又返工」检测状态（会话级，理由同 getMeasuredProgress）。 */
function getTodoReworkState(sessionState: SessionState): TodoReworkState {
  let s = sessionState.get(TODO_REWORK_KEY) as TodoReworkState | undefined;
  if (!s) {
    s = createTodoReworkState();
    sessionState.set(TODO_REWORK_KEY, s);
  }
  return s;
}

/**
 * 推进 end_turn 兜底的会话级续命预算（按 completed **创新高** / 总项数复位），并返回本次是否算推进。
 * 只改措辞的 todo_write、新的一条用户消息、completed 下降后回升，都不再让预算回满——
 * 见 TODO_GATE_BUDGET_KEY 与 advanceTodoGateBudget 注释。
 */
function advanceSessionTodoGateBudget(
  sessionState: SessionState,
  todos: import("../tool/todo-write.ts").TodoItem[],
): { budget: TodoGateBudget; progressed: boolean } {
  const prev = sessionState.get(TODO_GATE_BUDGET_KEY) as TodoGateBudget | undefined;
  const r = advanceTodoGateBudget(prev, todos);
  if (r.budget !== prev) sessionState.set(TODO_GATE_BUDGET_KEY, r.budget);
  return r;
}

function getTodoGateBudget(
  sessionState: SessionState,
  todos: import("../tool/todo-write.ts").TodoItem[],
): TodoGateBudget {
  return advanceSessionTodoGateBudget(sessionState, todos).budget;
}

function emitNagInjectedEvent(
  deps: QueryDeps,
  sessionId: string,
  data: {
    /** 催促通道，用于把两条独立通道分开统计（原共享计数器的受害方就靠它区分）。 */
    kind: "todo" | "work-log";
    turn: number;
    /** 缺口7：会话累计轮次（不随用户消息重置），跨消息可比较。 */
    absoluteTurn?: number;
    /** 缺口7：第几条用户消息，让 turn 的回绕可还原。 */
    promptSeq?: number;
    // ─── work-log 通道字段（仍走去重+封顶，见 reminder-throttle.ts）───
    nagCount?: number;
    cap?: number;
    countedAsNoProgress?: boolean;
    afterCompact?: boolean;
    // ─── todo 通道字段 ───
    // 记两个扫描出来的"距今多少轮"，供事后核对阈值是否过紧/过松。
    // `Infinity` 不是合法 JSON，故由调用方归一化为 -1（= 从未发生过）。
    //
    // 2026-08-01 改无状态扫描时 nagCount/cap 概念一度不存在；P1-4 item 2 又把它们带回来了，
    // 但语义**与 work-log 不同**：这里的 cap 是**条件式**的，只在"有真实副作用进展却不更新
    // 清单"时计数（催记账），无进展时永不封顶（催干活=主功能，见 decideTodoNagInjection）。
    // 两条通道复用同名字段但判据不同，分析 events.jsonl 时必须结合 kind 区分。
    turnsSinceLastTodoWrite?: number;
    turnsSinceLastReminder?: number;
  },
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "NoProgressNagInjected",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}

/**
 * 冷缓存清理落成结构化事件（`ColdCacheClear`）。
 *
 * 旧实现只打 log.debug，轨迹里完全看不到「清了没、清了多少、当时隔了多久」——
 * 「热当冷」这个缺陷只能靠回放 raw.jsonl 反推。有了它，`gap_ms` 的分布直接证明
 * 修复是否生效：修复后所有事件的 gap_ms 都 ≥ MAX_PROMPT_CACHE_TTL_MS（1h）。
 * cleared=0 也落：说明判冷了但没东西可清，分母要包含它。
 */
function emitColdCacheClearEvent(
  deps: QueryDeps,
  sessionId: string,
  data: { gap_ms: number; cleared: number; saved_chars: number },
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "ColdCacheClear",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data: { ...data, threshold_ms: MAX_PROMPT_CACHE_TTL_MS },
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}

/**
 * 把一次 todo 清单推进（`writeVersion` 增长）落成结构化 trace 事件。
 *
 * 为什么必须补这个埋点（方案 §8.3）：`writeVersion` 的增长节奏是**唯一能直接量"todo 实时性"
 * 的指标**——"清单更新了几次、分布在哪些轮次"就是本缺陷的定义本身。而此前它完全无埋点，
 * 定性只能靠间接证据：本次排查是靠 `~/.sid-code/progress/<id>.md` 只被写过一次反推
 * "整场会话 todo_write 只成功调用过 1 次"，而那个文件本身还有"全完成时不落盘"的缺口
 * （见修复 5），两个不确定性叠在一起，差点把结论建在流沙上。
 *
 * 有了这条事件，改动效果可被 trace-digest 直接统计：每会话 todo 推进次数、
 * 相邻两次推进间隔多少轮。这是判断"是否真的在朝北极星走"的尺子，不是可选装饰。
 */
function emitTodoProgressEvent(
  deps: QueryDeps,
  sessionId: string,
  data: {
    turn: number;
    absoluteTurn?: number;
    promptSeq?: number;
    /** 单调递增的成功写入次数（= 模型碰过清单几次）。 */
    writeVersion: number;
    total: number;
    completed: number;
    /** 模型可推进的未完成项（pending + in_progress），**不含 blocked** */
    unfinished: number;
    /** 等待用户 / 外部条件的项（2026-10-06 新增；老事件无此字段） */
    blocked: number;
  },
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "TodoProgressAdvanced",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}

/**
 * 把 repeated-readonly-guard（无进展只读命令止损阀）的一次触发落成结构化 trace 事件。
 *
 * 为什么单独给这道阀补埋点（负收益防线审计 发现 1，2026-07-30）：它是全 harness 里
 * **唯一默认全局开启、且能 `yield done` 强制掐断用户任务**的检测器（loop-detection /
 * output-stall / thinking-divergence 都默认关闭），可它触发与否此前**完全不可观测**——
 * `~/.sid-code/` 下搜不到任何相关字样，只有不落盘的 log.warn。
 * 审计在 481 轮真实轨迹上重放它的 processObservation：产生只读探查的轮次 182（37.8%），
 * 而 remind / terminate 触发均为 **0**，观察到的最长连续相同签名只有 1（阈值需 3）。
 * 这不是"阈值差一点"，是它设计要防的 git-status 死锁族在当前样本里不复现（那次事故来自
 * deepseek-v4-pro，本批 481 轮以 glm-5.2 为主）。结论是**误伤实测为 0、收益不可知**，
 * 故刻意不动 STUCK_REPEAT_THRESHOLD——只补埋点，让死锁下次复发时能确认这道阀有没有拦住。
 * 这是"更安全"方向上的度量缺口，不是防线缺陷。
 *
 * `action` 区分 remind（软注入）与 terminate（强制收尾）——后者代价高得多，必须能单独统计。
 */
function emitStuckGuardEvent(
  deps: QueryDeps,
  sessionId: string,
  data: {
    /** remind = 注入收敛提醒；terminate = 强制收尾（唯一会掐断用户任务的动作）。 */
    action: "remind" | "terminate";
    turn: number;
    /** 缺口7：会话累计轮次（不随用户消息重置），跨消息可比较。 */
    absoluteTurn?: number;
    /** 缺口7：第几条用户消息，让 turn 的回绕可还原。 */
    promptSeq?: number;
    /** 连续相同签名次数（阈值 STUCK_REPEAT_THRESHOLD），用于事后核对判据是否过紧/过松。 */
    repeatCount: number;
    reminderCount: number;
    /** 命中的代表命令，截断到 200 字符——只为归类死锁形态，不必留全文。 */
    command: string;
    probeCount: number;
  },
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "RepeatedReadonlyGuardTriggered",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}

/** queryLoop 配置 */
export interface QueryLoopConfig {
  config: Config;
  ctxMgr: ContextManager;
  toolRegistry: ToolRegistry;
  sessionState: SessionState;
  fallback: ModelFallback;
  hookSystem?: HookSystem;
  quotaManager?: QuotaManager;
  tokenMeter?: TokenMeter;
  budgetTracker?: BudgetTracker;
  /**
   * Extended Thinking / 推理强度配置（由 engine 从 ThinkingManager 解析后透传）。
   * 此前 engine 算出 `_thinking` 却从未下传，导致：
   *   - Anthropic：anthropic.ts 早已读 `params.thinking` 但无人填 → Extended Thinking 全程未生效；
   *   - DeepSeek：reasoning_effort 无映射源 → `think hard`/`ultrathink` 永不触发更深推理。
   * 此字段是修复该断链的入口，最终写入每轮的 SendParams.thinking。
   */
  thinking?: { enabled: boolean; budgetTokens: number };
  /**
   * M6：本次 queryLoop 是否是同一条用户 prompt 的续跑（#313 空闲唤醒 `resumeWithNotifications`）。
   * true 时 S1 的 per-prompt 状态（nudge 计数等）从 SessionState 继承而非归零。缺省 = 新 prompt。
   */
  continuation?: boolean;
  deps: QueryDeps;
}

/**
 * 核心执行循环 — async generator
 *
 * 每次 yield 一个 QueryLoopYield 事件给上层消费。
 * 上层通过 for await...of 消费，天然支持背压。
 */
/**
 * 请求前的本地预算硬停判定（导出供测试）。返回 null = 放行。
 *
 * 只看「已经超限」这一事实，不看告警升级事件：后者 exceeded 只报一次，
 * 拿它当判据就是「超限只拦一次」那个缺陷（2026-10-22）。
 */
export function checkPreRequestBudgetStop(
  loopConfig: Pick<QueryLoopConfig, "budgetTracker" | "quotaManager">,
  effectiveCostUSD: number,
): { source: "budget_rule" | "quota"; text: string } | null {
  const blocking = loopConfig.budgetTracker?.findBlockingRule();
  if (blocking) {
    return {
      source: "budget_rule",
      text: `预算规则 "${blocking.rule.name}" 本周期已超限（$${formatBudgetUsd(blocking.currentUSD, 4)} / $${formatBudgetUsd(blocking.rule.limitUSD, 2)}），仍拦截`,
    };
  }
  if (loopConfig.quotaManager?.isExceeded(effectiveCostUSD)) {
    return {
      source: "quota",
      text: loopConfig.quotaManager.stillExceededMessage(effectiveCostUSD),
    };
  }
  return null;
}

export async function* queryLoop(loopConfig: QueryLoopConfig): AsyncGenerator<QueryLoopYield> {
  const log = getLogger();
  const { config, ctxMgr, toolRegistry, sessionState, hookSystem, thinking, deps } = loopConfig;

  const loopDetector = new LoopDetector();
  const state: LoopState = createInitialLoopState(config.maxTurns || Infinity);
  // 停滞升级阶梯（stall-escalation.ts）。headless 默认不开；settings 读不到按影子处理。
  const stallSwitches = resolveStallSwitches(config.print === true, readStallHardStopSetting());
  if (stallSwitches.enabled) {
    const gb = sessionState.get(TODO_GATE_BUDGET_KEY) as TodoGateBudget | undefined;
    state.stall = createStallState(gb?.oscillations ?? 0);
  }
  // P1-4：端到端耗时基准 = "用户回车那一刻"，所以设在 queryLoop **入口**，
  // 不是 while 每次迭代（那是本条消息内的一次 API 往返，不是一次答复）。
  // 基准随 LoopState 每条用户消息重建而天然重设 —— 见 turn-complete.ts 文件头铁律 2。
  beginTurn(state, sessionState);
  /**
   * P1-4：本轮结束原因。在语义明确的收尾点显式赋值；未赋值时由下方统一出口按
   * abort signal 判定。刻意不在这里预设 "end_turn" —— 预设成正常值会让所有异常
   * 退出路径静默计成正常收尾，那正是「归因与真实信号脱节」那类反模式。
   */
  let turnStopReason: TurnStopReason | undefined;
  /**
   * P1-6：是否将要跑「maxTurns 强制总结轮」。
   *
   * 必须与下方 try 外那段 `if` **以及**「函数会不会落到那段」同源。
   * `yield done; return` 在 try 里会跑 finally，然后函数直接返回，总结轮根本不跑。
   * 旧判据只看 turnCount>=maxTurns，finally 以为总结还在而跳过 TurnComplete，
   * 无头评测打满上限的题系统性没锚点。
   *
   * `exitedViaReturn` 在每个 `return` 出口置位；自然出 while（turnCount 耗尽、
   * 没有 return）才可能落到 try 外的总结段。
   */
  let exitedViaReturn = false;
  // L2 真停与 maxTurns 共用同一个强制总结出口（§5 决策 1 第 1 条：不新造机制）
  const willRunForcedSummary = (): boolean =>
    !exitedViaReturn &&
    (state.turnCount >= state.maxTurns || state.stallStopRequested === true) &&
    !deps.getAbortSignal?.()?.aborted;
  /**
   * P1-4：发射本轮 `TurnComplete`（幂等，重复调用只生效一次）。
   *
   * 归因优先级：语义明确的赋值 > abort signal > maxTurns > error。
   * 刻意不做"错误文本匹配"—— `stream-timeout-misclassified-as-cancel` 的教训：
   * 判超时要看 abort reason 白名单而不是错误字符串，字符串一改口径就悄悄失效。
   */
  const emitTurnCompleteHere = (): void => {
    const abortedNow = deps.getAbortSignal?.()?.aborted === true;
    emitTurnComplete(state, sessionState, deps, {
      sessionId: sessionState.sessionId,
      absoluteTurn: sessionState.getAbsoluteTurn(),
      promptSeq,
      stopReason:
        turnStopReason ??
        (abortedNow
          ? "abort"
          : // 与收尾处 stalledExit 同口径：同时撞 maxTurns 时事件走 max_turns，stopReason 也得是 max_turns
            state.stallStopRequested && state.turnCount < state.maxTurns
            ? "stalled"
            : state.turnCount >= state.maxTurns
              ? "max_turns"
              : // 既没走正常收尾、也没 abort、也没到上限 —— 抛错穿透 finally 的形态。
                // 归 error 而非 other：这是唯一能观测到"异常穿透"的位置。
                "error"),
      toolCallsInTurn: state.toolCallsDispatched ?? 0,
    });
  };
  // 缺口7：本次 queryLoop 即"第几条用户消息"。埋点带上它，`turn=3` 才能还原到
  // 具体哪条消息的第 3 轮——否则跨消息会话里 turn 回绕（实测 135709 会话
  // turn=20 之后出现 turn=3）在离线分析里无法与"真的退回第 3 轮"区分。
  const promptSeq = sessionState.nextPromptSeq();
  /** settleCompaction 的作用域：失败计数与熔断都按「本条用户消息」算（见 LoopState.compactCircuitOpen） */
  const compactScope = { state, promptSeq };
  /** 某道闸门续命预算耗尽 → 落 GateExhausted（语义见 gate-exhaustion.ts 文件头） */
  const noteGateExhausted = (gate: ExhaustibleGate, retries: number, cap: number): void =>
    emitGateExhausted(state, deps, {
      sessionId: sessionState.sessionId,
      absoluteTurn: sessionState.getAbsoluteTurn(),
      promptSeq,
      gate,
      retries,
      cap,
    });
  /**
   * 「未答复的 end_turn」每次命中落一条 `UnansweredEndTurn`（含耗尽那次），带形态与模型。
   * digest 按形态 × 模型聚合；`unparsed_tool_call` 是协议级偏差，目标恒为 0。
   */
  const emitUnansweredEndTurn = (
    shape: string | undefined,
    attempt: number,
    exhausted: boolean,
    provider: string | undefined,
    model: string | undefined,
  ): void => {
    if (!deps.traceAppendEvent) return;
    try {
      deps.traceAppendEvent({
        event: "UnansweredEndTurn",
        session_id: sessionState.sessionId,
        timestamp: new Date().toISOString(),
        data: {
          shape: shape ?? "unknown",
          attempt,
          cap: MAX_UNANSWERED_RETRIES,
          exhausted,
          promptSeq,
          turn: state.turnCount,
          provider,
          model,
        },
      });
    } catch {
      /* trace 写入失败不阻断主循环 */
    }
  };
  // M6：S1 计数按「用户 prompt」而非「queryLoop 调用」计。LoopState 每次调用重建，
  // 空闲唤醒续跑若从零开始，同一 prompt 下每来一次后台通知就多一次 nudge 配额。
  {
    const carry = initialS1Carry(
      loopConfig.continuation === true,
      sessionState.get(S1_PROMPT_CARRY_KEY),
    );
    state.promiseNudgeCount = carry.promiseNudgeCount;
    state.prevResponseHadToolUse = carry.prevResponseHadToolUse;
  }
  const saveS1Carry = (): void => {
    sessionState.set(S1_PROMPT_CARRY_KEY, {
      promiseNudgeCount: state.promiseNudgeCount ?? 0,
      prevResponseHadToolUse: state.prevResponseHadToolUse === true,
    } satisfies S1PromptCarry);
  };
  saveS1Carry();
  /** S1 L2：已注入 nudge、等下一轮响应给出 outcome 的那一次（每 prompt 至多 1 个） */
  let pendingPromiseNudge: { lang: PromiseLang } | undefined;
  /** S1 L2 的验收事件：`fired` + `outcome`（触发后下一轮是否 tool_use / 未触发的原因） */
  const emitPromiseNudge = (
    lang: PromiseLang,
    fired: boolean,
    extra: { outcome: string; skip_reason?: string },
  ): void => {
    try {
      deps.traceAppendEvent?.({
        event: "PromiseNudge",
        session_id: sessionState.sessionId,
        timestamp: new Date().toISOString(),
        data: { ...turnMetrics(state, sessionState, promptSeq), fired, lang, ...extra },
      });
    } catch {
      /* trace 写入失败不阻断主循环 */
    }
  };
  /** S1 L1：每次 end_turn 收尾的形态事实（S4 的推理占比 / 写入数 / 只读数一并落） */
  const emitEndTurnShape = (
    shape: EndTurnShape,
    facts: {
      stopReason: string | undefined;
      outputTokens: number;
      reasoningTokens: number;
      prevTurnHadToolUse: boolean;
      runningBackgroundTasks: boolean;
      pendingNotifications: boolean;
    },
  ): void => {
    try {
      deps.traceAppendEvent?.({
        event: "EndTurnShape",
        session_id: sessionState.sessionId,
        timestamp: new Date().toISOString(),
        data: {
          ...turnMetrics(state, sessionState, promptSeq),
          kind: shape.kind,
          stop_reason: facts.stopReason,
          text_len: shape.textLen,
          ...(shape.lang ? { lang: shape.lang } : {}),
          output_tokens: facts.outputTokens,
          reasoning_tokens: facts.reasoningTokens,
          had_tool_use: false,
          prev_turn_had_tool_use: facts.prevTurnHadToolUse,
          // S4：本 prompt 累计口径（不是本次调用），不下结论只报事实
          prompt_output_tokens: state.promptOutputTokens ?? 0,
          prompt_reasoning_tokens: state.promptReasoningTokens ?? 0,
          reasoning_share: reasoningShare(
            state.promptReasoningTokens ?? 0,
            state.promptOutputTokens ?? 0,
          ),
          prompt_edit_write_count: state.promptEditWriteCount ?? 0,
          prompt_readonly_count: state.promptReadonlyCount ?? 0,
          running_background_tasks: facts.runningBackgroundTasks,
          pending_notifications: facts.pendingNotifications,
        },
      });
    } catch {
      /* trace 写入失败不阻断主循环 */
    }
  };
  const diminishingDetector = new DiminishingReturnsDetector();
  // P0-3：Token Budget 续写——解析本条用户消息里的 "+500k" 类预算指令（一次性，
  // 随每条新用户消息的新 state 天然重置，见 LoopState.tokenBudgetTarget 注释）。
  // 命中则记录目标值与当前累计 usage 基线；复用 DiminishingReturnsDetector 判断
  // "产出是否递减"，但续写次数上限调宽到 1000——真正的停止条件是预算耗尽，不是
  // 次数（见 token-budget-continuation.ts 顶部注释）。
  const parsedTokenBudget = parseTokenBudgetDirective(extractLastUserInput(ctxMgr));
  if (parsedTokenBudget !== undefined) {
    state.tokenBudgetTarget = parsedTokenBudget;
    // P2-4：基线与下方 Gate 的 `consumed` 必须用同一个函数算——两处各写一遍加法，
    // 改一处漏一处就是「基线含 cacheRead、消耗不含」这类静默偏差（差值直接变成负数或虚高）。
    state.tokenBudgetBaselineUsage = tokenBudgetConsumed(sessionState.getTotalUsage());
    log.info(
      "QUERY_LOOP",
      `P0-3：检测到 Token Budget 指令，目标 ${parsedTokenBudget.toLocaleString()} tokens`,
    );
  }
  // P2-4：递减阈值**不再显式写回 500**，与 max_tokens 续写对齐到默认值（150）。
  //
  // 500 是 DiminishingReturnsDetector 的**历史**默认值，2026-07-07 已收紧到 150，
  // 理由写在 reactive-compact.ts 的 DIMINISHING_THRESHOLD 注释里：分段产出每段几百
  // token 很正常，500 阈值下"连续两段各 <500"极易命中，把正常分段误判为重复/填充。
  // 这里再写回 500 等于在本路径上把那次修复撤销——典型形态是连续两轮 end_turn 输出
  // <500 token（「做完了」这种短收尾恰好就是），预算剩得再多也当场判递减收尾、作废。
  // maxRecoveryCount 仍显式放宽（本场景真正的停止条件是预算耗尽，不是续写次数）。
  const budgetDiminishingDetector = new DiminishingReturnsDetector({
    maxRecoveryCount: 1000,
  });
  // Fix 1：每次 queryLoop 生成唯一 loopId，用于 snapshot namespace 隔离
  const loopId = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // /goal：合并用户 config.goal 与内置默认值（用户未配则全走默认）
  const effectiveGoalConfig = { ...DEFAULT_GOAL_CONFIG, ...config.goal };
  // /goal：卡住检测器（基于评估者返回的 blockerKey 精确匹配）
  const goalBlockedDetector = new BlockedDetector(effectiveGoalConfig.blockedThreshold);

  // ─── 工具延迟加载（ToolSearch）：每会话判定一次 ───
  // config.toolSearch 支持 boolean | "auto" | number(百分比)：
  //   - true/false：恒开/恒关
  //   - "auto"/number：按"延迟工具 token 总数 ≥ 上下文窗口 × 阈值%"自动判定
  // 只判定一次（不每轮）——避免 MCP 连接完成后工具集增长导致中途从"全量"切到
  // "延迟"，让模型上下文里工具突然消失（幻觉/重试 churn）。对标 claude-code 的
  // isToolSearchEnabled（按会话/请求定档）。
  // 延迟工具定义 = 全量 definitions 减去 activeDefinitions（此时尚无手动激活，差集即全部延迟工具）。
  const toolSearchEnabled = (() => {
    if (toolRegistry.size() === 0) return false;
    const activeNames = new Set(toolRegistry.activeDefinitions().map((d) => d.name));
    const deferredDefinitions = toolRegistry.definitions().filter((d) => !activeNames.has(d.name));
    return resolveToolSearchEnabled(config.toolSearch, {
      model: config.model,
      availableModels: config.availableModels,
      baseURL: config.baseURL,
      deferredDefinitions,
    });
  })();

  // F2：延迟加载关闭时，本次 loop 只发开始时已在的 MCP 工具，晚到的等下一条用户消息。
  // 开启时 MCP 工具本就走 deferred 池，不需要冻结（冻了反而挡住 tool_search 的激活）。
  const mcpToolsAtLoopStart = toolSearchEnabled
    ? undefined
    : snapshotMcpToolNames(toolRegistry.definitions());
  let lateMcpWithheldLogged = false;

  // 回填定档结果给 registry，供 tool-executor 的「schema 未发送」补救判定使用
  // （模型盲调未激活的延迟工具、传了畸形参数时，追加"先 tool_search 激活"引导）。
  // 定档只算一次（循环外），与 toolSearchEnabled 局部变量同源，不会会话内漂移。
  toolRegistry.setToolSearchEnabled(toolSearchEnabled);

  // 可观测性（对齐 CC 的 logForDebugging 风格，只打日志不做 /context 特性）：
  // 启用延迟加载时打一行——首轮发多少工具、延迟多少、豁免哪几个高频工具，
  // 便于排查"某 MCP 工具首轮为何可见/不可见"。
  if (toolSearchEnabled) {
    const activeCount = toolRegistry.activeDefinitions().length;
    const deferredNames = toolRegistry.deferredToolNames();
    log.info(
      "TOOL_SEARCH",
      `延迟加载已启用：首轮发送 ${activeCount} 个工具，延迟 ${deferredNames.length} 个` +
        (config.toolSearchKeepLoaded && config.toolSearchKeepLoaded.length > 0
          ? `，豁免名单 [${config.toolSearchKeepLoaded.join(", ")}]`
          : ""),
    );
  }

  // Fix 1：try/finally 包裹整个 while 循环，确保 queryLoop 结束时（正常/异常/
  // 外部 .return() 中止）都能批量清理本次 loopId 下的所有残留快照，避免孤儿
  // generator 写入的脏数据无限累积，也避免内存泄漏。
  // M5：自上次推进回合纪元以来，模型是否**真的返回过一次响应**。
  // 回合纪元的语义是「送达的通知已被模型看过一次」。while 迭代 ≠ 模型看过：PTL 压缩重试、
  // 超时重试、fallback 换模型都会 `continue` 回到循环顶部，而这些尝试的响应从没产生过，
  // 压缩还可能把刚注入的通知摘要掉。按迭代推进的话，一次 >30s 的重试就足以让 `.output`
  // 在模型读到之前被删。所以只有拿到响应之后才允许推进（轮开头与 finally 两处同一判据）。
  let modelRespondedSinceTurnMark = false;
  try {
    while (state.turnCount < state.maxTurns) {
      state.turnCount++;
      // 缺口7：与消息内 turnCount 严格同点推进会话累计轮次。两者必须同点自增，
      // 否则 absoluteTurn 会漂移——漂移的绝对轮次比没有绝对轮次更糟（前者会被当真）。
      // 递增后由 turnMetrics() 经 sessionState.getAbsoluteTurn() 读取，不留局部变量，
      // 避免出现"局部快照"和"会话真值"两个来源再分裂一次。
      sessionState.nextAbsoluteTurn();
      loopDetector.recordTurn();

      // ─── 后台任务完成通知回注（对标 claude-code <task-notification> 投递）───
      // 根因修复：后台子代理（run_in_background=true）完成后 completeAgentTask/failAgentTask
      // 把 <task-notification> 塞进 pendingQueue，但真实主循环 queryLoop 此前从不出队，
      // 导致"完成后会通知你"成为虚假承诺。这里在每轮开头出队并作为 user 消息注入，
      // 让主代理被动收到后台子代理的结构化结果/失败信息。
      //
      // ⚠️ 这里只覆盖「通知在本轮进行中到达」。主循环 end_turn 之后才到的通知，
      // 这里永远等不到下一轮——那条路径由 QueryEngine.resumeWithNotifications 接管
      // （空闲唤醒，见 task/background-wake.ts）。两处共用 injectPendingNotifications。
      //
      // S3 回合纪元：第 2+ 轮开头 = 上一轮已完整跑完。**必须先推进、再注入**——反过来，
      // 本轮刚送达的通知会被记成「上一轮送达」，本轮模型调用还没开始就满足驱逐条件，
      // `.output` 在模型读之前被删（S3 事故原样重演）。
      if (state.turnCount > 1 && modelRespondedSinceTurnMark) {
        markMainTurnCompleted();
        modelRespondedSinceTurnMark = false;
      }
      injectPendingNotifications(ctxMgr, deps.sessionStore);

      // 驱逐「送达之后已过至少一个回合」的终态任务（判据见 registry `evictDecision`）。
      // 本轮刚送达的不会在这里被删：它们的送达回合 = 当前纪元，要等本轮跑完。
      evictTerminalTasks();

      // ─── G4：LSP 健康告警（一次性，懒触发）───
      // LSP 后台异步初始化，首轮可能仍 pending；这里每轮检查直到出结果，有异常则
      // yield 一次 system 警告（用户可见、不进 LLM 上下文）并置位，避免每轮刷屏。
      // 正常（无异常）时 getLSPHealthWarning 返回 null，不打扰用户。
      if (!state.lspHealthWarned) {
        const lspWarning = getLSPHealthWarning();
        if (lspWarning) {
          state.lspHealthWarned = true;
          log.warn("QUERY_LOOP", `G4：LSP 健康告警 — ${lspWarning}`);
          yield { kind: "system", level: "warning", text: lspWarning };
        }
      }

      // ─── 上下文使用率监控 ───
      const toolCount = toolRegistry.size();
      const currentTokens = ctxMgr.estimateTokens(toolCount);
      const contextMax = ctxMgr.getMaxTokens();
      const usagePercent = (currentTokens / contextMax) * 100;
      const remaining = 100 - usagePercent;

      getSessionMetrics().updatePeakTokens(currentTokens);

      log.info(
        "QUERY_LOOP",
        `轮次 ${state.turnCount}/${state.maxTurns}，消息数 ${ctxMgr.getMessages().length}，上下文 ${usagePercent.toFixed(0)}%`,
      );

      // ─── 分级压缩策略 ───
      // blocking 绝对底线（剩余极少、连一次 LLM 往返都危险）优先于 getCompactionLevel 的渐进档。
      // §12 P2-2：此前这里还算 autoCompact 档但从不消费（死代码），已清理——渐进压缩
      // （soft/hard/emergency）统一由下方 getCompactionLevel 接管。
      const remainingTokens = contextMax - currentTokens;
      const isBlocking = remainingTokens <= TOKEN_THRESHOLDS.blocking;

      const compactionLevel = ctxMgr.getCompactionLevel(toolCount);
      // 发现 3a/3c：压缩前后比较用的同源尺子——不套 lastActualInputTokens 锚点
      // （压缩会清零锚点，before 套、after 不套就是两把尺子）。
      const sameSourceTokens = () => ctxMgr.estimateTokensFor(ctxMgr.getMessages(), toolCount);

      // M4：每轮组装快照。数字全部来自上面已经算好的局部变量，
      // 禁止再调 estimateTokens / getTokenBreakdown（热路径禁令）。
      logContextAssembled({
        turn: state.turnCount,
        messageCount: ctxMgr.getMessages().length,
        estimatedTokens: currentTokens,
        maxTokens: contextMax,
        compactionLevel,
        blocking: isBlocking,
        calibrated: ctxMgr.isCalibrated(),
        toolCount,
      });

      // blocking：强制截断（不调用 LLM）
      if (isBlocking) {
        log.warn("QUERY_LOOP", `上下文阻塞 (剩余 ${remainingTokens} tokens)，强制截断`);
        const msgCountBefore = ctxMgr.messageCount();
        const sameSourceBefore = sameSourceTokens();
        const truncated = ctxMgr.emergencyTruncate();
        const sameSourceAfter = sameSourceTokens();
        ctxMgr.addCompactBoundary(`阻塞级压缩：剩余 ${remainingTokens} tokens`, msgCountBefore);
        // P0-1：边界是 push 到数组末尾的。此时 i < boundaryIdx 覆盖的是整段历史，
        // 含 emergencyTruncate 特意留下的保留段。GC 会把近端 tool_result 换成
        // `[已释放]` 桩发给 LLM，长会话一压就失忆。emergency 档同套 truncate
        // 却不 GC——blocking 必须与它对齐，不得在「边界贴末尾」时释放保留段。
        state.goalReminderPendingAfterCompact = true;
        state.todoReminderPendingAfterCompact = true;
        state.deferredToolsPendingAfterCompact = true;
        {
          // P1-3：横幅只在真压动时画。addCompactBoundary 会插入边界消息，故 after 取实测值。
          const { banner } = settleCompaction(deps, sessionState.sessionId, compactScope, {
            trigger: "threshold_blocking",
            messageCountBefore: msgCountBefore,
            messageCountAfter: truncated.messageCountAfter,
            // 3c：不用 truncated.tokensBefore/After——前者套了锚点、后者锚点已清零，两者不同源。
            tokensBefore: sameSourceBefore,
            tokensAfter: sameSourceAfter,
            ...(truncated.reason === "no_split_point" ? { noopReason: "no_split_point" } : {}),
          });
          if (banner) yield banner;
          // P2-22：截断真压动了才补恢复。判据与横幅同源（banner 非 null = 实测消息数减少）——
          // 没压动时注入「最近访问过这些文件」只是往一个没腾出空间的上下文里再加一条消息。
          if (banner) {
            const injected = deps.emergencyFileReattach?.({ trigger: "threshold_blocking" }) ?? 0;
            if (injected > 0) {
              log.info("QUERY_LOOP", `阻塞级截断后补注入最近文件路径清单（${injected} 条消息）`);
            }
          }
        }
      } else {
        switch (compactionLevel) {
          case "emergency":
            log.warn("QUERY_LOOP", `上下文紧急 (${usagePercent.toFixed(0)}%)，强制截断`);
            {
              const msgCountBefore = ctxMgr.messageCount();
              const sameSourceBefore = sameSourceTokens();
              const truncated = ctxMgr.emergencyTruncate();
              const sameSourceAfter = sameSourceTokens();
              ctxMgr.addCompactBoundary(
                `紧急压缩：使用率 ${usagePercent.toFixed(0)}%`,
                msgCountBefore,
              );
              state.goalReminderPendingAfterCompact = true;
              state.todoReminderPendingAfterCompact = true;
              state.deferredToolsPendingAfterCompact = true;
              const { banner } = settleCompaction(deps, sessionState.sessionId, compactScope, {
                trigger: "threshold_emergency",
                messageCountBefore: msgCountBefore,
                messageCountAfter: truncated.messageCountAfter,
                tokensBefore: sameSourceBefore,
                tokensAfter: sameSourceAfter,
                ...(truncated.reason === "no_split_point" ? { noopReason: "no_split_point" } : {}),
              });
              if (banner) yield banner;
              // P2-22：与 blocking 分支同一套轻量恢复（只给路径清单，不读盘、不带正文）。
              // 判据同横幅：banner 非 null = 实测真压动了。
              if (banner) {
                const injected =
                  deps.emergencyFileReattach?.({ trigger: "threshold_emergency" }) ?? 0;
                if (injected > 0) {
                  log.info("QUERY_LOOP", `紧急截断后补注入最近文件路径清单（${injected} 条消息）`);
                }
              }
            }
            break;
          case "hard": {
            log.warn(
              "QUERY_LOOP",
              `上下文接近上限 (${usagePercent.toFixed(0)}%)，启动渐进式压缩管道`,
            );
            const msgCountBefore = ctxMgr.messageCount();
            const sameSourceBefore = sameSourceTokens();
            const pipelineResult = runCompactPipeline(ctxMgr.getMessages(), {
              currentUsageRatio: usagePercent / 100,
              maxTokens: contextMax,
              toolCount,
              // 发现 3b：达标线 = masking 进入线再往下 5% 窗口（1.05M 窗口约 73%）。
              // 旧值是 hard 触发点本身（约 82%），截断第一步刚好压线就退出，随后一路涨回去，
              // 且压完仍停在 masking 区，与发现 4 的遮罩翻转叠加。派生规则见 pipelineTargetRatioFrom。
              targetUsageRatio: pipelineTargetRatioFrom(ctxMgr),
              // P1-6：管线逐步替换消息时用与 getCompactionLevel 同一把尺子
              // （CJK 区分 + calibrationFactor + system/tool schema）。此前管线内部
              // 用 chars/4，中文密集会话上与触发判据能差出数倍。
              estimateTokens: (msgs) => ctxMgr.estimateTokensFor(msgs, toolCount),
            });

            if (pipelineResult.steps.length > 0) {
              ctxMgr.setMessages(pipelineResult.messages);
              // D10：渐进式管道是三条压缩入口里第三条**此前完全不落盘**的。
              // 必须在这里调（setMessages 之后、下方 autoCompact/collapse 之前）——
              // 那两者内部走 compactWithSummary 会自己落盘，晚调会把它们的压缩量算到管道账上。
              ctxMgr.recordPipelineCompaction(pipelineResult.steps.join(" → "), msgCountBefore);
              log.info(
                "QUERY_LOOP",
                `渐进式压缩: ${pipelineResult.steps.join(" → ")}，节省 ${pipelineResult.totalSavedChars} 字符`,
              );
              yield {
                kind: "system",
                level: "info",
                text: `渐进式压缩: ${pipelineResult.steps.join(" → ")}`,
              };
            }

            // 结局三态 R2：noopReason 只由本次尝试中**最后执行的那个动作**给出。
            // 管线的 already_below_target 只在不再往下跑 collapse/autoCompact 时有效。
            let hardNoopReason: CompactNoopReason | undefined = pipelineResult.needsAutoCompact
              ? undefined
              : pipelineResult.noopReason;

            if (pipelineResult.needsAutoCompact && state.compactCircuitOpen) {
              // loop 层熔断开着：只跳过花钱的两个动作（collapse 与 autoCompact 都调 LLM），
              // 上面的本地管线照做、主循环继续。若上下文涨到 API 拒收，自然进流内路径按既有语义收尾。
              if (deps.contextCollapse) {
                recordCompactionSkipped(
                  deps,
                  sessionState.sessionId,
                  compactScope,
                  "context_collapse",
                  "threshold_hard",
                );
              }
              recordCompactionSkipped(
                deps,
                sessionState.sessionId,
                compactScope,
                "auto_compact",
                "threshold_hard",
              );
              if (!state.compactSkipNotified) {
                state.compactSkipNotified = true;
                yield {
                  kind: "system",
                  level: "warning",
                  text: "连续压缩失败已达上限，本条消息内不再尝试 LLM 摘要压缩（可执行 /compact 或开新会话）。",
                };
              }
            } else if (pipelineResult.needsAutoCompact) {
              // §2.2：autoCompact 前先尝试 Context Collapse（分段摘要老消息，中等成本）。
              // collapse 成功（usage 降到目标）→ 跳过昂贵的全量 autoCompact；不够 → 继续 autoCompact。
              let collapsed = false;
              if (deps.contextCollapse) {
                try {
                  const ratioAfterPipeline = ctxMgr.estimateTokens(toolCount) / contextMax;
                  // P1-14：collapse 成功会**跳过** autoCompact，于是收尾（绑在 autoCompact 上）
                  // 整条不执行。这里先抓 before 快照，成功后自己调收尾。
                  const collapseMsgsBefore = ctxMgr.messageCount();
                  const collapseTokensBefore = ctxMgr.estimateTokens(toolCount);
                  collapsed = await deps.contextCollapse(ratioAfterPipeline);
                  if (collapsed) {
                    log.info("QUERY_LOOP", "Context Collapse 成功，跳过 autoCompact");
                    yield { kind: "system", level: "info", text: "上下文分段压缩完成" };
                    // 判据同 P1-13：只有实测消息数真的减少了才算「压缩发生了」。
                    // collapse 自报 success=true 但消息数未变时不做收尾——重注入文件
                    // 反而会往一个没腾出空间的上下文里再塞 50K。
                    if (ctxMgr.messageCount() < collapseMsgsBefore) {
                      await deps.postCompactTail?.({
                        trigger: "collapse",
                        messagesBefore: collapseMsgsBefore,
                        tokensBefore: collapseTokensBefore,
                      });
                    }
                  }
                } catch (err: any) {
                  log.warn("QUERY_LOOP", `Context Collapse 异常，回退 autoCompact: ${err.message}`);
                  // 优化 1：collapse 失败被吞、静默回退 autoCompact——engine 层看不到。记 post_stream。
                  deps.recordError?.({
                    phase: "post_stream",
                    index: state.turnCount,
                    error: (err as Error)?.message ?? String(err),
                    stack: (err as Error)?.stack?.split("\n").slice(0, 5).join("\n"),
                    context: {
                      kind: "context_collapse_failed",
                      willRetry: false,
                      fallback: "autoCompact",
                    },
                  });
                }
              }
              if (!collapsed) {
                log.warn("QUERY_LOOP", "轻量压缩不足，触发 LLM 摘要压缩");
                const autoResult = await deps.autoCompact();
                if (autoResult.kind === "skipped") hardNoopReason = autoResult.reason;
                // 静默-9：LLM 摘要失败/熔断降级为简单截断时（有损，丢弃老消息），
                // 原来无声无息——用户观感是"上下文突然失忆"却无提示。这里 yield warning 显式告知。
                if (autoResult.kind === "truncated") {
                  yield {
                    kind: "system",
                    level: "warning",
                    text: "上下文摘要压缩失败，已降级为简单截断（丢弃部分历史消息）。若后续回答缺失上下文，请重述关键信息。",
                  };
                }
              }
            }

            // 熔断状态下管线也一步没做：本轮什么都没发生，就不是一次「尝试」——不调
            // settleCompaction、不插边界、不置三个重注入标志，否则每轮多一条边界和三条提醒。
            if (state.compactCircuitOpen && pipelineResult.steps.length === 0) break;

            // 发现 3a：after 在插边界**之前**取——边界是无条件追加的一条，计进去会让
            // 「原地替换 + 边界」恒为 +1、恒判失败。token 同理用不套锚点的同源估算。
            const msgCountAfter = ctxMgr.messageCount();
            const sameSourceAfter = sameSourceTokens();
            ctxMgr.addCompactBoundary(
              `渐进式压缩: ${pipelineResult.steps.join(" → ")}`,
              msgCountBefore,
            );
            // P0-1：同上，边界贴在末尾。管道即便 steps=[]（什么都没压）原先也会
            // 把保留段整段 GC 掉；用户侧表现为「没压缩、模型突然失忆」。
            // 近端必须留给模型，旧内容已由 snip/microcompact 原地处理。
            state.goalReminderPendingAfterCompact = true;
            state.todoReminderPendingAfterCompact = true;
            state.deferredToolsPendingAfterCompact = true;
            {
              // hard 档走的是「渐进式管道 + 可选 autoCompact/collapse」，压缩量不由单个函数返回，
              // 故 after 取实测消息数——这条路径同样必须满足「没压动就不画横幅」。
              const { banner } = settleCompaction(deps, sessionState.sessionId, compactScope, {
                trigger: "threshold_hard",
                messageCountBefore: msgCountBefore,
                messageCountAfter: msgCountAfter,
                tokensBefore: sameSourceBefore,
                tokensAfter: sameSourceAfter,
                strategy: pipelineResult.steps.join(" → ") || undefined,
                ...(hardNoopReason ? { noopReason: hardNoopReason } : {}),
              });
              if (banner) yield banner;
            }
            break;
          }
          case "soft":
            // soft 档本身不在此执行任何压缩动作：工具输出遮罩与剪枝统一在发送前的
            // getCleanedMessages()（见本文件下方 cleanedMessages = ctxMgr.getCleanedMessages()）
            // 里应用。此处仅记录进入了 soft 档，便于排查——不要误以为这里执行了压缩。
            log.info(
              "QUERY_LOOP",
              `上下文 ${usagePercent.toFixed(0)}%，进入 soft 档（遮罩/剪枝将在发送前 getCleanedMessages 统一应用）`,
            );
            break;
          case "none":
            break;
        }
      }

      if (remaining <= 6) {
        yield { kind: "context_warning", remaining };
      }

      // ─── 构建请求参数 ───
      // 生产端发送前协议兜底 backstop（系统级查漏补缺方案 防线 1，根因终结关卡）：
      // 无论破缺从哪条路径进入历史（循环恢复 / 中断时序 / followup 排序 / plan-mode 转换 /
      // restoreSession slice / snipCompact / auto-compact / 未来新增），发送前统一在 ctxMgr
      // 历史层修复——孤儿 tool_use 补 error 占位、游离 tool_result 直接切除，使其满足配对协议。
      // 这是 ADR-039「不变量在出口强制」哲学的终点——executeTools 守生产单点，这里守"所有路径的总出口"。
      // 与消费端只读哨兵（protocol-sentinel）互补：哨兵负责发现+告警+落盘，本关卡负责真正修复，不让 400 发生。
      {
        const backfill = finalizeMessagesForSend(ctxMgr.getMessages());
        if (backfill.changed) {
          ctxMgr.setMessages(backfill.messages);
          if (backfill.backfilled.length > 0) {
            const detail = backfill.backfilled
              .map((o) => `${o.name}(id=${o.id} @msg#${o.messageIndex})`)
              .join(", ");
            log.error(
              "QUERY_LOOP",
              `发送前孤儿兜底关卡触发：补齐 ${backfill.backfilled.length} 个孤儿 tool_use 的占位 tool_result（已修复，避免 OpenAI 400）：${detail}。` +
                // 成因清单必须与真实产生端同步（2026-08-04 教训）：旧清单漏了 F1
                // 空参数重试，而它恰好是实测触发这条日志的产生端，照旧清单去查
                // 「循环恢复/中断」会白费功夫。新增任何绕过工具执行的分支都要补进来。
                `孤儿来源应在产生端排查（循环恢复/中断/followup/plan-mode/F1 空参数重试）。`,
            );
          }
          if (backfill.stripped.length > 0) {
            const detail = backfill.stripped
              .map((d) => `tool_use_id=${d.toolUseId} @msg#${d.messageIndex}`)
              .join(", ");
            log.error(
              "QUERY_LOOP",
              `发送前游离切除关卡触发：切除 ${backfill.stripped.length} 个游离 tool_result（无前置 tool_use，已移除，避免 OpenAI 400）：${detail}。` +
                `游离来源应在产生端排查（restoreSession slice / snipCompact / auto-compact 切断配对）。`,
            );
          }
          // §9.6：backfill 仍修不好 → 截断到最后完整配对的硬兜底已触发
          if (backfill.truncated) {
            log.error(
              "QUERY_LOOP",
              `发送前最终完整性兜底触发：backfill 后仍有配对破缺，已截断尾部 ${backfill.truncatedCount} 条消息到最后完整配对处（保证不发生 OpenAI 400）。` +
                `这是极端兜底，正常路径不应到达——请排查产生端。`,
            );
          }
        }
      }

      // ─── 冷缓存清理（§6.7：破坏性操作只在代价已经产生时做）───
      // 只有能**证明**缓存已冷（距最后一次可能触碰前缀的请求 ≥ 最长 TTL）才清；
      // 不知道 = 按热处理。判定是进程级的（api/cache-warmth.ts），不随 queryLoop 重建而清零 ——
      // 旧实现用 loop 级 lastResponseAt，每条用户消息的首轮都被误判成冷（轨迹 60 次 / 41 会话）。
      // 放在 getCleanedMessages 之前：清理决策写进 ctxMgr 会话状态，本轮发送副本、BeforeModel
      // 采样、raw.jsonl、prefix_break 看到的都是同一份已清理的前缀，之后每轮逐字节重放。
      // 只对 Anthropic 显式缓存做：OpenAI 族的隐式缓存 TTL 不可知，无法证明已冷。
      if (deps.getProviderName?.() === "anthropic") {
        const gapMs = msSincePrefixTouch();
        if (isPrefixCacheProvablyCold()) {
          const r = ctxMgr.applyColdCacheClear();
          emitColdCacheClearEvent(deps, sessionState.sessionId, {
            gap_ms: gapMs ?? -1,
            cleared: r.cleared,
            saved_chars: r.savedChars,
          });
          if (r.cleared > 0) {
            // 本轮 cache_read 下降是预期的（缓存本来就已过期），抑制一次误报
            notifyCompaction("main");
            log.info(
              "QUERY_LOOP",
              `缓存已冷（距上次请求 ${Math.round((gapMs ?? 0) / 60000)} 分钟）：清理 ${r.cleared} 项旧工具结果，释放 ${r.savedChars} 字符`,
            );
          }
        }
      }

      const cleanedMessages = ctxMgr.getCleanedMessages();
      // 工具延迟加载开启时，首轮只发非延迟工具（activeDefinitions），延迟工具由模型经
      // tool_search 按需激活后才进上下文；关闭时发全量（definitions），行为与历史一致。
      let toolDefs =
        toolCount > 0
          ? toolSearchEnabled
            ? toolRegistry.activeDefinitions()
            : toolRegistry.definitions()
          : undefined;
      if (toolDefs && mcpToolsAtLoopStart) {
        const held = withholdLateMcpTools(toolDefs, mcpToolsAtLoopStart);
        toolDefs = held.defs;
        if (held.withheld.length > 0 && !lateMcpWithheldLogged) {
          lateMcpWithheldLogged = true;
          log.info(
            "TOOL_SEARCH",
            `本次任务中途新连上 ${held.withheld.length} 个 MCP 工具，下一条用户消息起可见（保工具区前缀缓存）`,
          );
        }
      }
      log.llmRequest(
        config.provider,
        config.model,
        cleanedMessages.length,
        toolDefs?.length ?? 0,
        config.maxTokens,
      );

      // ─── System Reminder 注入（对标 Claude Code 每轮注入）───
      // 注意: getCleanedMessages 返回浅拷贝数组，消息对象仍是 ctxMgr 引用。
      // 这里不对 cleanedMessages 做 in-place 修改，而是构建新的 messages 数组。
      let finalMessages = stripTrailingInternalAck(cleanedMessages);

      // 收集本轮要注入的 system-reminder 片段（plan 提醒 + todo 回注 + 背景元信息…）。
      //
      // ambient 档：背景元信息，注入到**用户指令之后**（见 reminder-inject.ts 不变量 2）。
      // 2026-07-29 实测事故：所有片段一律前置时，真实 /commit 指令被顶到 user message 的
      // 40% 偏移，模型第一眼看到的是工具列表和 MCP 说明，转而抓记忆索引标题当用户意图。
      const reminderParts: string[] = [];
      // critical 档：止损阀，保持前置（"必须在被冻结快照带偏前先读到实时事实"）。
      // 只在 tool_result 轮触发、彼时无用户新指令，故前置不会淹没任何东西。
      // ⚠️ 新增成员前先读 reminder-inject.ts 的 ReminderTiers.critical 注释。
      const criticalReminderParts: string[] = [];

      // 缺口 A：上下文压力告知（使用率超阈值才注入）。
      // usagePercent / remaining 已在上方"上下文使用率监控"段算出（loop.ts:146-147）。
      // 走每轮 reminder 通道（随消息流、抗缓存、抗 compact），给模型"落盘窗口"——
      // 让它在 compact 真正发生前主动收尾 / 落盘关键结论 / 收敛输出，而非被 harness
      // 背着突然压缩、丢失尚未落盘的中间结论。低于阈值返回 null，不刷屏。
      //
      // cadence 节流（对话重播/截断幻觉修复，对标 permission mode reminder）：
      // pressure 文案里嵌实时百分比，逐字节去重（decideNagInjection）对它无效——连续两轮
      // 百分比不同即被判"有变化"照注不误。故改按档位 cadence：升档（warn→urgent 或首次达标）
      // 强注入一次；同档持续则每 CONTEXT_PRESSURE_REMINDER_INTERVAL 轮才重述一次。这样长任务
      // 卡在 80-90% 时不会每轮把同一条安抚提醒注入成"幻影用户消息"（弱模型误判截断/重播根因）。
      // 注：本项目比 CC 多做这层——CC 靠"纯安抚文案免节流"，但本项目提醒走 user 通道且需兼容
      // DeepSeek 等对重复敏感的弱模型（有误判实证），故加 cadence 收敛，属"比标杆多一层防护"。
      {
        const level = contextPressureLevel(usagePercent);
        if (level) {
          // 审计第 9 条：lastSeenContextPressureLevel 上移到 SessionState（跨消息持久）。
          // 原挂在每条消息重建的 LoopState 上 → 每条消息开局 undefined →
          // `undefined !== "warn"` 必为 changed=true → 每条新消息首轮都强注入压力提醒。
          // 上移后只有真正升档（warn→urgent 或首次达标）才 changed=true。
          const lastLevel = sessionState.get("lastSeenContextPressureLevel") as
            | "warn"
            | "urgent"
            | undefined;
          const changed = lastLevel !== level;
          const turnsSincePressure = state.turnCount - (state.lastContextPressureReminderTurn ?? 0);
          if (changed || turnsSincePressure >= CONTEXT_PRESSURE_REMINDER_INTERVAL) {
            const pressureReminder = buildContextPressureReminder(usagePercent, remaining);
            if (pressureReminder) {
              reminderParts.push(pressureReminder);
              state.lastContextPressureReminderTurn = state.turnCount;
            }
          }
        }
        // 无论是否注入都刷新档位基线（含脱离阈值回落到 undefined 的情况，
        // 下次再升到 warn/urgent 能重新识别为 changed 强注入一次）。
        sessionState.set("lastSeenContextPressureLevel", level);
      }

      // 缺口 C：permission mode 每轮可见（覆盖 plan 之外的所有 mode 切换）。
      // 根因：mode 指南只进被 5 分钟缓存冻结的 system prompt，运行时切 acceptEdits /
      // readonly / dontAsk 等不刷新，模型上下文里仍是会话启动时的旧 mode。
      // plan mode 另有 getPlanModeReminder 每轮注入兜住，故这里跳过 plan 避免重复。
      // delta 策略：mode 与上轮不同的那一轮强注入（防时机缺失）；非 default mode 持续时
      // 每 N 轮低频重述一次（防遗忘）。default mode 不注入（无额外约束）。
      //
      // 去重（负收益防线审计 发现 4，2026-07-30）：周期性重述那一路**接入逐字节去重**。
      // 实测它是所有周期性提醒里注入最频繁的一条（34/481 = 7.1%，8 个会话），而 34 条文案
      // 去重后只有 1 种——145 字符 × 34 次的零新信息重复注入，正是"幻影用户消息 → 弱模型
      // 误判对话被截断/重播"的根因（见 context-pressure.ts:41-45 同源分析）。
      // 与 pressure 的差异是关键：pressure 文案嵌实时百分比、去重天然失效（只能靠 cadence），
      // 而 mode 文案在同一 mode 下恒定，去重 100% 适用——这条恰是"去重完全适用却没接"的场景。
      // changed=true（mode 刚切换）仍强注入：那一次有真实时机价值，且切换本身就是新信息。
      //
      // 补齐另一半（负收益防线审计 发现 4，2026-07-30）：上一轮只给"周期性重述"接了去重，
      // "切换通告"那一路仍逐字节重复了 37 次。根因是 `lastSeenPermissionMode` 初值为 undefined
      // 导致**每会话首轮必然 changed=true**——实测 24 个会话全程都在同一个 mode 下跑、mode
      // 从未在会话中途变过，三个会话 turn#1 的注入内容逐字节完全相同。
      // 上一轮注释说"切换本身就是新信息"，这个前提对**真实切换**成立，对**首轮基线初始化**
      // 不成立：首轮 system prompt 正是本会话第一次构造（未被 5 分钟缓存冻结），里面已含
      // mode 行为指南，此时再注入一条等价提醒是零新信息。
      // 故区分两者：baseline（lastSeenPermissionMode 尚无值）不算切换、首轮不注入；
      // 只有已有值且发生变化才是运行时真切换。
      if (deps.getCurrentPermissionMode) {
        const mode = deps.getCurrentPermissionMode();
        if (mode && mode !== "default" && mode !== "plan") {
          // 审计第 9 条：lastSeenPermissionMode 上移到 SessionState（跨消息持久）。
          // 原挂在每条消息重建的 LoopState 上 → 每条消息开局 lastSeen 又变 undefined
          // → isBaseline=true → 跨消息的真实 mode 切换（A→B）永远检测不到（每条
          // 消息首轮都被当基线）。上移后只有会话真正首轮才是基线，后续消息能识别
          // lastSeen 已有值 → changed 检测生效。
          //
          // 注意：lastPermissionModeReminderTurn / lastInjectedPermissionModeText
          // 必须留在 LoopState（与 turnCount 同生命周期）——它们依赖 turnCount 计
          // cadence 间隔，若也上移到 sessionState，跨消息时 turnCount 归零会导致
          // turnsSinceMode 算出负数（cadence 永不触发）、去重会挡死 cadence 重述。
          const lastSeen = sessionState.get("lastSeenPermissionMode") as string | undefined;
          const isBaseline = lastSeen === undefined;
          const changed = isRuntimeModeSwitch(lastSeen, mode);
          if (isBaseline) {
            // 基线那一轮不注入，并把周期性重述的 cadence 锚在此刻：
            // 否则恢复会话（turnCount 已 ≥ 间隔）首轮会立刻触发一次"到期"重述，
            // 又变成首轮零新信息注入（system prompt 刚构造，已含同一份指南）。
            state.lastPermissionModeReminderTurn = state.turnCount;
          }
          const turnsSinceMode = state.turnCount - (state.lastPermissionModeReminderTurn ?? 0);
          if (!isBaseline && (changed || turnsSinceMode >= PERMISSION_MODE_REMINDER_INTERVAL)) {
            const modeReminder = buildPermissionModeReminder(mode, changed);
            // 周期性重述：与上次注入逐字节相同 → 零新信息 → 跳过（但仍推进 cadence，
            // 否则下一轮立刻又算"到期"，白重算一遍）。切换那一轮无条件放行。
            const isDuplicate =
              !changed &&
              modeReminder !== null &&
              modeReminder === state.lastInjectedPermissionModeText;
            if (modeReminder && !isDuplicate) {
              reminderParts.push(modeReminder);
              state.lastPermissionModeReminderTurn = state.turnCount;
              state.lastInjectedPermissionModeText = modeReminder;
            } else if (isDuplicate) {
              state.lastPermissionModeReminderTurn = state.turnCount;
            }
          }
        }
        // 无论是否注入，都刷新"上轮 mode"基线（含切回 default 的情况，下次再切走能识别为 changed）
        sessionState.set("lastSeenPermissionMode", mode);
      }

      // Plan Mode 提醒（既有逻辑）
      if (deps.getPlanModeReminder) {
        const reminder = await deps.getPlanModeReminder();
        if (reminder) reminderParts.push(reminder);
      }

      // G1：LSP 诊断注入（对标 Claude Code 的诊断 Attachment 通道）。
      // 根因修复——collectDiagnosticText() 此前定义了却无人调用，语言服务器推送的实时
      // 诊断（类型错误/未定义符号等）从未进入模型上下文，整条 LSP 被动反馈链断在最后一公里。
      // 走每轮 reminder 通道（随消息流、抗缓存、抗 compact），与 todo/pressure 提醒同机制。
      // collectDiagnosticText 内部已做严重度过滤（仅 Error/Warning 注入）+ 跨轮次去重 + 限流，
      // 且只取主循环名下的文件（子代理编辑的文件归子代理，结束后才转回），故这里直接 push。
      // LSP 未配置 / 未就绪 / 无诊断时返回 null，不注入、不报错（降级正常）。
      //
      // 能力对齐门控：仅当具备 edit/write 工具时才注入诊断——诊断是给"能改代码的 agent"看的。
      // 这比 CC 的"有 Bash 才注入"更贴合本意（本项目靠 edit/write 修诊断、不依赖 bash）；
      // 纯只读会话不会被诊断噪音打扰。
      {
        const hasEditCapability = !!(toolRegistry.get("edit") || toolRegistry.get("write"));
        const diagnosticText = hasEditCapability ? collectDiagnosticText() : null;
        if (diagnosticText) {
          // 显式带围栏（P0-a）：injectReminders 有兜底包裹，但这里自己带上让意图显式化。
          // 尤其重要的是**别再用 `#` markdown 标题开头**——原文案 `# LSP 诊断…` 与用户
          // prompt 的 `# Commit:` 形态完全混同，是 2026-07-29 那次"模型分不清谁在说话"
          // 的三处裸注入之一。
          reminderParts.push(
            `<system-reminder>\n` +
              `LSP 诊断（来自语言服务器的实时反馈，非用户输入）：\n\n${diagnosticText}\n\n` +
              `以上是语言服务器对你刚编辑文件的实时分析结果。请关注其中的 Error / Warning，` +
              `在后续工作中修复这些问题；若与当前任务无关可暂不处理，但不要无视真实的类型/语法错误。\n` +
              `</system-reminder>`,
          );
          log.info("QUERY_LOOP", "G1：注入 LSP 诊断反馈");
        }
      }

      // 「标了 completed 又返工」提醒（todo-rework.ts）：上一轮工具执行时登记、这里消费。
      // 走 reminder 通道而不是写进 tool_result——命中在执行完之后才判定，且不该污染工具输出。
      {
        const reworkReminder = drainTodoReworkReminder(getTodoReworkState(sessionState));
        if (reworkReminder) {
          reminderParts.push(reworkReminder);
          // 返工提醒与 completed 下降同属「振荡」，并入同一个计数（发现 2b，供 D2 升级阶梯消费）
          const gateBudget = sessionState.get(TODO_GATE_BUDGET_KEY) as TodoGateBudget | undefined;
          if (gateBudget) {
            sessionState.set(TODO_GATE_BUDGET_KEY, {
              ...gateBudget,
              oscillations: gateBudget.oscillations + 1,
            });
          }
          log.info("QUERY_LOOP", "清单返工提醒：已完成项对应的文件被再次修改");
          if (deps.traceAppendEvent) {
            try {
              deps.traceAppendEvent({
                event: "TodoReworkDetected",
                session_id: sessionState.sessionId,
                timestamp: new Date().toISOString(),
                data: { ...turnMetrics(state, sessionState, promptSeq) },
              });
            } catch {
              /* trace 写入失败不阻断主循环 */
            }
          }
        }
      }

      // P0-2：todo 每隔 N 轮回注完整清单（对标 claude-code attachments.ts）。
      // 根因 1 修复——todo 写完即沉没、只喂 TUI、从不回注 LLM，弱模型靠工作记忆追踪必然遗漏。
      // 触发条件：有未完成项 + 距上次 todo_write ≥ TURNS_SINCE_WRITE 轮 **且** 距上次回注
      // ≥ TURNS_BETWEEN_REMINDERS 轮（两个条件是 AND，见 shouldInjectTodoReminder）。
      // 压缩后另有一条独立旁路（todoReminderPendingAfterCompact）不受这两个阈值管辖。
      if (deps.getTodoState) {
        const todoState = deps.getTodoState();
        // ─── 2026-08-01 修复 5：进度快照必须覆盖**终态** ───
        //
        // 旧实现把落盘整块放在 `countUnfinished(todos) > 0` 里面，于是**全部完成时跳过落盘**，
        // `~/.sid-code/progress/<id>.md` 永久停在最后一次未完成态。这次排查就吃了这个亏：
        // 残留文件写着 `0 已完成 / 18 待办`，而它无法自证是"真没推进"还是"推进了但终态没落盘"
        // （本例只能靠 writeVersion 语义交叉验证才敢定性）。快照是北极星「底座·可度量」的
        // 一部分——量不准就等于拿有系统误差的尺子量自己的改动效果。
        //
        // 故把落盘提到 unfinished 判定**之外**：只要 writeVersion 变了就落盘，无论是否已全完成。
        //
        // 且必须读 `getTodoTerminalState`（事实语义）而非 `getTodoState`（展示语义）——发现 4a：
        // TodoWriteTool 在全部完成时清空 `currentTodos`（TUI 面板收起是刻意设计），于是
        // `getTodoState()` 返 null，光把落盘提到外面**仍然拿不到终态**，修复 5 会静默失效。
        // 未提供该 dep 时回退到 getTodoState（向后兼容，只是拿不到全完成终态）。
        const todoFactState = deps.getTodoTerminalState?.() ?? todoState;
        // 「本轮清单有推进」只判定**一次**，两个消费方（落盘/埋点 + 下方 gate 预算复位）共用。
        // 不能各自现算：基线 `lastSeenTodoWriteVersion` 一旦被前者写掉，后者就永远读到 false
        // （gate 预算再也不会复位）；反之若只在后者里写，全部完成时前者被跳过 → 基线不推进 →
        // 每轮重复落盘同一份终态。一次判定 + 末尾统一推进基线，两个坑一起避掉。
        //
        // 基线读 SessionState 而非 LoopState（2026-08-02 修复）：LoopState 每条用户消息重建，
        // 基线会归零成 undefined，于是 writeVersion 没变也判 true —— 实测 writeVersion 恒定 3
        // 的会话，第二条用户消息后 TodoProgressAdvanced 从 1 虚增到 2，progress 也重复落盘。
        // "清单有没有推进"是跨用户消息的会话级事实，放不进每消息重建的 LoopState。
        const lastSeenWriteVersion = sessionState.get(LAST_TODO_WRITE_VERSION_KEY) as
          | number
          | undefined;
        const todoAdvanced = !!todoFactState && lastSeenWriteVersion !== todoFactState.writeVersion;
        if (todoFactState && todoFactState.todos.length > 0) {
          if (todoAdvanced) {
            // P1-4 item 1：落盘快照带上实测进展。这个文件是**跨会话续做时的唯一进度来源**
            // （app.ts 的 loadProgressMarkdown），只写 todo 口径的话，"改了 7 个文件但一项
            // 都没标"会渲染成"0 已完成"，假信号一路传染到下一个会话。
            const snap = snapshotFromTodos(
              sessionState.sessionId,
              todoFactState.todos,
              [],
              getMeasuredProgress(sessionState),
            );
            persistProgress(snap);
            // 可观测性（§8.3）：writeVersion 增长是**唯一能直接量"实时性"的指标**，此前完全无埋点。
            // 缺陷现场只能靠"progress 文件只写过 1 次"反推清单只更新过 1 次——那是间接证据。
            // 有了这条事件，"清单更新了几次 / 分布在哪些轮次"可被 trace-digest 直接统计。
            emitTodoProgressEvent(deps, sessionState.sessionId, {
              ...turnMetrics(state, sessionState, promptSeq),
              writeVersion: todoFactState.writeVersion,
              total: todoFactState.todos.length,
              completed: todoFactState.todos.filter((t) => t.status === "completed").length,
              unfinished: countUnfinished(todoFactState.todos),
              blocked: blockedTodos(todoFactState.todos).length,
            });
            // 返工检测：把上次写入以来落盘的文件归到本次新完成的项上（见 todo-rework.ts）
            recordTodoWrite(getTodoReworkState(sessionState), todoFactState.todos);
          }
        }
        if (todoState && todoState.todos.length > 0 && countUnfinished(todoState.todos) > 0) {
          // writeVersion 变化 → 模型刚更新过清单，刷新 gate 预算、本轮不重复回注。
          //
          // 注意这里**不再**刷新回注 cadence：cadence 的基准已改为"距上次 todo_write 多少轮"，
          // 由 getTodoReminderTurnCounts 从消息历史现算（下方），不需要也不该在这里手工记基线。
          if (todoAdvanced) {
            // nag 计数与 end_turn gate 预算**同一判据**：completed 创新高（或换清单）才算推进。
            // 旧实现在 writeVersion 变化时就清零——只改措辞、或 1→0→1 的返工振荡都会让
            // work-log 封顶永不生效（会话 20261020-110542-ce7ea52e 发现 2b）。
            if (advanceSessionTodoGateBudget(sessionState, todoState.todos).progressed) {
              state.progressNagCount = 0;
            }
            // P1-4 item 2：模型确实更新了清单 = 记账催促奏效了 → 清零条件封顶预算，
            // 让它在下一段"有进展但又忘记记账"时还能再催。不清零的话一个长会话里
            // 只要早期催满 2 次，后面就永久哑火。
            sessionState.set(TODO_BOOKKEEPING_NAG_COUNT_KEY, 0);
          } else {
            // ─── 2026-08-01 修复 1：改为无状态消息扫描（对标 attachments.ts:3212-3291）───
            //
            // 旧实现：`LoopState` 计数器 + 逐字节去重 + 封顶 2 次。实测 60 轮停滞会话**只注入 1 次**，
            // 且封顶（cap=2）连触发机会都没有——去重先把通道锁死了（`buildTodoReminder` 的文本只随
            // 清单内容变化，模型一停滞文本就恒定 → 从第 2 次起永久静音）。而"模型停滞"恰恰是最需要
            // 催更的时刻：这道防线把催更与"无需催更"判反了，属**防线过度生效导致主功能失效**。
            //
            // 现在：两个条件都从消息历史现算，纯节流、无去重、无封顶。两处收益——
            //   1. 跨用户消息不失忆（LoopState 每条用户消息重建，计数器会归零，历史不会）；
            //   2. `TURNS_SINCE_WRITE` 这个**死常量**（旧实现从未引用它，只在注释里提）真正参与判定。
            //
            // ⚠️ 与对标的偏离，以及 `todoReminderPendingAfterCompact` 为什么**必须保留**：
            // 对标把 reminder 本身作为 attachment 消息写进历史，于是"上次注入是哪轮"也记在历史里，
            // 压缩连带删除 → 自动重注，不需要任何补丁位。本项目不能那么做（`reminder-inject.ts`
            // 不变量 3 有三处实测事故背书 + 哨兵测试：注入产物写回 ctxMgr 会同时引发 TUI 泄漏、
            // 压缩把工具列表当"用户最初的请求"、reminder 逐轮累积）。
            // 我们把注入锚点放在 SessionState，它**不会**被压缩清掉——所以"压缩后自动重注"这个
            // 属性拿不到，仍需那 8 处显式置位兜住：压缩把 todo 清单从上下文里抹掉后，
            // `turnsSinceLastReminder` 可能还没到期，此时不强制重注，清单就在模型视野里永久消失。
            const counts = getTodoReminderTurnCounts(cleanedMessages, {
              absoluteTurn: sessionState.getAbsoluteTurn(),
              lastReminderAbsoluteTurn: sessionState.get(LAST_TODO_REMINDER_TURN_KEY) as
                | number
                | undefined,
            });
            const afterCompact = state.todoReminderPendingAfterCompact === true;
            const throttleSaysYes = shouldInjectTodoReminder(counts, {
              turnsSinceWrite: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE,
              turnsBetweenReminders: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
            });
            // ─── P1-4 item 2：条件式封顶（绑真实进展，刻意不是无条件 cap）───
            //
            // 判据分两态，详见 reminder-throttle.ts decideTodoNagInjection 的注释表：
            //   无真实进展（模型真卡住）→ 催更是主功能，**永不封顶**（保住 2026-08-01 修复）；
            //   有真实进展但清单没动 → 催的只是"记账"，催 N 次无效即停手。
            // 后者才是本次事故的形态：模型在改文件、观测值在降，却被每 8 轮催去更新清单。
            //
            // afterCompact 旁路**不受封顶管辖**：压缩把清单从上下文里抹掉后若不强制重注，
            // 清单会在模型视野里永久消失——那是信息丢失，不是催促噪音，两者不能共用预算。
            const measuredForNag = getMeasuredProgress(sessionState);
            const bookkeepingNagCount =
              (sessionState.get(TODO_BOOKKEEPING_NAG_COUNT_KEY) as number | undefined) ?? 0;
            const todoNagDecision = decideTodoNagInjection({
              hasRealProgress: hasRealProgress(measuredForNag),
              bookkeepingNagCount,
            });
            if ((throttleSaysYes && todoNagDecision.inject) || afterCompact) {
              reminderParts.push(buildTodoReminder(todoState.todos));
              state.todoReminderPendingAfterCompact = false;
              if (todoNagDecision.countedAsNoProgress) {
                sessionState.set(TODO_BOOKKEEPING_NAG_COUNT_KEY, bookkeepingNagCount + 1);
              }
              // 锚点存 SessionState（跨用户消息持久），与 lastSeenContextPressureLevel /
              // lastSeenPermissionMode 同构（审计第 9 条：LoopState 每消息重建，放不住跨消息事实）。
              sessionState.set(LAST_TODO_REMINDER_TURN_KEY, sessionState.getAbsoluteTurn());
              log.info(
                "QUERY_LOOP",
                `P0-2：回注 todo 清单（${countUnfinished(todoState.todos)} 项未完成，` +
                  `距上次 todo_write ${counts.turnsSinceLastTodoWrite} 轮）`,
              );
              // 埋点语义随之改变（方案 §8.3 已点破）：不再有 nagCount/cap 概念，
              // 改记两个扫描出来的距离，用于事后核对阈值是否过紧/过松。
              emitNagInjectedEvent(deps, sessionState.sessionId, {
                kind: "todo",
                ...turnMetrics(state, sessionState, promptSeq),
                afterCompact,
                // P1-4 item 2：条件封顶必须可观测，否则"它到底有没有拦住/有没有误伤"
                // 只能靠离线重放猜（emitNagInjectedEvent 顶部注释记录的同一个教训：
                // 只有 log.info 不落盘时，封顶行为在现网完全不可见）。
                //
                // ⚠ 只在**封顶真正生效的那一态**（有真实进展 → 催记账）才带这两个字段。
                // 无进展态永不封顶，此时若照样上报 nagCount/cap，离线分析会以为本通道
                // 存在封顶行为——那正是 2026-08-01 删字段时要避免的误导
                // （见 todo-realtime-integration.test.ts「不带封顶字段」那组断言）。
                // 字段在/不在本身就携带信息：在 = 当时处于记账催促态。
                ...(todoNagDecision.countedAsNoProgress
                  ? {
                      nagCount: bookkeepingNagCount + 1,
                      cap: MAX_TODO_BOOKKEEPING_NAGS,
                      countedAsNoProgress: true,
                    }
                  : {}),
                turnsSinceLastTodoWrite: Number.isFinite(counts.turnsSinceLastTodoWrite)
                  ? counts.turnsSinceLastTodoWrite
                  : -1,
                turnsSinceLastReminder: Number.isFinite(counts.turnsSinceLastReminder)
                  ? counts.turnsSinceLastReminder
                  : -1,
              });
            }
          }

          // P2-2：每隔 PROGRESS_REMINDER_INTERVAL 轮额外回注一次"工作日志摘要"，
          // 强调持久进度 + 别重复已完成项（与 P0-2 的 todo 原文回注互补）。
          const turnsSinceProgress = state.turnCount - (state.lastProgressReminderTurn ?? 0);
          if (turnsSinceProgress >= PROGRESS_REMINDER_INTERVAL) {
            // P1-4 item 1：回注摘要带上实测进展——这是消掉"已完成 0 项"假信号的关键路径
            // （事故窗口里模型每 8 轮读到的就是这段文本）。
            const measured = getMeasuredProgress(sessionState);
            const snap = snapshotFromTodos(sessionState.sessionId, todoState.todos, [], measured);
            const progressReminder = buildProgressReminder(snap);
            // 去重 + 封顶（对话重播幻觉修复 Fix 1/2）：与 todo 回注同机制。P2-2 摘要在
            // todo 长期停滞时内容几乎逐字节相同（idx 41/87/112 就是这样的三连重复），
            // 是造"幻影用户消息"的重灾区，必须去重 + 封顶。
            //
            // ─── 2026-08-02：方案 §9.1「work-log 是否同病」核验结论 = 同现象、不同结论，刻意保留 ───
            //
            // 实测本通道与 todo 通道**症状完全一样**：60 轮停滞只注入 1 次、cap=2 从未用上
            // （去重先锁死）。但 todo 那边的修法（删去重+封顶）**不能照搬到这里**，判据是
            // 「这条通道停滞时还有没有独立价值」：
            //
            //   两份文案都由同一份 todo 清单派生，信息量高度重叠——todo 报"[completed] 甲 /
            //   [in_progress] 乙 + 仍有 N 项未完成"，work-log 报"已完成 1 项：甲 / 仍待办 2 项：
            //   乙；丙 / 当前进行中：乙"，连"别臆造新工作"那句收尾都近乎同义复述。
            //
            // todo 通道现在已是无去重无封顶、每 8 轮必达（实测停滞时在轮 1/9/17/25/33 稳定注入）。
            // 停滞场景下 work-log 能提供的增量信息≈0，把它也放开只会让同一份清单在同一段停滞里
            // 被复述两遍——那正是 `reminder-throttle.ts` 顶部记录的"弱模型把重复注入误判成用户又
            // 发了半句话"的成因，且这次是**双通道**互相加重。
            //
            // 即：todo 那边去重是「防线过度生效害死主功能」（催更通道被锁死 = 没有替代品）；
            // 这边去重是「防线正好挡住纯冗余」（主功能已由 todo 通道承担）。同一机制在两条通道
            // 上一留一删不是不一致，是因为**主功能归属不同**。若日后 todo 通道再次被削弱，
            // 这条判据随之失效，需重新评估。
            // 封顶预算用**专属**的 progressNagCount，与 todo 回注彼此独立——原先共用时，
            // todo 先注满 2 次即让本通道"首次注入就被抑制"（它一次都没注过就没额度了）。
            const decision = decideNagInjection({
              candidate: progressReminder,
              lastInjectedText: state.lastInjectedProgressReminderText,
              noProgressNagCount: state.progressNagCount ?? 0,
            });
            if (decision.inject && progressReminder) {
              reminderParts.push(progressReminder);
              state.lastProgressReminderTurn = state.turnCount;
              state.lastInjectedProgressReminderText = progressReminder;
              if (decision.countedAsNoProgress) {
                state.progressNagCount = (state.progressNagCount ?? 0) + 1;
              }
              log.info(
                "QUERY_LOOP",
                `P2-2：回注工作日志摘要（已完成 ${snap.completed.length} / 待办 ${snap.pending.length}，无进展催促 ${state.progressNagCount}/${MAX_NO_PROGRESS_NAGS}）`,
              );
              emitNagInjectedEvent(deps, sessionState.sessionId, {
                kind: "work-log",
                ...turnMetrics(state, sessionState, promptSeq),
                nagCount: state.progressNagCount ?? 0,
                cap: MAX_NO_PROGRESS_NAGS,
                countedAsNoProgress: decision.countedAsNoProgress,
                afterCompact: false,
              });
            } else {
              // 跳过注入仍推进 cadence，避免每轮重算
              state.lastProgressReminderTurn = state.turnCount;
            }
          }
        }
        // 基线在此**统一**推进（两个消费方都读完之后）。放在最外层是刻意的：
        // 全部完成时上面那个 `countUnfinished > 0` 块整体跳过，若基线跟着写在块内，
        // 就永远追不上 writeVersion → 终态快照每轮重复落盘。
        if (todoAdvanced && todoFactState) {
          sessionState.set(LAST_TODO_WRITE_VERSION_KEY, todoFactState.writeVersion);
        }
      }

      // 假设纪律首轮引导（修复"防线零触发"）：检测到调查性上下文时，在本条用户消息的
      // 首轮注入一次性强推提醒，让模型在任务开头就想到用 hypothesis_register 登记判断。
      // 时序关键：queryLoop 由 engine.submitMessage 每条用户消息调用一次、state 每次新建、
      // turnCount 首轮自增为 1，故 turnCount===1 即"本条用户消息的首轮"，extractLastUserInput
      // 取到的正是当前这条消息——天然覆盖"对话中途才下达核查任务"的场景。
      // hypothesisGuideInjected 与 turnCount===1 双保险，保证同一条消息内不重复注入。
      // AND 检测（路径+动词）+ system-prompt 常驻引导兜底，详见
      // docs/bugfixes/todo/最终结论与TODO-彻底修复防线零触发.md。
      // 2026-08-01：机制默认关闭（SID_ENABLE_HYPOTHESIS=1 才注册工具），此时引导必须
      // 一并静默——否则会催模型去调一个不存在的工具（必然 tool_use 失败）。
      // 判据用 ledger 可达性而非直接读 env：与下面 judgment 通道（`if (ledger && ...)`）
      // 同源，只有一处事实源，不会出现"env 关了但某条通道漏改"的漂移。
      if (
        state.turnCount === 1 &&
        !state.hypothesisGuideInjected &&
        deps.getHypothesisLedger?.() != null
      ) {
        const userText = extractLastUserInput(ctxMgr);
        if (detectInvestigationContext(userText)) {
          // 缺口3 修复项2：turn-1 通道降级为极简一句。完整引导（含"为什么要登记"
          // "怎么写证伪条件"）交给紧贴判断的那次事件驱动注入——实测 13 次 turn-1 注入
          // 对应的首次 register 都发生在 turn 2-12，完整篇幅投在这里是投在了低效时机。
          reminderParts.push(buildMinimalGuideReminder());
          state.hypothesisGuideInjected = true;
          log.info("QUERY_LOOP", "注入假设纪律首轮引导（命中调查性上下文）");
          // 可观测性：把"首轮引导注入命中"落成结构化 trace 事件（events.jsonl），
          // 让命中率可被 trace-digest 自动统计——否则只能离线 grep raw.jsonl。
          // 与 GoalGateDecision 同机制（goal-gate.ts:67），try/catch 兜底不阻断主循环。
          if (deps.traceAppendEvent) {
            try {
              deps.traceAppendEvent({
                event: "HypothesisGuideInjected",
                session_id: sessionState.sessionId,
                timestamp: new Date().toISOString(),
                data: {
                  // 缺口7：三口径一起落（turn 兼容 / absoluteTurn 可比较 / promptSeq 可还原回绕）
                  ...turnMetrics(state, sessionState, promptSeq),
                  // 缺口3：区分两条注入通道。`turn-1` 是任务开头的兜底引导，`judgment` 是
                  // 紧随判断的事件驱动引导。不分开则"改时机后采纳率提升多少"无法归因。
                  trigger: "turn-1",
                  userTextPreview: userText.slice(0, 200),
                },
              });
            } catch {
              /* trace 写入失败不阻断 */
            }
          }
        }
      }

      // 环节③ 机制2（矛盾中断·注入端）：上一轮检出的矛盾命中，本轮注入高优先级提醒，
      // 逼模型停下来用 hypothesis_challenge 裁决。走 critical 档（前置于用户指令），
      // 让它在所有提醒里最先被读到——抗沉没成本的关键时刻不能被淹没。
      //
      // 原实现是 `reminderParts.unshift(...)`。unshift 排出的优先级此前**已经失效**：
      // deferred-tools 走第二次 injectReminders 调用、整体压在第一次注入的内容之前
      // （实测偏移 deferred=0 / MCP=366 / 用户指令=1075，注入顺序与代码书写顺序相反）。
      // 改分档 + 单次调用后，优先级语义才真正生效。
      if (state.pendingContradictions && state.pendingContradictions.length > 0) {
        criticalReminderParts.push(buildContradictionReminder(state.pendingContradictions));
        log.info(
          "QUERY_LOOP",
          `注入矛盾中断提醒（${state.pendingContradictions.length} 条假设待裁决）`,
        );
        state.pendingContradictions = undefined; // 注入后清空，避免重复
      }

      // 缺陷3（连续推翻 → 换策略·注入端）：上一轮裁决后检出"连推 N 条且零 confirm"，
      // 本轮经 reminder 通道注入换取证手段的提示。走 critical 档（前置于用户指令）——
      // 越早读到越省成本，轨迹 20260730-142920-d98e7f16 里模型连推 6 条才自己反应过来，
      // 中间白烧了约 30 分钟。一次性：注入后清空 pending，且 state 侧有 nagged 永久标志。
      if (state.pendingHypothesisStrategyShift !== undefined) {
        criticalReminderParts.push(
          buildStrategyShiftReminder(state.pendingHypothesisStrategyShift),
        );
        log.info(
          "QUERY_LOOP",
          `注入换策略提示（连续推翻 ${state.pendingHypothesisStrategyShift} 条假设且零确认）`,
        );
        state.pendingHypothesisStrategyShift = undefined;
      }

      // 缺口3（事件驱动引导·注入端）：上一轮检出"刚形成未登记判断"，本轮注入登记引导。
      // 走 critical 档：这条提醒的全部价值在于"紧贴那个判断到达"——被压到用户指令之后
      // 就退化成了又一条泛化提示，正是本缺口要修的时机错配。
      if (state.pendingJudgmentGuide) {
        criticalReminderParts.push(buildJudgmentGuideReminder());
        log.info("QUERY_LOOP", "缺口3：注入假设登记引导（紧随刚形成的判断，仅一次）");
        state.pendingJudgmentGuide = undefined;
      }

      // 缺口2 层次2（假设登记表空转 → 续期提醒·注入端）：上一轮检出登记表已连续 N 轮
      // 空转，本轮注入一次轻量提示。走**普通档**而非 critical：它不是"手上有矛盾证据
      // 待裁决"这类紧急事项，只是一个时机提醒，不该抢在用户指令前面。会话级一次性
      // （标志挂 ledger.staleNagged，跨用户消息有效）。
      if (state.pendingHypothesisStaleReminder) {
        reminderParts.push(state.pendingHypothesisStaleReminder);
        log.info("QUERY_LOOP", "注入假设登记表续期提醒（中段空转，仅一次）");
        state.pendingHypothesisStaleReminder = undefined;
      }

      // 方向 2/4/6（git-status 快照冻结死循环止损阀·注入端）：上一轮检出"卡在只读命令上"，
      // 本轮经 reminderParts 注入携带实时 git 状态的收敛提醒。走 critical 档（前置于用户
      // 指令），确保模型在被冻结快照带偏前先读到实时事实。走 reminder 通道（仅本轮注入、不落历史、缓存友好），
      // 与 pendingContradictions 同机制，注入后清空避免重复。
      // 停滞升级 L1：上一个工具轮判定，走 ambient 档尾部通道（不动前缀，与其它 nag 同通道）
      if (state.pendingStallReminder) {
        reminderParts.push(state.pendingStallReminder);
        log.info("QUERY_LOOP", "停滞升级 L1：注入收敛提示");
        state.pendingStallReminder = undefined;
      }

      if (state.pendingStuckReminder) {
        criticalReminderParts.push(state.pendingStuckReminder);
        log.info("QUERY_LOOP", "注入无进展止损收敛提醒（实时 git 状态）");
        state.pendingStuckReminder = undefined;
      }

      // P1-4 item 3（低信息量空转·注入端）：上一轮检出"连续 N 轮只思考 + 同参同返回值的
      // 单标量命令"，本轮注入**可执行的替代命令**。走 critical 档（前置于用户指令）：
      // 事故里模型已连说 8 次"我要停止反复思考、直接动手"却仍在空转，说明它不缺决心而
      // 缺"下一条命令敲什么"——这条提醒的全部价值在于尽早被读到，压到用户指令之后
      // 就退化成了又一条泛化催促（正是本项要消掉的东西）。注入后清空避免重复。
      if (state.pendingLowYieldSpinReminder) {
        criticalReminderParts.push(state.pendingLowYieldSpinReminder);
        log.info("QUERY_LOOP", "P1-4：注入低信息量空转介入（含可执行替代命令）");
        state.pendingLowYieldSpinReminder = undefined;
      }

      // 方案③（思考发散·注入端）：上一轮检出的思考发散，本轮经 reminder 通道注入收敛提示。
      // 走 critical 档（前置于用户指令）——分析瘫痪时越早读到越好。注入后清空 pending 标记。
      if (state.pendingThinkingDivergenceReminder) {
        criticalReminderParts.push(buildThinkingDivergenceMessage(state.thinkingLenHistory ?? []));
        log.info("QUERY_LOOP", "方案③：注入思考发散收敛提示");
        state.pendingThinkingDivergenceReminder = false;
      }

      // P2-1（产出量停滞·注入端）：上一轮检出连续低产出，本轮经 reminder 通道注入软提醒。
      // 同属止损阀 → critical 档；但排在思考发散之后（本 push 位置即决定档内次序）——
      // 分析瘫痪比"可能卡住"更紧急。注入后清空 pending 标记。
      if (state.pendingOutputStallReminder) {
        criticalReminderParts.push(buildOutputStallMessage(state.outputVolumeHistory ?? []));
        log.info("QUERY_LOOP", "P2-1：注入产出停滞提醒");
        state.pendingOutputStallReminder = false;
      }

      // 【第四层·兜底】SID_MAX_TURNS 软阈值提醒（默认关闭，尊重"不打断长任务"偏好）。
      // 仅当显式设置 SID_MAX_TURNS=<正整数> 时启用：单条用户消息处理超过 N 轮时，一次性
      // 注入软提醒"已 N 轮，若已完成请收尾"。这是软提示、不强杀（不 yield done）——把决定
      // 权留给模型/用户，只补上交互模式 maxTurns=Infinity 场景下"完全没有自省信号"这个缺口。
      // 优先级最低（push），且一条消息内仅一次（softTurnLimitReminded 置位），不刷屏。
      {
        const softLimit = parseSoftTurnLimit(process.env.SID_MAX_TURNS);
        if (
          shouldRemindSoftTurnLimit(
            state.turnCount,
            softLimit,
            state.softTurnLimitReminded ?? false,
          )
        ) {
          reminderParts.push(buildSoftTurnLimitReminder(state.turnCount, softLimit!));
          state.softTurnLimitReminded = true;
          log.info(
            "QUERY_LOOP",
            `第四层：注入 SID_MAX_TURNS 软阈值提醒（第 ${state.turnCount} 轮，阈值 ${softLimit}）`,
          );
        }
      }

      // ─── /goal：目标状态周期回注（对标 Codex continuation.md）───
      // 通过 reminderParts 管道注入，不影响 system prompt → Prompt Cache 命中率不变。
      // 首轮必注入，之后每 N 轮回注一次。
      if (deps.getGoalState) {
        const goal = deps.getGoalState();
        if (goal && goal.status === "active") {
          // 更新轮次计数
          goal.turnsUsed++;
          goal.updatedAt = Date.now();
          deps.updateGoalState?.((g) => {
            g.turnsUsed = goal.turnsUsed;
            g.updatedAt = goal.updatedAt;
          });

          // 按间隔回注（首轮必注入，之后每 N 轮，compact 后强制注入）
          const turnsSinceGoalReminder = state.turnCount - (state.lastGoalReminderTurn ?? 0);
          const shouldInject =
            goal.turnsUsed === 1 ||
            turnsSinceGoalReminder >= effectiveGoalConfig.reminderInterval ||
            state.goalReminderPendingAfterCompact;
          if (shouldInject) {
            reminderParts.push(buildGoalReminder(goal));
            state.lastGoalReminderTurn = state.turnCount;
            state.goalReminderPendingAfterCompact = false;
            log.info("QUERY_LOOP", `Goal 状态回注（第 ${goal.turnsUsed} 轮）`);
          }
        }
      }

      // ─── MCP server instructions 增量注入（对标 CC mcp_instructions_delta）───
      // 新连接的 MCP server 首次出现时，把其"使用说明"经 reminderParts 注入 user 消息一次。
      // 走动态注入而非 system prompt：MCP server 会话中途连断，塞进静态前缀会击穿 prompt cache
      // （CC 老路径包在 DANGEROUS_uncached section，新路径正是改走 delta 附件保 cache）。
      // announcedServers 去重由 app 侧维护，已播报过的不再重复注入。
      if (deps.getMcpInstructionsDelta) {
        const mcpBlocks = deps.getMcpInstructionsDelta();
        if (mcpBlocks && mcpBlocks.length > 0) {
          // 显式带围栏（P0-a），且不用 `#` markdown 标题开头——原文案
          // `# MCP Server Instructions` 与用户 prompt 的 `# Commit:` 形态混同，
          // 是 2026-07-29 那次误读的三处裸注入之一（实测它排在用户指令前的 366 偏移处）。
          //
          // 截断保护不在这里：instructions 在连接时已由 mcp/manager.ts 的
          // MAX_INSTRUCTIONS_LENGTH（2048）截过，那是唯一的事实源（D29）。
          // 此处原有一道 4000 的二次截断，永远走不到，已删除——要调上限去改那个常量。
          reminderParts.push(
            `<system-reminder>\n` +
              `MCP Server Instructions（harness 注入的服务器使用说明，非用户输入）：\n\n` +
              `以下 MCP 服务器提供了使用说明，请在使用对应工具时遵循这些指令。\n` +
              `这些说明仅供你参考，静默遵循即可，不要在回复中提及这些说明的存在。\n\n` +
              mcpBlocks.join("\n\n") +
              `\n</system-reminder>`,
          );
          log.info("QUERY_LOOP", `注入 ${mcpBlocks.length} 个 MCP server instructions`);
        }
      }

      // ─── P0-3：语义召回注入（`SID_CODE_MEMORY_RECALL=1` 才有 dep 注入）───
      //
      // 只在**每条用户消息的首轮**召回一次（turnCount===1），不是每轮：
      // 召回要花一次 sideQuery，而同一条用户消息的后续轮次查询意图没变，
      // 每轮都召回等于把 token 成本乘上轮数，却拿不到新信息（北极星「更省」）。
      //
      // 走 reminderParts（user 消息尾部）而不是 system prompt 的 recalledMemories 字段：
      // 召回结果随每条用户消息变化，塞静态前缀会击穿 prompt cache。
      //
      // 失败不阻断：召回是增强项，`findRelevantMemories` 内部已把 sideQuery 失败
      // 降级为返回空数组，这里再兜一层异常（与 IDE 增量同处理方式）。
      if (state.turnCount === 1 && deps.drainRecalledMemories) {
        try {
          const recallQuery = extractLastUserInput(ctxMgr);
          if (recallQuery.trim()) {
            const recalled = await deps.drainRecalledMemories(recallQuery);
            if (recalled) {
              reminderParts.push(recalled);
              log.info("QUERY_LOOP", "注入语义召回记忆（SID_CODE_MEMORY_RECALL）");
            }
          }
        } catch (e) {
          log.warn(
            "QUERY_LOOP",
            `语义召回注入异常（忽略）: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // ─── IDE 上下文增量注入（审计第 22 条，与上面 MCP instructions 同一模式）───
      // IDE 选区 / @提及 原先只在 buildInitialSystemPrompt 采集一次，而 IDE 连接是后台异步的
      // （轮询至 30s 超时）→ 启动瞬间必然未连上，两处 rebuildSystemPrompt 也不采集，
      // 净效果是 IDE 上下文基本永远进不了模型。改在每轮拉增量：何时连上都能赶上，
      // 且落在 user 消息尾部而非静态前缀 → 选区变化不击穿 prompt cache。
      // 选区做指纹去重（同一份只注入一次）、@提及为消费语义，均在 drainIDEContextDelta 内。
      if (deps.drainIDEContextDelta) {
        try {
          const ideDelta = deps.drainIDEContextDelta();
          if (ideDelta) {
            reminderParts.push(ideDelta);
            log.info("QUERY_LOOP", "注入 IDE 上下文增量（选区/@提及）");
          }
        } catch (e) {
          log.warn(
            "QUERY_LOOP",
            `IDE 上下文增量注入异常（忽略）: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // G7：异步 hook 的 asyncRewake 回灌——后台 hook 进程 exit 2 时，其 stderr 在下一轮开始
      // 作为 system-reminder 注入，唤醒模型处理反馈（对标 CC async hook rewake）。
      if (deps.drainAsyncHookRewakes) {
        const rewakes = deps.drainAsyncHookRewakes();
        if (rewakes && rewakes.length > 0) {
          reminderParts.push(
            `<system-reminder>\n` +
              `以下异步 Hook 已在后台完成并返回了需要你处理的反馈（退出码 2）：\n\n` +
              rewakes.join("\n\n") +
              `\n</system-reminder>`,
          );
          log.info("QUERY_LOOP", `注入 ${rewakes.length} 个 asyncRewake hook 反馈`);
        }
      }

      // P3-2：Skill 增量 listing 注入（首轮全量、后续只增量已激活的条件/动态 skill）。
      // 走 reminderParts（user 消息，cache-friendly），不碰 system prompt 静态前缀 → 不击穿 prompt cache。
      if (deps.drainSkillListingDelta) {
        try {
          const skillDelta = deps.drainSkillListingDelta();
          if (skillDelta) reminderParts.push(skillDelta);
        } catch (e) {
          log.warn(
            "QUERY_LOOP",
            `skill 增量 listing 注入异常（忽略）: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // 工具延迟加载：注入 <available-deferred-tools> 提醒，告诉模型有哪些工具尚未加载、
      // 可经 tool_search 调出。不注入则模型对延迟工具完全无感知，整个延迟机制形同虚设
      // （对标 claude-code claude.ts deferredToolList 注入）。
      //
      // P2 delta 化（对标 CC `utils/toolSearch.ts` getDeferredToolsDelta）：原实现每轮**全量**
      // 重注，实测 11 轮请求里 10 轮内容逐字节相同（4204 字符 × 10 = ~3.8 万字符纯浪费），
      // 且每轮持续稀释用户指令权重。改为只播报增量：
      //   - added   ：本轮新出现的延迟工具（如新 MCP server 连上）
      //   - removed ：本轮消失的延迟工具（**仅**指工具真的没了；被 tool_search 激活的
      //               走 undeferred 静默路径，不播报——模型刚激活它自然知道，播报"已移除"
      //               反而误导，对标 CC 注释 `else: undeferred — silent`）
      //   - 无变化 ：不注入
      //
      // announced 集合挂 sessionState（跨消息持久）。这里踩过一次坑：挂 LoopState 的话每条
      // 新用户消息都会重建 → 集合归零 → 每条消息首轮又全量播报一次，delta 化形同白做
      // （同 lastSeenContextPressureLevel 的教训，见 loop.ts:658 注释）。
      if (toolSearchEnabled) {
        const deferredNames = toolRegistry.deferredToolNames();
        const announced =
          (sessionState.get("announcedDeferredTools") as Set<string> | undefined) ??
          new Set<string>();
        // compact 之后必须重新全量播报：历史里的播报记录被裁掉后，模型对延迟工具
        // 失去感知，只发增量会让它永远看不到那批工具（对标 CC 在 compact 路径的处理）。
        const needFullRebroadcast = state.deferredToolsPendingAfterCompact === true;
        if (needFullRebroadcast) {
          announced.clear();
          state.deferredToolsPendingAfterCompact = false;
        }

        const current = new Set(deferredNames);
        const added = deferredNames.filter((n) => !announced.has(n));
        // 已播报但现在不在延迟列表里：可能是被 tool_search 激活（undeferred，静默），
        // 也可能是工具真的下线（如 MCP server 断连）。二者无法从名单差异区分，
        // 且"激活"是模型自己的动作、"下线"再调用会自然报错——都不值得占注入预算。
        // 故一律静默，只把它们从 announced 移出，保证下次重新变成延迟工具时能再播报。
        const vanished = [...announced].filter((n) => !current.has(n));

        if (added.length > 0) {
          const isFull = needFullRebroadcast || announced.size === 0;
          // 显式带围栏（P0-a）：`<available-deferred-tools>` 是三处裸注入里字节量最大的一条，
          // 实测在 2026-07-29 那条轨迹里正好落在偏移 0（用户指令之前 1075 字符处）——
          // 模型第一眼看到的就是它。裸标签不足以表达"这不是人说的"，必须套 system-reminder。
          reminderParts.push(
            `<system-reminder>\n` +
              `<available-deferred-tools>\n${added.join("\n")}\n</available-deferred-tools>\n` +
              (isFull
                ? `以上工具尚未加载到上下文。`
                : `以上工具**新增**为可延迟加载（此前已播报过的仍然有效）。`) +
              `需要时用 tool_search 工具按名称（select:<工具名>，多个用逗号分隔）` +
              `或关键词调出，激活后即可在后续轮次正常调用。\n` +
              `</system-reminder>`,
          );
          log.info(
            "QUERY_LOOP",
            `注入延迟工具${isFull ? "全量" : "增量"}播报（新增 ${added.length}，已播报 ${announced.size}）`,
          );
        }
        for (const n of added) announced.add(n);
        for (const n of vanished) announced.delete(n);
        sessionState.set("announcedDeferredTools", announced);
      }

      // ─── 单次注入（P1-a）───
      // 必须只调用一次 injectReminders。原实现调两次（reminderParts 一次、deferred-tools
      // 一次），而每次都前置 → **第二次调用的内容压在第一次前面**，实测偏移
      // deferred=0 / MCP=366 / 用户指令=1075，注入顺序与代码书写顺序完全相反。
      // 后果是 critical 档辛苦排出的优先级被 deferred-tools 整体压到后面——
      // 止损阀"最先被读到"的设计意图当时已经失效。合并为单次调用后才真正生效。
      //
      // critical 前置于用户指令、ambient 后置，每个片段强制 <system-reminder> 围栏，
      // 且各自成独立 text block（不与用户指令做字符串拼接）——详见 reminder-inject.ts。
      if (criticalReminderParts.length > 0 || reminderParts.length > 0) {
        finalMessages = injectReminders(finalMessages, {
          critical: criticalReminderParts,
          ambient: reminderParts,
        });
      }

      const sendParams: SendParams = {
        // 别名：可观测性 / hook / 成本归因全读它，语义是「用户选的哪一条配置」。
        model: config.model,
        // 真名：只有 provider 拼 HTTP 请求体时用。主循环显式解析（快路径，不依赖
        // wire-model 的进程级兜底表），同名多端点靠它把两条别名分别发成同一个真名。
        wireModel: resolveWireModel(config.model, config.availableModels),
        messages: finalMessages,
        system: ctxMgr.getSystemPrompt(),
        maxTokens: state.maxOutputTokensOverride ?? config.maxTokens,
        tools: toolDefs,
        // §12 P2-1：思考 token 上限（settings.maxThinkingTokens，env 优先在 effort.ts 内解析）。
        // effort.ts applyAnthropicNative 读取它钳制思考预算（manual 精确 / adaptive 降档）。
        maxThinkingTokens: config.maxThinkingTokens,
      };

      // ─── Effort / Thinking 旋钮 → 各 provider 线格式（能力感知映射层，effort.ts）───
      // 每轮取最新运行时态（照搬 getCurrentPermissionMode 模式，保证 /effort、/think 切换当轮生效）。
      // 未注入 getter 时回退旧逻辑（thinking hint 直接写 SendParams），保证向后兼容。
      // PR-5：意图（applier 之前）与控制形态，随 BeforeModel 入 raw.jsonl。
      let thinkingObs:
        | {
            thinking_intent: "on" | "off" | "auto";
            thinking_control: "toggle" | "locked-on" | "none";
            effort_intent: string;
          }
        | undefined;
      if (deps.getEffortSetting || deps.getThinkingSetting) {
        const modelConfig = config.availableModels?.find((m) => m.name === config.model);
        const cap = resolveEffortCapability({
          // 能力判定吃**真名**：resolveEffortCapability 内部按模型名做家族/前缀匹配，
          // 喂本地别名（如 gw-deepseek-v4-pro）会静默 miss → thinking/effort 能力丢失。
          // 注意 supportsThinking 仍从 modelConfig 取（那是用户对**这条渠道**的显式声明，
          // 权威度高于按名推导，且同一真名的两个渠道支持度确实可能不同）。
          model: sendParams.wireModel ?? config.model,
          // 取 config.provider 而不是 modelConfig?.provider：两者在生产中恒等——启动、/model、
          // 恢复会话三条切模型路径都经 resolveCurrentModelConfig，条目带 provider 时回写
          // config.provider（config.ts）。fallback resolver（app.ts）按备用模型自己的条目取，
          // 因为备用模型不是 config.model，那里没有回写可依赖（20261018 复审 M1）。
          provider: config.provider,
          baseURL: modelConfig?.baseURL ?? config.baseURL,
          modelConfig: modelConfig ? { supportsThinking: modelConfig.supportsThinking } : undefined,
          // compat 声明按**渠道**（别名）建键，与上面 model 吃真名刚好相反，故单独传。
          // 同一真名的官方端点与公司网关可以有不同声明，合并成一个参数就分不开了。
          alias: config.model,
        });
        const runtimeEffort = deps.getEffortSetting?.();
        const runtimeThinking = deps.getThinkingSetting?.();
        let appliedEffort = resolveAppliedEffort(cap, runtimeEffort, getEffortEnvOverride());
        const appliedThinking = resolveThinking(cap, runtimeThinking, getThinkingEnvOverride());

        // §4.1 单轮关键词提级：ultrathink / think hard 命中（engine 经 thinking 透传 50K 预算）时，
        // 该轮提到 max（仅这一轮，不改持久基线；状态栏只显示基线，避免困惑）。
        if (thinking?.enabled && thinking.budgetTokens >= 50_000 && cap.supportsMaxEffort) {
          appliedEffort = "max";
        }

        // D9：记下 applier 之前的意图，fallback 据此对备用模型重解析（不读被 applier 改写过的值）。
        sendParams.thinkingIntent = { thinking: appliedThinking, effort: appliedEffort };
        const envThinking = getThinkingEnvOverride();
        const envEffort = getEffortEnvOverride();
        thinkingObs = {
          thinking_intent:
            envThinking !== null ? (envThinking ? "on" : "off") : (runtimeThinking ?? "auto"),
          thinking_control: cap.thinkingControl,
          // E9（20261018 effort 排查 PR-A）：用户所选档位，env > runtime > auto，与
          // resolveAppliedEffort 同口径但**不**做 auto→默认档、ultrathink 提级——那些是 applied，
          // 不是意图。此前只能从 agent_setting 快照读，65% 请求对不上（没切换过就没快照）。
          effort_intent: (envEffort !== null ? envEffort : runtimeEffort) ?? "auto",
        };
        // R1 / R6 / R10：同一份三态 + 控制形态 + 展示态随 BilledRequest 落盘，与 BeforeModel 同口径。
        sendParams.thinkingObservation = {
          setting: thinkingObs.thinking_intent,
          control: cap.thinkingControl,
          shown: resolveThinkingState(cap, runtimeThinking, envThinking).effective,
        };
        cap.applyToSendParams(sendParams, appliedEffort, appliedThinking);

        // §12 P2-1：思考预算被上限钳制时，一次性诚实告知用户（尤其 adaptive 模型无法精确保证）。
        const capMark = sendParams.thinkingBudgetCapped;
        if (capMark && !state.thinkingBudgetCapNotified) {
          state.thinkingBudgetCapNotified = true;
          if (capMark.mode === "manual") {
            log.info(
              "EFFORT",
              `思考预算已钳制到 ${capMark.appliedBudget} tokens（上限 ${capMark.requestedMax}）`,
            );
            yield {
              kind: "system",
              level: "info",
              text: `思考预算已按上限钳制到 ${capMark.appliedBudget} tokens`,
            };
          } else {
            log.info(
              "EFFORT",
              `adaptive 模型思考预算由服务端决定，已按上限 ${capMark.requestedMax} 映射到 effort=${capMark.mappedEffort}（无法保证精确上限）`,
            );
            yield {
              kind: "system",
              level: "info",
              text: `adaptive 模型思考预算由服务端决定，已按上限映射到 effort=${capMark.mappedEffort}，无法保证精确上限`,
            };
          }
        }
      } else {
        // ── 向后兼容回退：无旋钮 getter 时，沿用 engine 透传的 thinking hint ──
        // - Anthropic provider 读 params.thinking.budgetTokens 开启 Extended Thinking；
        // - DeepSeek（OpenAI 兼容）按预算档位映射 reasoningEffort（50K→max，其余→high）。
        if (thinking) sendParams.thinking = thinking;
        if (thinking?.enabled) {
          sendParams.reasoningEffort = (thinking.budgetTokens >= 50_000 ? "max" : "high") as
            | "high"
            | "max";
        }
      }

      // ─── BeforeModel hook ───
      if (hookSystem) {
        const beforeModelResult = await hookSystem.fireBeforeModelEvent(
          {
            model: sendParams.model,
            messages: sendParams.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            })),
            config: { maxTokens: sendParams.maxTokens },
            raw_messages: sendParams.messages,
            system: sendParams.system,
            tools: sendParams.tools,
            // 发现 14：本轮前 ContextManager 自己改写过发送前缀的来源，随 prefix_break 落盘。
            send_mutation_causes: ctxMgr.consumeSendMutationCauses(),
            // P1-6：把解析后的推理旋钮一并交给采集器。它们此前完全不在采集范围内，
            // 而排查 400 时「raw.jsonl 里没有 thinking 字段」被误读成「没下发 thinking」，
            // 带偏了整整一轮。注意这是**内部表示**，线上形状由各族方言决定（见 hook/types.ts）。
            ...(sendParams.thinking ? { thinking: sendParams.thinking } : {}),
            ...(sendParams.reasoningEffort ? { reasoning_effort: sendParams.reasoningEffort } : {}),
            ...thinkingObs,
          },
          {
            // 发现 1 修复：把 StreamPhase 快照的 key 组件（turnCount + loopId）透传给采集器，
            // 让配对看门狗用与 emitStreamPhase 一致的 key 查快照，不再恒 null。
            stream_snapshot_ref: { turn_index: state.turnCount, loop_id: loopId },
          },
        );
        if (beforeModelResult.finalOutput?.isBlockingDecision()) {
          log.info(
            "HOOK",
            `BeforeModel hook 阻止 LLM 请求: ${beforeModelResult.finalOutput.getEffectiveReason()}`,
          );
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }
        if (beforeModelResult.finalOutput?.shouldStopExecution()) {
          log.info(
            "HOOK",
            `BeforeModel hook 停止执行: ${beforeModelResult.finalOutput.getEffectiveReason()}`,
          );
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }
      }

      // 网络超时体系统一由 resolveLoopTimeouts 解析（单套保活优先默认值，可经
      // settings.json network.* 或 SID_CODE_* 环境变量覆盖），详见
      // src/config/network-profile.ts 的优先级链说明。
      //
      // ⚠️ 声明位置刻意在**建流之前**（2026-08-29 上移）：下方 `deps.sendWithRetry`
      // 要用它算 `deadlineAt`。原先它声明在建流之后、`try` 之前 ——
      // 那时它只服务于 catch 里的超时重试分支，够用；接了 deadlineAt 之后就不够了。
      // 仍在 `try` 之外，故 catch 块（超时重试分支）读到的仍是同一份解析结果。
      const netTimeouts = resolveLoopTimeouts({ network: config.network });

      // ─── 重试次数与看门狗解耦（2026-10-12）───
      //
      // 此前这里把看门狗阈值（min(header+grace, noProgress) = 315s）当 `deadlineAt` 交给 fallback，
      // 让内层在被外层杀掉前自己收手（2026-08-29 修「两层预算相乘」）。代价是重试次数实际由
      // 315s 决定：指数退避 5s→120s 下最多 5–6 次，`maxTimeoutRetries=10` 形同虚设，
      // 用户看到「重试 5 次就结束」。
      //
      // 现在根因层面拆开：看门狗不再把退避计入「无进展」（见下方 trackRetryBackoff 与
      // watchdog 闸门），于是不必再给内层设时间上限 —— 次数归次数上限管，卡死归看门狗管。
      // 「两层相乘」也随之消失：外层不会在内层退避期间开枪，内层用满次数后自己放弃。
      // ⚠️ 别把 deadlineAt 加回来：加回来就退回「次数听时间的」那一版。
      // 子代理同样不传（2026-10-14），总时长由 sub-agent.ts 的硬 kill 兜底；
      // side-call（compact / recall / hook agent 等）的 deadlineAt 才是真实的总时长预算，不受影响。

      // ─── 发送请求（含上下文溢出 + prompt-too-long 自动恢复）───
      let stream: AsyncIterable<import("../llm/types.ts").StreamEvent>;
      // Fix 3（回归根治）：每轮创建独立的「turn 级子 AbortController」，级联父（会话级）signal。
      //
      // 根因：此前 finally 里无条件 deps.abortCurrentRequest("race-settled") 直接 abort 了
      // 会话级共享 controller（app.ts 每条用户消息一个，贯穿整个 queryLoop 所有轮次）。正常
      // 完成的一轮也会把它 abort → 下方 A2 检测 getAbortSignal()?.aborted 命中 → 误判为
      // "用户取消" → 任务在第一轮后就被中止（单轮 end_turn / 多轮 tool_use 均必现）。
      //
      // 正解：turn 级中断（超时 / 看门狗 / race settle 后的孤儿清理）只作用于本轮子 controller，
      // 绝不回写会话级 signal；而父 signal（用户 ESC / 会话超时）经 AbortSignal.any 级联下来，
      // 仍能中断本轮请求。A2 检测仍读父 signal（deps.getAbortSignal），故只有「真正的用户/会话
      // 级取消」才会触发优雅收尾，turn 级自我清理不再污染它。
      const parentSignal = deps.getAbortSignal();
      const turnAbortController = new AbortController();
      // 父已 abort（例如用户在本轮开始前就按了 ESC）→ 立刻把状态透传给子 controller。
      if (parentSignal?.aborted) {
        try {
          turnAbortController.abort(parentSignal.reason);
        } catch {
          /* ignore */
        }
      }
      // 级联：父 signal 与子 signal 任一 abort，composedSignal 即 abort（reason 取先触发者）。
      // 传给底层 fetch/SDK 的用这个复合 signal，既响应用户级取消，也响应 turn 级自我中断。
      const composedSignal: AbortSignal = parentSignal
        ? AbortSignal.any([parentSignal, turnAbortController.signal])
        : turnAbortController.signal;
      // turn 级主动中断上游（超时/看门狗/清理）—— 只 abort 本轮子 controller，不碰会话级。
      const abortThisTurn = (reason: string) => {
        try {
          turnAbortController.abort(reason);
        } catch {
          /* ignore */
        }
      };

      // ─── 请求前预算硬停：已超限就不再发请求 ───
      // 响应后的硬停（见下方「预算追踪器检查」「成本配额检查」）只能在钱花掉之后拦；
      // 超限后用户再发一条消息，没有这一道就会先烧一次 API 调用再停。这里每轮发请求前问一次，
      // 判据与响应后同源（findBlockingRule / isExceeded），不依赖告警去重状态。
      {
        const preStop = checkPreRequestBudgetStop(
          loopConfig,
          sessionState.getEffectiveTotalCostUSD(),
        );
        if (preStop) {
          log.info("BUDGET", `请求前硬停（${preStop.source}）：${preStop.text}`);
          yield { kind: "system", level: "warning", terminal: true, text: preStop.text };
          yield {
            kind: "done",
            turns: state.turnCount,
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            budgetExceeded: { source: preStop.source },
          };
          exitedViaReturn = true;
          return;
        }
      }

      // ─── F5：本地速率限制（RPM/TPM）主动节流 ───
      //
      // 缺陷形态（2026-09-03 排查）：`QuotaManager.checkRateLimit()` 的**生产调用点 = 0**。
      // 每轮都在 `recordRequest()` 往滑动窗口写数据（见响应后那处），但从来没人问
      // 「超了吗」——**只记不查**，用户配的 requestsPerMinute / tokensPerMinute 静默失效。
      //
      // 注意别与 app.ts 的 `syncRateLimitStatus` 混为一谈：那个读的是**服务端返回的
      // 429/ratelimit 响应头**（被动感知服务端限流），这里是**本地滑动窗口主动节流**。
      // 两者是两套东西，缺的一直是后者。
      //
      // 等待用 sleepUnlessAborted 而非裸 setTimeout：ESC 期间必须能立刻醒
      // （否则最坏空等 60s 才响应中断）。醒来后复检 abort，由下方既有逻辑收尾。
      if (loopConfig.quotaManager) {
        const waitMs = loopConfig.quotaManager.checkRateLimit();
        if (waitMs > 0) {
          const waitSec = Math.ceil(waitMs / 1000);
          log.info("QUOTA_RATE_LIMIT", `本地速率限制触发，等待 ${waitSec}s 后再发请求`);
          yield {
            kind: "system",
            level: "info",
            text: `已达本地速率限制，等待 ${waitSec}s 后继续（可按 ESC 中断）`,
          };
          await sleepUnlessAborted(waitMs, deps.getAbortSignal?.());
          if (deps.getAbortSignal?.()?.aborted) {
            log.info("QUOTA_RATE_LIMIT", "速率限制等待期间被中断，收尾");
            yield { kind: "system", level: "info", text: "请求已被取消" };
            yield {
              kind: "done",
              turns: state.turnCount,
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
              incompleteReason: (state.incompleteReason = "aborted"),
            };
            exitedViaReturn = true;
            return;
          }
        }
      }

      // ─── G9：请求前快照 prompt 状态（与响应后 checkResponse 配对的两阶段检测） ───
      // 必须在发送前记录，否则检测器无基线可比，cache break 归因永远为空。
      // agentId="main"：主循环源，与子代理（独立上下文）的基线隔离（G10）。
      try {
        recordPromptState({
          cacheReadTokens: 0, // 快照阶段不关心 token，仅记录状态指纹
          systemPrompt: typeof sendParams.system === "string" ? sendParams.system : "",
          toolSchemas: (sendParams.tools ?? []).map((t) => ({ ...t, name: t.name })),
          model: config.model,
          messageCount: sendParams.messages.length,
          betaHeaders: currentBetaHeaders(config.provider),
          agentId: "main",
        });
      } catch {
        /* 快照失败绝不影响主循环 */
      }

      // 5.2：登记当前会话 id + 轮次 + loopId，供 provider 的 SSE 逐 chunk 采样落盘定位
      //（默认关闭，SID_CODE_DEBUG_SSE_DUMP=1 才真正落盘）。
      // Fix 1：loopId 传入 ambientCtx，使 emitStreamPhase 写入的快照带有正确的 namespace。
      setSseDumpContext(sessionState.sessionId, state.turnCount, loopId);
      // ─── 发送错误只有一个处理入口：下方流式阶段的 catch（2026-10-24）───
      //
      // 此前这里包着一个「连接阶段」try/catch（PTL 响应式压缩 / handleContextOverflow 调
      // maxTokens / autoCompact + 熔断），但它**结构上不可达**：`sendWithRetry` 的生产实现
      // 是 `async *executeWithFallback`，调用只返回迭代器、不会同步抛错，一切发送错误都在
      // processStream 迭代时冒出、被流式 catch 接住。本机 39 条 errors.jsonl 的 phase 只有
      // stream / engine，connection 恒为 0；而两份 catch 的逻辑长期分叉（P2-6 就是"只修了
      // 一半"），死的那份还让人以为 handleContextOverflow 在起作用。
      //
      // 非生成器实现（测试替身、未来改写）可能同步抛错：这里只**捕获**，在下方流式 try 的
      // 第一行原样重抛，让它走同一个 catch。不能把它推迟到"首次迭代"——那依赖消费方真的去
      // 迭代 stream，而替身 processStream 往往不迭代，错误会凭空消失。
      let sendError: { err: unknown } | undefined;
      try {
        stream = deps.sendWithRetry(sendParams, composedSignal);
      } catch (err) {
        sendError = { err };
        stream = (async function* () {})();
      }

      // ─── 处理流式响应 ───
      const perfHandle = getPerfTimer().start(`llm_request_${state.turnCount}`);
      // TTFT 不在这里自己计：曾用下方 processStream 的可视文本回调计时，纯 tool_use /
      // thinking 轮恒 undefined（2026-10-08 端到端实测 3 轮只有 end_turn 那轮有值）。
      // 改为取 lifecycle 层 first_content 的同一个值（首个任意内容 chunk、每次 fetch 单独计），
      // 见 stream-observer.ts `_firstContentTtft`。这里先丢弃残留，保证 AfterModel 读到的只来自本轮。
      takeFirstContentTtft(state.turnCount);

      let response: import("../llm/types.ts").AccumulatedResponse;
      // 本轮耗时基准与两类「非业务时长」扣除量。同 netTimeouts 声明在 try 之外，
      // 让 catch 的超时重试分支也能算出真实已耗时（见 emitTimeoutRetry 处说明）。
      const turnStartedAt = Date.now();
      let humanInputPauseAccumMs = 0; // 已结束的「等用户输入」段累计总时长
      let sleepPauseAccumMs = 0; // 系统休眠累计时长（进程被冻结，定时器不 tick）
      try {
        // 发送阶段的同步抛错在这里重抛，与流式错误共用下方唯一的 catch（见 sendWithRetry 调用处）
        if (sendError) throw sendError.err;
        // ─── L1：单轮硬超时兜底（治本，对所有挂起根因成立）───
        // 根因：底层 generator 链（processStream → fallback for-await → openai parseSSE）
        // 任一层因 reader.read() 在半开 TCP 上永不 settle、且 reader.cancel() 同样 hang 时，
        // `await deps.processStream(...)` 永不返回，整个 queryLoop 永久挂死（实测 22 分钟无反应）。
        //
        // 为什么用 Promise.race 而非 setTimeout+finally：finally 只在 await settle 后执行，
        // 若底层永不 settle，finally 永不到达 —— 兜底形同虚设。Promise.race 让超时 Promise
        // 与 processStream 竞争,超时先 reject 即把控制权交还本循环,hang 的 generator 变悬空
        // 引用被 GC,不再阻塞主循环。这是唯一不依赖 abort/cancel 链路的真兜底。
        //
        // reject 后走下方 catch → isTimeoutError 命中 → 复用现有 timeout 重试分支(continue),
        // 无需新写 yield done/return,且保留重试机会。
        // 超时阈值可经 deps 注入覆盖（默认 10 分钟），便于单测用短值触发。
        const MAX_TURN_DURATION_MS = deps.maxTurnDurationMs ?? netTimeouts.maxTurnDurationMs;

        // ─── 人机输入闸门配套状态（turn_hard 与 watchdog 共享）───
        // H6 根治：turn_hard 此前是一次性 setTimeout，回调体内不查 isAwaitingHumanInput()，
        // 用户在 fallback / 抢跑弹窗前离开、超过 30min 未作答时，硬超时照 fire → abortThisTurn
        //（"turn-timeout"）→ 级联 abort composedSignal → 弹窗按 cancelled 解除 → 终止本轮，
        // 与紧邻的 watchdog（已有 gate + 等待补偿）口径分裂。
        // 修复：把 turn_hard 从「一次性 setTimeout」改为「周期 setInterval 检查」，与 watchdog 同构——
        // 等人输入的时段整体从「已耗时」里剔除，只有真正的非等待业务耗时累计达 30min 才 fire。
        // 两个计时器共享同一套等待累计变量，避免各自维护导致重复扣除或状态漂移。
        let humanInputPausedAt: number | null = null; // 当前等待段起点（null=未在等待）

        // ─── 休眠时长累计（事故 20260801-175042-699f69f8）───
        // 与 humanInputPauseAccumMs 完全同构、同理由：**非业务时长不该计入业务预算**。
        // 系统休眠期间进程被整体冻结，两个 setInterval 都不 tick，醒来一起补 fire
        // （实测预期 5000ms、实际 926241ms）。若不剔除，休眠时长会被当成"流 hang"
        // 直接判超时并吃掉一次重试配额——那次事故三段休眠吃掉了 3/10 次重试预算。
        // 两个定时器共享此变量（同 humanInputPause*）：先 tick 的那个负责记账，
        // 后 tick 的看到间隔已恢复正常自然不再记，天然去重、且两条防线口径一致。
        // 注意：turnStartedAt / humanInputPauseAccumMs / sleepPauseAccumMs 三者声明在
        // try 之外（同 netTimeouts 的理由），使 catch 里的超时重试分支能算出**真实**已耗时
        // 上报遥测，而不是像修复前那样填一个配置常量。

        let turnTimer: ReturnType<typeof setInterval> | null = null;
        // 缺口 2 进阶：turn_hard 超时 fire 后武装「未生效」检查；race settle 时 disarm。
        // 若 5s 内未 disarm，说明超时 fire 了却没让 Promise.race settle（本次事故指纹）。
        let disarmTurnIneffective: (() => void) | null = null;
        // turn_hard 周期检查间隔：复用 watchdog 的 check interval（同为 5s 级），保证及时性。
        // 检查间隔取「watchdog 间隔」与「硬超时阈值」的较小值（下限 10ms 防忙轮询）：
        // 阈值远大于间隔时用 watchdog 间隔（5s 级，足够及时）；阈值很小时（单测注入 50ms /
        // 激进配置）用阈值本身，保证第一次检查不会晚于超时点太多，硬超时如期 fire。
        const TURN_HARD_CHECK_INTERVAL_MS = Math.max(
          10,
          Math.min(netTimeouts.watchdogCheckIntervalMs, MAX_TURN_DURATION_MS),
        );
        // 定时器迟到实测（TimerDrift 埋点）：记上一次 tick 时刻，每 tick 比对实际间隔。
        // 为什么需要：轨迹 20260730-142920-d98e7f16 里 turn_hard 与 watchdog 双双迟到
        // 几百秒，但两个候选根因（事件循环被 IO 占满 / humanInputPause 扣减）都无法从
        // 现有轨迹分辨——见 stream-observer.ts emitTimerDrift 的说明。
        let turnLastTickAt = Date.now();
        const turnTimeoutPromise = new Promise<never>((_resolve, reject) => {
          turnTimer = setInterval(() => {
            try {
              // 迟到检测放在最前：任何 early-return 之前都要测到，否则闸门/settle 分支
              // 一 return 就把这次 tick 的间隔信息丢了（而恰恰是这些分支最可能长时间不动）。
              {
                const now = Date.now();
                const actual = now - turnLastTickAt;
                turnLastTickAt = now;
                // 休眠剔除：跳跃幅度达阈值即认定系统被挂起，把超出正常 tick 的部分
                // 计入 sleepPauseAccumMs，从下方 businessElapsedMs 里整体扣掉。
                // 放在 drift 埋点旁边而非之后：drift 与休眠判据用的是同一个 actual，
                // 分开算会出现"埋点说迟到了、判据却没扣"的口径分裂。
                const slept = getSleepLedger().record(actual, TURN_HARD_CHECK_INTERVAL_MS);
                if (slept > 0) {
                  sleepPauseAccumMs += slept;
                  log.warn(
                    "QUERY_LOOP",
                    `检测到系统休眠约 ${(slept / 1000).toFixed(0)}s（turn_hard tick 迟到 ${(actual / 1000).toFixed(0)}s），已从单轮耗时中剔除`,
                  );
                }
                if (actual > TURN_HARD_CHECK_INTERVAL_MS * TIMER_DRIFT_RATIO) {
                  emitTimerDrift(state.turnCount, {
                    timer: "turn_hard",
                    expected_ms: TURN_HARD_CHECK_INTERVAL_MS,
                    actual_ms: actual,
                    drift_ms: actual - TURN_HARD_CHECK_INTERVAL_MS,
                    sleep_ms: slept > 0 ? slept : undefined,
                    // 缺口7：与 hypothesis 各事件统一轮次口径，让"迟到发生在会话哪一阶段"可跨消息还原。
                    absoluteTurn: sessionState.getAbsoluteTurn(),
                    promptSeq,
                  });
                }
              }
              // race 已 settle 后不再触发（防冗余 abort）。
              if (raceSettled) return;
              // 闸门：正在阻塞等用户输入（fallback / 抢跑权限弹窗）→ 记录等待段起点，不计硬超时。
              if (isAwaitingHumanInput()) {
                if (humanInputPausedAt === null) humanInputPausedAt = Date.now();
                return;
              }
              // 刚结束等待：把本段等待时长并入累计，从「已耗时」里整体剔除。
              if (humanInputPausedAt !== null) {
                humanInputPauseAccumMs += Date.now() - humanInputPausedAt;
                humanInputPausedAt = null;
              }
              // 非等待业务耗时 = 墙钟总耗时 - 累计等待时长 - 累计休眠时长。
              // 两项扣减同理：都是"进程没在为用户干活"的时段，不该消耗业务预算。
              const businessElapsedMs =
                Date.now() - turnStartedAt - humanInputPauseAccumMs - sleepPauseAccumMs;
              if (businessElapsedMs < MAX_TURN_DURATION_MS) return;

              log.error(
                "QUERY_LOOP",
                `单轮硬超时 ${MAX_TURN_DURATION_MS / 1000}s（已扣除 ${(humanInputPauseAccumMs / 1000).toFixed(0)}s 等待 + ${(sleepPauseAccumMs / 1000).toFixed(0)}s 休眠），强制让出控制权`,
              );
              // 缺口 2：记录单轮硬超时触发
              emitTimeoutFired(state.turnCount, "turn_hard_timeout", {
                threshold_ms: MAX_TURN_DURATION_MS,
                model: config.model,
              });
              // 缺口 2 进阶：武装未生效检查（reject 后若 race 未 settle → TimeoutIneffective）
              disarmTurnIneffective = armIneffectiveCheck(
                state.turnCount,
                "turn_hard_timeout",
                "promise_race_not_settled_after_5s",
              ) as () => void;
              // 尽力而为：主动 abort 上游 fetch（即便对已 hang 的 reader 无效也无害）。
              // Fix 3 根治：只 abort 本轮子 controller，不碰会话级 signal。
              abortThisTurn("turn-timeout");
              reject(new Error(`单轮硬超时：${MAX_TURN_DURATION_MS / 1000}s 无完成`));
            } catch {
              /* 周期检查自身异常不外泄，等下个 tick */
            }
          }, TURN_HARD_CHECK_INTERVAL_MS);
          // P3（9bc92c2c + fdb47f30 教训）：不 unref——Bun 中 unref timer 在事件循环被
          // 底层 IO hang 占满时不保证按时 fire，导致硬超时形同虚设。setInterval 在 Bun 中
          // 已被 heartbeat 证明可靠（周期性重排，不受单次长任务饿死）。
          // 正常路径的 finally { clearInterval(turnTimer) } 保证不会泄漏阻止退出。
        });

        // ─── T1：setInterval 看门狗（turn_hard_timeout 的补位防线）───
        // 根因：上面的 turnTimeoutPromise 用 setTimeout，在 Bun 事件循环被半开 TCP IO
        // 占满时可能延迟数分钟才 fire（实测 setTimeout 回调延迟 193s → 流 hang 死 35min）。
        // 而 setInterval 在 Bun 中已被 heartbeat 证明可靠（周期性重排，不受单次长任务饿死）。
        // 策略：每 5s 读一次当轮流状态快照 getStreamSnapshot(state.turnCount)，
        // 若 lastContentProgressAt 已达 netTimeouts.watchdogNoProgressMs 无业务进展
        // （text_delta / tool_use / reasoning）→ abort 上游 + reject，把 hang 转成
        // timeout 重试（远早于单轮硬超时）。
        //
        // 为什么快照够用：openai.ts 的 parseSSE 每收到有效内容就 updateStreamStats
        // 刷新 lastContentProgressAt（见 openai.ts:1116-1125），watchdog 只读不写，
        // 无侵入。快照缺失（Anthropic 路径当前不写快照 / 请求刚起未建快照）时降级为
        // "用 watchdog 自身启动时间兜底"——保证任何 provider 都有无快照即触发的下限。
        const WATCHDOG_CHECK_INTERVAL_MS = netTimeouts.watchdogCheckIntervalMs;
        const WATCHDOG_NO_PROGRESS_MS = netTimeouts.watchdogNoProgressMs;
        // Fix 6（隐患 4）：快照缺失（等首字节）时，看门狗阈值 = headerTimeoutMs + 余量。
        // 余量可覆盖，便于运维调参 / 单测注入短值触发。
        const WATCHDOG_HEADER_GRACE_MS = netTimeouts.watchdogHeaderGraceMs;
        let watchdogTimer: ReturnType<typeof setInterval> | null = null;
        // Fix 2：看门狗启动前主动清除可能残留的旧快照（防止孤儿 generator 写入的脏数据误杀）
        clearStreamSnapshot(state.turnCount);
        const watchdogStartedAt = Date.now();
        // 重试退避窗口（2026-10-12 解耦）：fallback 漏斗在退避前后发 `retry_backoff`。
        // 看门狗判的是「单次请求卡死」，退避是主动等待 —— 退避中不判，退避结束后从零起算。
        // 这样重试次数只由 maxTimeoutRetries 决定，不再被看门狗阈值截断。
        const backoffTracked = trackRetryBackoff(stream);
        stream = backoffTracked.stream;
        const retryBackoff = backoffTracked.window;
        // 人机输入闸门配套状态（humanInputPausedAt / humanInputPauseAccumMs）已提升到 turn_hard
        // 之前定义，turn_hard 与 watchdog 共享同一套（H6）：两个 setInterval 都在单线程事件循环内
        // 跑，先跑的那个 tick 负责「结束等待→累计→置 null」，后跑的看到 null 即跳过，天然不会重复
        // 累计；共享还保证两条防线对「已扣除多少等待」看法一致，不会一个扣了另一个没扣而口径打架。
        // 定时器迟到实测（见 turn_hard 处同名注释与 stream-observer.ts emitTimerDrift）。
        let watchdogLastTickAt = Date.now();
        // P2：静默期半程告警只报一次的门闩（每轮独立，随本轮 watchdog 生命周期）。
        let streamIdleWarned = false;
        const watchdogPromise = new Promise<never>((_resolve, reject) => {
          watchdogTimer = setInterval(() => {
            try {
              // 迟到检测放在所有 early-return 之前（含 isAwaitingHumanInput 闸门）：
              // 本次事故的静默窗口正是"看门狗该判超时却 899s 没判"，若在闸门之后测，
              // 闸门 return 的那些 tick 就完全不留痕，等于测不到最需要的那段。
              {
                const now = Date.now();
                const actual = now - watchdogLastTickAt;
                watchdogLastTickAt = now;
                // 休眠剔除（同 turn_hard 处理，共享 sleepPauseAccumMs 天然去重）。
                // 对 watchdog 尤其关键：本次事故三次强杀全部由 watchdog 判出，
                // 而三段"无进展"其实全是休眠——剔除后它们不再构成杀流理由。
                const sleptW = getSleepLedger().record(actual, WATCHDOG_CHECK_INTERVAL_MS);
                if (sleptW > 0) {
                  sleepPauseAccumMs += sleptW;
                  log.warn(
                    "QUERY_LOOP",
                    `检测到系统休眠约 ${(sleptW / 1000).toFixed(0)}s（watchdog tick 迟到 ${(actual / 1000).toFixed(0)}s），已从无进展判据中剔除`,
                  );
                }
                if (actual > WATCHDOG_CHECK_INTERVAL_MS * TIMER_DRIFT_RATIO) {
                  emitTimerDrift(state.turnCount, {
                    timer: "watchdog",
                    expected_ms: WATCHDOG_CHECK_INTERVAL_MS,
                    actual_ms: actual,
                    drift_ms: actual - WATCHDOG_CHECK_INTERVAL_MS,
                    sleep_ms: sleptW > 0 ? sleptW : undefined,
                    // 缺口7：与 hypothesis 各事件统一轮次口径，让"迟到发生在会话哪一阶段"可跨消息还原。
                    absoluteTurn: sessionState.getAbsoluteTurn(),
                    promptSeq,
                  });
                }
              }
              // Fix 3/隐患 7：race 已 settle 后不再触发 abort（防冗余）
              if (raceSettled) return;
              // 闸门：正在阻塞等用户输入（如 fallback 询问弹窗）→ 不判无进展。
              // 弹窗发生在 stream generator 内部（tryFallback），期间无 SSE 事件流动，
              // 若不短路，看门狗会把"等人答题"误当流 hang 强杀，掐断弹窗（事故 20260721-142757）。
              if (isAwaitingHumanInput()) {
                // 仅在首次进入等待时记起点——共享变量后若每 tick 无条件覆盖，会把已积累的等待
                // 时长丢掉（起点被不断后移），导致结束时累计偏少、补偿不足。置 null 才写。
                if (humanInputPausedAt === null) humanInputPausedAt = Date.now();
                return;
              }
              // 刚结束等待：把无进展基线整体后移等待时长，避免答完立即被判超时。
              if (humanInputPausedAt !== null) {
                humanInputPauseAccumMs += Date.now() - humanInputPausedAt;
                humanInputPausedAt = null;
              }
              // 闸门：漏斗正在重试退避 → 不判无进展（同人机闸门：主动等待不是 hang）。
              if (retryBackoff.active) return;
              const snapshot = getStreamSnapshot(state.turnCount);
              // Fix 6（隐患 4）：快照缺失 = 还在等首字节，用 headerTimeoutMs（+10s 余量）
              // 而非固定 90s 阈值兜底——否则 DeepSeek 大上下文请求（首字节需 90-120s 属正常）
              // 会被看门狗抢先于 header timeout 之前误杀，浪费一次本可正常返回的重试机会。
              // 快照存在（已收到首字节）时仍用 WATCHDOG_NO_PROGRESS_MS 判定无进展。
              const effectiveThresholdMs = snapshot
                ? WATCHDOG_NO_PROGRESS_MS
                : netTimeouts.headerTimeoutMs + WATCHDOG_HEADER_GRACE_MS;
              // 快照存在用 lastContentProgressAt；缺失则退化为 watchdog 启动时间兜底。
              // 退避结束即新一次请求的起点：基线取「最近内容进展」与「最近退避结束」中较晚者，
              // 每次重试都拿到一份完整的单次请求窗口。
              const lastProgressAt = Math.max(
                snapshot?.lastContentProgressAt ?? watchdogStartedAt,
                retryBackoff.lastEndedAt ?? 0,
              );
              // 扣除累计的用户等待时段 + 累计休眠时长，两者都不是"流 hang"。
              // 休眠这项是本次事故的根治点：三次强杀的"无进展"全部是系统休眠，
              // 剔除后它们不再构成杀流理由，也不再冤枉重试配额。
              const noProgressMs =
                Date.now() - lastProgressAt - humanInputPauseAccumMs - sleepPauseAccumMs;
              // ─── P2：静默期半程告警（借鉴 claude-code STREAM_IDLE_WARNING_MS）───
              // 阈值本身不动（保活优先，见 network-profile.ts DEFAULTS 的多 provider 立场），
              // 但整个静默期零信号会让用户以为"卡死了/自己停了"（阈值越宽这点越明显 ——
              // PR10 把它从 300s 抬到 720s 之后，半程告警比改造前更有必要）。半程先落一条 warn +
              // 给 UI 一个可见提示，把"还在等"与"已经死"区分开。只报一次，避免刷屏。
              if (
                !streamIdleWarned &&
                noProgressMs >= effectiveThresholdMs / 2 &&
                noProgressMs < effectiveThresholdMs
              ) {
                streamIdleWarned = true;
                log.warn(
                  "QUERY_LOOP",
                  `流静默 ${(noProgressMs / 1000).toFixed(0)}s（阈值 ${(effectiveThresholdMs / 1000).toFixed(0)}s），仍在等待上游响应`,
                );
              }
              if (noProgressMs < effectiveThresholdMs) return;

              log.error(
                "QUERY_LOOP",
                `看门狗：${(noProgressMs / 1000).toFixed(0)}s 无业务进展，强制中断流（补位 turn_hard）`,
              );
              // 记录 watchdog 强杀事件（含当轮流状态快照）
              emitWatchdogKill(state.turnCount, {
                phase: snapshot?.phase ?? "unknown",
                last_content_progress_ms: noProgressMs,
                total_chunks: snapshot?.chunksReceived ?? 0,
                empty_chunks: snapshot?.emptyChunks ?? 0,
                elapsed_ms: Date.now() - watchdogStartedAt,
                model: config.model,
                // 迟判归因用（轨迹 20260730-142920-d98e7f16：阈值 300s 却 899s 才判）。
                // 有了这三个值就能算清「迟到到底被什么吃掉了」：
                //   raw_no_progress_ms - human_input_pause_accum_ms = noProgressMs（判据），
                // 若 pause 累计≈0 而 raw 远超阈值 → 是定时器没按时 tick（配 TimerDrift 事件确认）；
                // 若 pause 累计很大 → 是等待扣减把时长吃掉了（两者修法完全不同）。
                human_input_pause_accum_ms: humanInputPauseAccumMs,
                raw_no_progress_ms: Date.now() - lastProgressAt,
                effective_threshold_ms: effectiveThresholdMs,
                // 缺口7：与 hypothesis 各事件统一轮次口径。index（state.turnCount）是消息内计数、
                // 跨消息回绕，离线分析"强杀发生在会话哪一阶段"时与 hypothesis 事件不可直接比较。
                absoluteTurn: sessionState.getAbsoluteTurn(),
                promptSeq,
              });
              // 尽力而为：主动 abort 上游 fetch（即便对已 hang 的 reader 无效也无害）。
              // Fix 3 根治：只 abort 本轮子 controller，不碰会话级 signal。
              abortThisTurn("watchdog-timeout");
              // reject 带 "timeout" 字样 → 下方 catch 命中 isTimeoutError → 复用超时重试分支。
              reject(
                new Error(`看门狗超时：${(effectiveThresholdMs / 1000).toFixed(0)}s 无业务进展`),
              );
            } catch {
              /* 看门狗自身异常绝不影响主流程 */
            }
          }, WATCHDOG_CHECK_INTERVAL_MS);
          // 同 turnTimer：不 unref——它是关键防线，宁可保持进程活跃直到 finally 清理。
        });

        // Fix 3：settled flag — 防止 race settle 后看门狗/超时 interval 冗余 abort（隐患 7）
        let raceSettled = false;

        try {
          response = await Promise.race([
            deps.processStream(
              stream,
              (_text) => {
                // 流式文本通过 QueryEngine 层的 onStreamText 回调桥接；TTFT 见上方 takeFirstContentTtft
              },
              undefined,
              // Fix 3（同类路径根治）：把本轮 turn 级 controller 透传进 stream-processor，
              // 让其心跳/整体超时只 abort turn 级（经 composedSignal 级联中断上游 fetch），
              // 不再污染会话级共享 signal。
              turnAbortController,
            ),
            turnTimeoutPromise,
            watchdogPromise,
          ]);
          // onThinking 通过 QueryEngine 层的 streamThinkingCallback 桥接，queryLoop 自身无需处理
        } finally {
          raceSettled = true;
          if (turnTimer !== null) clearInterval(turnTimer); // H6：turn_hard 已改为 setInterval 周期检查
          if (watchdogTimer !== null) clearInterval(watchdogTimer);
          // race 已 settle（正常返回或 catch 到 reject）→ disarm，证明超时确实生效。
          // 断言读取：disarm 仅在闭包内赋值，TS 线性流会把变量窄化成 null，故显式转型。
          (disarmTurnIneffective as (() => void) | null)?.();

          // Fix 3：主动终止 stream generator，防止孤儿继续在后台发请求写入 _snapshots
          if (stream && typeof (stream as any).return === "function") {
            try {
              (stream as AsyncGenerator).return(undefined);
            } catch {
              /* 忽略已终止的 generator 的错误 */
            }
          }

          // Fix 3（回归根治）：abort 本轮子 controller（确保底层 fetch 被中断，stallLogger
          // interval 经 finally 清理）。仅作用于 turn 级子 signal，不碰会话级共享 controller，
          // 正常完成的一轮不再污染 A2 检测（根治回归）。
          abortThisTurn("race-settled");

          // Fix 3：清除本轮快照（即使 processStream 没有正常完成）
          clearStreamSnapshot(state.turnCount);
        }
      } catch (err: any) {
        perfHandle.end({ model: config.model });

        // ─── 作废尝试的用量入账（P0-2 C 组）───
        //
        // 放在 catch **最前面**是刻意的：本 catch 有三条 `continue` 重试出口
        // （超时重试 / prompt-too-long 压缩后重试 / fallback 换模型），它们全都绕过了
        // 下方 `sessionState.updateUsage(...)`（那句在 try/catch **之后**）。挂在这里
        // 是唯一能同时覆盖三条出口的位置；分别在每条 continue 前埋一次必然漏掉将来
        // 新增的第四条出口。
        //
        // 为什么这些量必须记：这次尝试的 prompt **已经完整发到服务端**了，
        // 厂商按收到的 prompt 计费，不管客户端后来是否丢弃响应 —— 实测该会话
        // `HttpConnected(status=200)` 254 次全部成功建连，而记账只有 153 次。
        // 差额 101 次约 12M token 从未入账（轨迹自报 22.4M，真实账单对应 30.6M）。
        //
        // 口径：计入 `cumulativePromptTokens` / cost（billable，对账官方账单用），
        // 但**不动** stock 口径的"当前上下文大小"—— 作废尝试不构成上下文。
        // 这个区分由 updateUsage 的 discarded 参数实现，见 session/state.ts。
        {
          const discarded = (err as { discardedUsage?: import("../llm/types.ts").Usage })
            ?.discardedUsage;
          if (discarded) {
            sessionState.updateUsage(
              config.model,
              discarded,
              0,
              config.provider,
              config.baseURL,
              true, // discarded=true：只累加 flow 口径与费用，不覆盖 stock
            );
          }
        }

        // 优化 1：只记录会被本 catch「吞掉/重试」的分支（timeout / prompt-too-long）。
        // 未识别错误走下面 throw err → 冒泡到 engine 层已 recordError，此处不重复记，避免双写。
        // willRetry 反映本轮是否还会重试：超时看重试次数未耗尽，prompt-too-long 看响应式压缩未用过。
        {
          const _isTimeout = isTimeoutError(err, turnAbortController.signal);
          const _isPromptLong = isPromptTooLongError(err);
          if (_isTimeout || _isPromptLong) {
            deps.recordError?.({
              phase: "stream",
              index: state.turnCount,
              error: (err as Error)?.message ?? String(err),
              stack: (err as Error)?.stack?.split("\n").slice(0, 5).join("\n"),
              context: {
                kind: _isTimeout ? "timeout" : "prompt_too_long",
                willRetry: _isTimeout
                  ? state.timeoutRetryCount < netTimeouts.maxTimeoutRetries
                  : !state.hasAttemptedReactiveCompact,
                ...(_isTimeout ? { attempt: state.timeoutRetryCount + 1 } : {}),
              },
            });
          }
        }

        // timeout 错误直接重试（不需要压缩上下文，最多 2 次）
        // 根治（2026-07）：传入 turnAbortController.signal，使 isTimeoutError 能读到
        // 首次 abort() 锁定的 reason 做结构性判定——内部心跳/整体/看门狗/硬超时
        // 触发的 abort 即便冒泡上来的是"措辞通用的 abort-race 错误"（不含 timeout
        // 字样），也能被正确识别为超时并走重试/错误卡片分支，而非静默当成用户取消。
        if (isTimeoutError(err, turnAbortController.signal)) {
          const maxRetries = netTimeouts.maxTimeoutRetries;
          const timeoutRetryCount = state.timeoutRetryCount;

          if (timeoutRetryCount < maxRetries) {
            state.timeoutRetryCount = timeoutRetryCount + 1;
            // ─── 轮数预算被网络故障偷走：记账（Harbor A11 实测，2026-08-29）───
            //
            // 走到这里意味着：本轮**零内容产出**（被 watchdog / 硬超时 / 心跳杀掉），
            // 下面 `continue` 会退回 while 顶部再 `turnCount++` —— 即这一格 maxTurns
            // 预算被花掉了，却换不来一次模型交互，也不会产出 assistant_message，
            // 于是在 SDK 的 `num_turns` 里完全隐身。
            //
            // 实测不变式：`num_turns + WatchdogKill = maxTurns + 1`（7/7 个
            // error_max_turns 样本成立），其中两题 40 格只换来 34 次交互。
            //
            // ⚠️ 只在**重试真的会发生**的这一支记（`timeoutRetryCount < maxRetries`）。
            // 记在 `isTimeoutError` 那个 if 的外层会把「重试耗尽、随后 return 收尾」
            // 那一次也算进去 —— 而那一格并没有被"偷"，它是本轮的正常终点。
            // 判据必须与"下面会 continue"逐字同源，否则计数会系统性高一。
            state.turnsConsumedWithoutAssistant++;
            setTransition(state, { type: "timeout_retry" }, deps, sessionState.sessionId);
            log.warn("QUERY_LOOP", `流式超时，重试 ${timeoutRetryCount + 1}/${maxRetries}`);
            // 缺口 4：记录超时重试事件
            emitTimeoutRetry({
              index: state.turnCount,
              attempt: timeoutRetryCount + 1,
              max: maxRetries,
              // 排查可用性修复（2026-08-05）：此前这里填的是 `netTimeouts.maxTurnDurationMs`
              // ——一个**配置常量**（默认 1800000），不是真实耗时。轨迹里于是出现"第 1 次尝试、
              // 开始才几秒，却报 elapsed_ms=1800000（30 分钟）"这种自相矛盾的记录，把排查
              // 直接引向"单轮硬顶超时"的错误方向（真凶是 60s 心跳，差了 30 倍）。
              // 改填本轮真实已耗时——扣除人工等待/退避睡眠，与 turn_hard 判定同一口径。
              elapsed_ms: Math.max(
                0,
                Date.now() - turnStartedAt - humanInputPauseAccumMs - sleepPauseAccumMs,
              ),
              model: config.model,
            });
            // 指数退避 + jitter，避免零延迟重试恶化网关排队
            const backoffMs = computeBackoffMs(
              timeoutRetryCount,
              netTimeouts.retryBackoffBaseMs,
              netTimeouts.retryBackoffMaxMs,
            );
            // TUI 去重：不再 yield system 文本打进消息流，改上报 RetryStatus 通道（带实时倒计时），
            // 与 fallback 引擎的 onRetry/onFallback 共用同一个组件，避免消息流出现重复提示行。
            deps.reportRetryStatus?.({
              kind: "retry",
              attempt: timeoutRetryCount + 1,
              delayMs: backoffMs,
              model: config.model,
              error: "请求超时",
            });
            // 退避期可被会话级 abort 打断（不再死等满 backoffMs）。
            // 根因（轨迹 20260730-142920-d98e7f16）：退避用裸 setTimeout 睡满，期间
            // 会话级硬顶 abort 了也感知不到，醒来直接 continue 发下一个请求——实测
            // 07:37:49.077 触发 session-timeout abort，07:37:53.491 仍发出 BeforeModel
            // idx=47。UI 上先弹「会话已运行超过 60 分钟，已自动结束本轮」，紧接着又弹
            // 「⟳ 正在重试（第 1 次）…」，两个状态机各说各话。
            // 修法：sleep 期间挂 abort 监听提前唤醒，醒来后再复检一次 signal。
            await sleepUnlessAborted(backoffMs, deps.getAbortSignal());
            // Fix 2：重试前清除本轮旧快照，防止看门狗读到上次失败的脏 lastContentProgressAt 立即误杀
            clearStreamSnapshot(state.turnCount);
            // 退避结束后复检：会话已被 abort 就不再发起新请求，交给下方统一收尾。
            // 只认「会话级 signal」——turn 级子 signal 每轮 race settle 后都会被主动
            // abort("race-settled")，拿它判会不会把正常重试全掐掉。
            const abortedDuringBackoff = deps.getAbortSignal();
            if (abortedDuringBackoff?.aborted) {
              const r = abortedDuringBackoff.reason;
              log.warn(
                "QUERY_LOOP",
                `退避期间会话被中断（reason=${String(r ?? "unknown")}），放弃本次重试并收尾`,
              );
              // ─── P0-b 根治：本分支必须自己给用户一句话（事故 20260801-175042-699f69f8）───
              //
              // 原注释写的是"专属提示由 app.ts catch 分支统一给出"，但这个前提是错的：
              // 本分支走的是 `yield done; return`——**正常返回，不抛异常**。链路是
              //   loop.ts(yield done) → engine.ts:399(收到 done 即 return，不抛)
              //   → app.ts:6041 case "done" → completedNormally = true
              // app.ts 里那段为 session-timeout 精心准备的文案（app.ts:6283）和持久
              // hint 全在 **catch 块**里，永远不会被执行；completedNormally=true 还顺带
              // 跳过了 app.ts:6129 的"⚠️ 任务异常中断"兜底。
              // 结果就是那次事故的现象：任务停了，TUI 上一个字都没有。
              //
              // 两个状态机各说各话的正解不是"让其中一个闭嘴"，而是"谁真正执行到就由谁说"。
              // 此处 yield 的是唯一会被用户看到的说明，不存在重复风险（catch 分支这条
              // 路径根本进不去）。
              const sleepNote = describeSleep();
              const reasonText = isSessionTimeoutAbortReason(r)
                ? `本轮连续执行超过 ${Math.round(netTimeouts.maxSessionDurationMs / 60000)} 分钟上限，已自动收尾。直接输入指令即可接着做（会话未结束，上下文保留）。`
                : r === "user-cancel"
                  ? "已取消当前响应。"
                  : `请求重试期间会话被中断（${String(r ?? "unknown")}），本轮已收尾。直接输入指令即可接着做。`;
              yield {
                kind: "system",
                level: isSessionTimeoutAbortReason(r) || r === "user-cancel" ? "info" : "error",
                text: sleepNote ? `${reasonText}\n${sleepNote}。` : reasonText,
              };
              yield {
                kind: "done",
                turns: state.turnCount,
                // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
                turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
                incompleteReason: (state.incompleteReason = "aborted"),
              };
              exitedViaReturn = true;
              return;
            }
            continue;
          }
          // 缺口 4：记录超时重试耗尽事件
          emitTimeoutRetryExhausted({
            index: state.turnCount,
            attempts: maxRetries,
            model: config.model,
          });
          log.error("QUERY_LOOP", `流式超时重试耗尽`);
          // HC24：API 错误（超时重试耗尽）结束本轮
          fireStopFailure(hookSystem, err, "timeout");

          // 重试耗尽：yield 用户可见的错误提示，含配置逃生通道
          yield {
            kind: "system",
            level: "error",
            text:
              `⚠️ 模型请求超时（已重试 ${maxRetries} 次），本轮对话中断。\n` +
              `当前无进展超时阈值: ${netTimeouts.watchdogNoProgressMs / 1000}s，首字节超时: ${netTimeouts.headerTimeoutMs / 1000}s\n` +
              `可在 ~/.sid-code/settings.json 的 network.watchdogNoProgressMs / network.headerTimeoutMs 放宽，` +
              `或设置环境变量 SID_CODE_WATCHDOG_NO_PROGRESS_MS / SID_CODE_RESPONSE_HEADER_TIMEOUT_MS 覆盖。\n` +
              `请重新发送消息继续。`,
          };
          // 优雅退出：yield done 让 TUI 正确切换回"等待输入"状态。
          // 16 号 C2：SDK 不得把这次收尾读成 success（Harbor 会记 sid_subtype=success）。
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            incompleteReason: (state.incompleteReason = "timeout_retry_exhausted"),
          };
          exitedViaReturn = true;
          return;
        }

        // 流式阶段的 prompt-too-long 错误恢复（与连接阶段逻辑一致）
        if (isPromptTooLongError(err) && !state.hasAttemptedReactiveCompact) {
          log.warn("QUERY_LOOP", "流式阶段检测到 prompt-too-long 错误，触发响应式压缩");
          // S6：必须在 reactiveCompact **之前**——压缩会把 lastActualInputTokens 清零。
          learnAdmittedCeilingOnOverflow(ctxMgr, config);
          const compactResult = reactiveCompact(ctxMgr);
          if (compactResult.success) {
            // P0-2：one-shot 标志位，只在此成功路径置真；不得在任何 continue 分支重置为
            // false（见 types.ts LoopState.hasAttemptedReactiveCompact 注释的 CC 教训）。
            state.hasAttemptedReactiveCompact = true;
            setTransition(state, { type: "reactive_compact" }, deps, sessionState.sessionId);
            state.goalReminderPendingAfterCompact = true;
            state.todoReminderPendingAfterCompact = true;
            state.deferredToolsPendingAfterCompact = true;
            // 计数清零与 notifyCompaction 都由 settleCompaction 在确认真压动后统一做
            const { banner } = settleCompaction(deps, sessionState.sessionId, compactScope, {
              trigger: "prompt_too_long_stream",
              messageCountBefore: compactResult.messageCountBefore,
              messageCountAfter: compactResult.messageCountAfter,
              tokensBefore: compactResult.tokensBefore,
              tokensAfter: compactResult.tokensAfter,
              strategy: compactResult.strategy,
            });
            if (banner) yield banner;
            // P1-13：reactiveCompact 此前完全绕过压缩后收尾（只埋点 + 抑制 cache-break 误报）。
            // PTL 恰恰是「窗口已经爆了」的恢复路径，压完模型最需要最近文件，
            // 偏偏这条路不重注入——用户体感就是「报了个超长、压完断片」。
            // 放在 banner 之后：settleCompaction 返回非 null 就等于「实测真压动了」，
            // 是这条路径上唯一可靠的「压缩真的发生了」信号。
            if (banner) {
              await deps.postCompactTail?.({
                trigger: "reactive",
                messagesBefore: compactResult.messageCountBefore,
                tokensBefore: compactResult.tokensBefore,
              });
            }
            yield {
              kind: "system",
              level: "info",
              text: `响应式压缩: ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条消息`,
            };
            continue;
          }
          // 失败也必须过 settleCompaction：此前这里手写 +1，这次失败不落 CompactionAttempt。
          // trigger 是 API 已拒收的恢复路径，too_few_messages / no_split_point 在这里仍判 failed（R1）。
          settleCompaction(deps, sessionState.sessionId, compactScope, {
            trigger: "prompt_too_long_stream",
            messageCountBefore: compactResult.messageCountBefore,
            messageCountAfter: compactResult.messageCountAfter,
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter,
            strategy: compactResult.strategy,
            ...(compactResult.noopReason ? { noopReason: compactResult.noopReason } : {}),
          });
          log.warn("QUERY_LOOP", "响应式压缩失败，尝试 autoCompact");
        }

        // prompt-too-long 兜底：autoCompact 后重试
        if (isPromptTooLongError(err)) {
          // P2-2 熔断：连续压缩失败达阈值 → 不再尝试注定失败的压缩，如实告知用户并结束本轮。
          // 不熔断的后果（CC 前车之鉴）：同一个压不动的历史每轮重试，单会话烧掉数千次调用。
          // 判据读 settleCompaction 唯一维护的状态位：阈值档在本条消息内已开闸时，
          // 同一段历史已证明压不动，这里不再给 LLM 摘要一次机会。
          // 语义保持「终止本轮」：API 已拒收，跳过压缩再发同一个请求只会无限空转。
          if (state.compactCircuitOpen) {
            log.error(
              "QUERY_LOOP",
              `连续 ${state.consecutiveCompactFailures ?? 0} 次压缩失败，熔断已开启，停止自动压缩尝试`,
            );
            yield {
              kind: "system",
              level: "error",
              terminal: true,
              text: buildCompactCircuitBreakerText(state.consecutiveCompactFailures ?? 0, {
                fixedTokens: ctxMgr.estimateFixedOverheadTokens(toolRegistry.size()),
                totalTokens: ctxMgr.estimateTokens(toolRegistry.size()),
                memoryTokens: ctxMgr.getMemoryTokens(),
                maxTokens: ctxMgr.getMaxTokens(),
                latestUserInputTokens: ctxMgr.estimateLatestUserInputTokens(toolRegistry.size()),
              }),
            };
            yield {
              kind: "done",
              turns: state.turnCount,
              // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            };
            exitedViaReturn = true;
            return;
          }
          const beforeFallback = ctxMgr.messageCount();
          // 同源 token（不套锚点）：此前这是唯一只传消息数的调用点，原地替换类压缩会被判失败。
          const overflowTokensBefore = ctxMgr.estimateTokensFor(
            ctxMgr.getMessages(),
            toolRegistry.size(),
          );
          await deps.autoCompact();
          const overflowTokensAfter = ctxMgr.estimateTokensFor(
            ctxMgr.getMessages(),
            toolRegistry.size(),
          );
          state.goalReminderPendingAfterCompact = true;
          state.todoReminderPendingAfterCompact = true;
          state.deferredToolsPendingAfterCompact = true;
          {
            // 计数（P2-6 的清零 / +1）由 settleCompaction 唯一维护。恢复路径不许 noop，
            // 所以 autoCompact 的 skipped 原因不传进来——在这里没压动就是失败。
            const { banner } = settleCompaction(deps, sessionState.sessionId, compactScope, {
              trigger: "context_overflow",
              messageCountBefore: beforeFallback,
              messageCountAfter: ctxMgr.messageCount(),
              tokensBefore: overflowTokensBefore,
              tokensAfter: overflowTokensAfter,
            });
            if (banner) yield banner;
          }
          setTransition(state, { type: "context_overflow_retry" }, deps, sessionState.sessionId);
          continue;
        }

        // P0-2：未识别的错误一律重新抛出，绝不吞掉后继续走到下面的 response 处理逻辑。
        // 本 catch 块的每条路径要么 continue（重试）、要么 yield done 后 return（重试耗尽，
        // 见上面的超时分支）、要么在此 throw——没有任何路径会"降级"出一个假的 response
        // 对象混进正常流程，这正是下面 isEndTurnLike 白名单判断天然不会被 API 错误触发的
        // 另一半保证。
        // HC24：API 错误结束本轮 → StopFailure（用户中断不算 API 失败）
        if (!isAbortError(err) && !turnAbortController.signal.aborted) {
          fireStopFailure(hookSystem, err);
        }
        throw err;
      }
      const apiDuration = perfHandle.end({ model: config.model });
      // P1-2：在清零 timeoutRetryCount 之前捕获"本轮是否发生过重试"，供下方 cache break
      // 归因标注（重连会重发相同前缀，服务端缓存可能已过期/换节点 → 命中脱落）。
      const turnPrecededByRetry = state.timeoutRetryCount > 0;
      // Fix 7：本轮成功拿到 response（未抛出 timeout 异常）→ 重置超时重试计数。
      // 注意：不能放在 while 循环顶部——timeout continue 也会回到那里，导致每次
      // 重试后立即被清零，使"连续超时重试"永远达不到 maxTimeoutRetries（变成无限
      // 重试直到 maxTurns 耗尽而非按预期判定超时失败）。只有真正跳出 timeout 循环、
      // 拿到有效 response 时重置，才能同时满足"当前请求重试计数正确递增"与
      // "跨轮次不会永久丧失重试能力"（隐患 6）两个要求。
      state.timeoutRetryCount = 0;
      // M5：模型真的返回了响应，本轮开头送达的通知它已看过——下一次推进纪元从此成立。
      modelRespondedSinceTurnMark = true;

      // ─── A2：流式响应后检测 abort，优雅收尾 ───
      // 对标 claude-code：用户在流式输出期间按 ESC，此处已拿到 response 但尚未做任何后续处理。
      // 若 response 含 tool_use，先把 assistant 的 tool_use 入历史、再补 cancel result，保持协议配对；
      // 然后 yield done + return 优雅结束（绝不 return 数据——消费者 for await 收不到 generator 返回值）。
      {
        const abortSignal = deps.getAbortSignal();
        if (abortSignal?.aborted) {
          const pendingToolUses = response.content.filter(
            (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
          );
          if (pendingToolUses.length > 0) {
            // ★第二层·预防(根治死循环导火索):中断收尾时明确回执"这一步没有落地",
            // 而非只说"用户取消"。历史死循环正是"超大 edit 被中断 → 模型误以为已执行 →
            // 空转确认到底做没做"。给一条无歧义的未落地事实,消除"以为已做"的幻觉——
            // 恢复会话/续接下一轮时模型据此重发,不会陷入"就差最后一步"的空转。
            const cancelResults = pendingToolUses.map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content:
                `此工具调用(${b.name})被中断,未执行——这一步没有落地,工作区未因它发生任何改动。` +
                `若仍需完成,请在下次继续时重新发出完整调用(内容较大时分段写入)。`,
              is_error: true,
            }));
            ctxMgr.addMessage({ role: "assistant", content: response.content });
            ctxMgr.addMessage({ role: "user", content: cancelResults });
            // B2：此分支直接 yield done，不会再 yield assistant_message，故 engine 不会持久化该 assistant。
            // 在此一并落盘 assistant + cancel，保持 jsonl 与内存历史一致、tool_use/result 配对完整。
            try {
              deps.sessionStore?.appendMessage({ role: "assistant", content: response.content });
              deps.sessionStore?.appendMessage({ role: "user", content: cancelResults });
            } catch (e) {
              // 静默-5：持久化失败不阻断收尾，但不再空吞——记 warn 以便排查
              // "abort 后 jsonl 缺失 assistant/cancel 配对"这类问题（恢复时可能 tool_use/result 不匹配）。
              log.warn("QUERY_LOOP", `abort 收尾持久化失败（不阻断）: ${(e as Error)?.message}`);
            }
          }
          log.info("QUERY_LOOP", "流式响应后检测到 abort，优雅收尾（reason=aborted_streaming）");
          yield { kind: "system", level: "info", text: "请求已被取消" };
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            incompleteReason: (state.incompleteReason = "aborted"),
          };
          exitedViaReturn = true;
          return;
        }
      }

      // ─── 更新用量统计 ───
      // config.baseURL 是 resolveCurrentModelConfig 回填的当前模型端点，传入使计费按
      // (model, endpoint) 复合键精确匹配——同名不同渠道（如 ali-/tx-/origin- 前缀）各自计价。
      //
      // D5（多 Provider 层审计）：usage 的归一化口径取**产出它的那个 provider**，不是会话启动时
      // 固化的 config.provider。跨族降级（主 openai / fallback anthropic）时两者不同，
      // 用错口径 promptTotal 实测差 47.5 倍 —— 上下文校准被告知「几乎是空的」→ compact 过晚。
      // 身份由 ModelFallback 在事件上盖章、stream-processor 带到 response 上（事实随数据走），
      // 这里不再按 checkFallbackOccurred() 之类的信号二次推导。
      const usageProvider = response.usageProvider ?? config.provider;
      sessionState.updateUsage(
        config.model,
        response.usage,
        apiDuration,
        usageProvider,
        config.baseURL,
      );
      const thisCost = sessionState.calculateCost(
        config.model,
        response.usage,
        usageProvider,
        config.baseURL,
      );

      // ─── P1-6/P1-7：用真实 usage 校准上下文估算器 ───
      // 把 provider 原始 usage 归一化为完整 prompt（promptTotal，与厂商无关），
      // 喂给 ctxMgr 作校准锚点：收敛估算偏差 + 防止 compact 因启发式低估而触发过晚。
      try {
        const norm = normalizeCacheUsage(response.usage, usageProvider);
        ctxMgr.recordActualTokens(norm.promptTotal, toolRegistry.size());
      } catch {
        /* 校准失败绝不影响主循环 */
      }

      // ─── D1：缓存中断检测与归因 ───
      // 比对本次 cacheRead 与上次，骤降时归因到 system/tools/model 变化，落入最近中断环形缓冲（供 /cache --breaks）。
      try {
        const cacheRead = response.usage.cacheReadInputTokens ?? 0;
        const breakReport = checkResponseForCacheBreak({
          cacheReadTokens: cacheRead,
          systemPrompt: typeof sendParams.system === "string" ? sendParams.system : "",
          toolSchemas: (sendParams.tools ?? []).map((t) => ({ ...t, name: t.name })),
          model: config.model,
          messageCount: sendParams.messages.length,
          betaHeaders: currentBetaHeaders(config.provider),
          agentId: "main",
          precededByRetry: turnPrecededByRetry, // P1-2：分离重试触发脱落 vs 纯服务端波动
        });
        if (breakReport) {
          recordCacheBreak({
            ...breakReport,
            ts: Math.floor(Date.now() / 1000),
            model: config.model,
          });
          log.warn("CACHE_BREAK", formatCacheBreakReport(breakReport));
        }
      } catch {
        /* 中断检测失败绝不影响主循环 */
      }

      // 缓存节省：与 thisCost 走**同一个** SessionState（同 provider + 同 baseURL 端点价），
      // 也与 /cost 累加的 stats.cacheSavingsUSD 同一个函数 —— 单一事实源。
      // 曾经走 tokenMeter.calculateCacheSavings（不传 baseURL），而 metric 侧又拿带 baseURL 的
      // thisCost 去减不带 baseURL 的全价，于是同一次调用 span 与 metric 给出两个数
      // （2026-10-08 实测 0.0661 vs 0.0858），两个都不等于 /cost 显示的那个。
      // 这个值同时经 AfterModel 透传给 TokenMeter.record，metric 不再自己另算。
      const cacheSavingsUSD = sessionState.calculateSavings(
        config.model,
        response.usage,
        usageProvider,
        config.baseURL,
      );

      if (loopConfig.quotaManager) {
        loopConfig.quotaManager.recordRequest(
          response.usage.inputTokens + response.usage.outputTokens,
        );
      }

      // ─── 预算追踪器检查 ───
      // 告警与硬停是两个判据（2026-10-22 修「超限只拦一次」）：
      // - recordTurn 返回的是**告警升级事件**，exceeded 触发一次之后恒为 undefined，只用于播报；
      // - 硬停每轮都问 findBlockingRule()，超限后每一轮都拦，直到 /clear 或周期翻篇。
      // 记账口径是会话有效总花费的增量（含影子调用），与下面 costLimit 同口径。
      if (loopConfig.budgetTracker) {
        const budgetAlert = loopConfig.budgetTracker.recordTurn(
          sessionState.getEffectiveTotalCostUSD(),
          thisCost,
          { model: config.model },
        );
        const blocking = loopConfig.budgetTracker.findBlockingRule();
        if (blocking) {
          // 刚升级到 exceeded 才说「自动停止」；之后每轮说「仍拦截」，不重复播报同一句
          const justExceeded =
            budgetAlert?.level === "exceeded" && budgetAlert.ruleId === blocking.rule.id;
          const amounts = `$${formatBudgetUsd(blocking.currentUSD, 4)} / $${formatBudgetUsd(blocking.rule.limitUSD, 2)}`;
          yield {
            kind: "system",
            level: "warning",
            terminal: true,
            text: justExceeded
              ? `预算规则 "${blocking.rule.name}" 已超限（${amounts}），自动停止`
              : `预算规则 "${blocking.rule.name}" 本周期已超限（${amounts}），仍拦截`,
          };
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            // F1：硬停必须显式声明，否则收尾落 user_interrupt（见 types.ts）。
            budgetExceeded: { source: "budget_rule" },
          };
          exitedViaReturn = true;
          return;
        }
        if (budgetAlert && budgetAlert.level !== "exceeded") {
          const pct = (budgetAlert.percentage * 100).toFixed(0);
          yield {
            kind: "system",
            level: "warning",
            text: `预算规则 "${budgetAlert.ruleName}" 已达 ${pct}%（$${formatBudgetUsd(budgetAlert.currentUSD, 4)} / $${formatBudgetUsd(budgetAlert.limitUSD, 2)}）`,
          };
        }
      }

      // ─── 成本配额检查 ───
      if (loopConfig.quotaManager) {
        // 纳入辅助调用花费（标题/记忆/分类/摘要/预热等），避免影子调用烧钱不受限。
        const effectiveCost = sessionState.getEffectiveTotalCostUSD();
        // check() 只在级别升级时返回（告警去重）；硬停另问 isExceeded()，每轮都拦。
        // 两者共用一个判据时，exceeded 触发一次后恒为 null，costLimit 名存实亡（2026-10-22 实测）。
        const quotaResult = loopConfig.quotaManager.check(effectiveCost);
        if (loopConfig.quotaManager.isExceeded(effectiveCost)) {
          const text =
            quotaResult?.level === "exceeded"
              ? quotaResult.message
              : loopConfig.quotaManager.stillExceededMessage(effectiveCost);
          yield { kind: "system", level: "warning", terminal: true, text };
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            // F1：与本地预算硬停同一条归因通道（见 types.ts budgetExceeded）。
            budgetExceeded: { source: "quota" },
          };
          exitedViaReturn = true;
          return;
        }
        if (quotaResult && (quotaResult.level === "critical" || quotaResult.level === "warning")) {
          yield { kind: "system", level: "warning", text: quotaResult.message };
        }
      }

      // ─── 远程预算检查（M5；在本地 BudgetTracker / QuotaManager 之后）───
      // 不改本地 costLimit 硬停。远程默认 alert 只 warning；block 才与本地 exceeded 同款 done。
      // 两条同时存在时都检查，先到先停，数字不合并。
      {
        const remote = checkLoadedRemoteBudget(
          sessionState.sessionId,
          sessionState.getEffectiveTotalCostUSD(),
        );
        if (remote.kind === "ok" && remote.exceeded) {
          const text = formatRemoteBudgetWarning(remote);
          if (remote.enforcement === "block") {
            yield { kind: "system", level: "warning", terminal: true, text };
            yield {
              kind: "done",
              turns: state.turnCount,
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
              // F1：远程 block 与本地硬停同一条归因通道（见 types.ts budgetExceeded）。
              budgetExceeded: { source: "remote" },
            };
            exitedViaReturn = true;
            return;
          }
          yield { kind: "system", level: "warning", text };
        }
      }

      log.llmResponse(
        response.stopReason || "unknown",
        response.usage,
        apiDuration,
        sessionState.totalCostUSD,
      );

      // ─── P2（9bc92c2c）：processStream 成功返回后立即记录原始 AfterModel 事件 ───
      // 确保即使后续 content 解析/hook 触发崩溃，events.jsonl 中也有 AfterModel 痕迹，
      // 消除"有 BeforeModel 无 AfterModel"的诊断盲区。
      try {
        getSessionMetrics()?.incrementCounter("after_model_raw", 1);
        log.info(
          "QUERY_LOOP",
          `AfterModelRaw: stop=${response.stopReason}, in=${response.usage.inputTokens} out=${response.usage.outputTokens}, blocks=${response.content.length}`,
        );
      } catch {
        /* 纯观测，不影响主循环 */
      }

      // ─── 提取响应文本 ───
      const responseText = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      if (responseText) {
        log.llmResponseText(responseText);
      }

      // ─── S1 / S4 可见性：本 prompt 的累计事实 + 上一次 promise nudge 的结果 ───
      // 「上一次模型调用是否含 tool_use」必须在本轮覆盖之前取出来（L1 形态判定要用）。
      // D7：这里看的是响应 content 里有没有 tool_use 块，不是 `stop_reason === "tool_use"`。
      // 两者只在「声称 end_turn 却带 tool_use」的 fall-through 下分叉；那种响应会照常派发工具，
      // 对「承诺发生在工具之后」而言按块判才是事实，故刻意不跟方案字面的 stop_reason。
      const prevResponseHadToolUse = state.prevResponseHadToolUse === true;
      state.prevResponseHadToolUse = response.content.some((b) => b.type === "tool_use");
      saveS1Carry();
      // B1：本次响应是否在回应刚注入的 nudge —— 必须在下面清 pendingPromiseNudge 之前取。
      const respondingToPromiseNudge = pendingPromiseNudge !== undefined;
      state.promptOutputTokens =
        (state.promptOutputTokens ?? 0) + (response.usage.outputTokens ?? 0);
      state.promptReasoningTokens =
        (state.promptReasoningTokens ?? 0) + ((response.usage as any).reasoningTokens ?? 0);
      if (pendingPromiseNudge) {
        // outcome = nudge 之后这一轮模型有没有真的调工具 —— 这就是 L2 的验收曲线
        emitPromiseNudge(pendingPromiseNudge.lang, true, {
          outcome: state.prevResponseHadToolUse ? "tool_use" : "text",
        });
        pendingPromiseNudge = undefined;
      }

      // ─── 缺口3：假设纪律引导的事件驱动注入（检测端）───
      // 根因：原引导绑死 turnCount===1（任务开头），而模型在第 1 轮通常还没形成任何判断
      // ——提示到达时无对应物可登记；等到第 10-30 轮真正形成"我认为是 X"时，那条提示已被
      // 几十轮工具输出冲远。这里改成在**模型刚写下断言之后**注入，时机才对得上。
      //
      // 两个信号（文档 §缺口3 按可靠性排序的前两条）：
      //   signal A `judgment`：assistant 文本含判断性表述（"根因是"/"这说明"…）;
      //   signal B `probe-to-edit`：连续 read/grep 后首次 edit/write——从"查"转入"改"
      //     说明已下结论。它覆盖 A 抓不到的情形：模型可以一句解释都不写就直接开始改，
      //     那时判断同样已形成、同样未登记。
      //
      // 三重降误报（引导是软提醒，但反复提醒同样是负收益）：
      //   1. 只在登记表**为空**时触发——已经在用这套机制的会话不需要被教;
      //   2. 会话级一次性（hypothesisEventGuideInjected）;
      //   3. 判据只看表层特征，不做语义理解（保守，宁可漏不可扰）。
      if (!state.hypothesisEventGuideInjected && deps.getHypothesisLedger) {
        try {
          const ledger = deps.getHypothesisLedger();
          // 登记表非空 = 模型已在用这套机制，不必再引导（这条是主要的降误报手段）。
          if (ledger && ledger.isEmpty()) {
            const turnToolNames = response.content
              .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
              .map((b) => b.name);
            // 累积"本会话是否有过只读探查"——signal B 的前置条件。挂 SessionState 而非
            // LoopState：探查可能发生在上一条用户消息里，LoopState 每条消息新建会丢。
            if (hasReadOnlyProbe(turnToolNames)) {
              sessionState.set("hypothesisSawReadOnlyProbe", true);
            }
            const sawProbe = sessionState.get("hypothesisSawReadOnlyProbe") === true;
            let trigger: "judgment" | "probe-to-edit" | undefined;
            if (responseText && detectUnregisteredJudgment(responseText)) {
              trigger = "judgment";
            } else if (detectInvestigateToEditTransition(turnToolNames, sawProbe)) {
              trigger = "probe-to-edit";
            }
            if (trigger) {
              state.pendingJudgmentGuide = true;
              state.hypothesisEventGuideInjected = true;
              log.info(
                "QUERY_LOOP",
                `缺口3：检测到刚形成的未登记判断（${trigger}），下一轮注入假设登记引导`,
              );
              if (deps.traceAppendEvent) {
                try {
                  deps.traceAppendEvent({
                    event: "HypothesisGuideInjected",
                    session_id: sessionState.sessionId,
                    timestamp: new Date().toISOString(),
                    data: {
                      ...turnMetrics(state, sessionState, promptSeq),
                      // trigger 区分三条注入通道：`turn-1`（降级兜底）/`judgment`/
                      // `probe-to-edit`。分开计数才能回答"改注入时机后采纳率提升了多少"
                      // ——否则三条通道混在一个事件名下无法归因。
                      trigger,
                      textPreview: responseText.slice(0, 200),
                    },
                  });
                } catch {
                  /* trace 写入失败不阻断 */
                }
              }
            }
          }
        } catch {
          /* 观测类检测，异常不阻断主循环 */
        }
      }

      // ─── AfterModel hook ───
      if (hookSystem) {
        const afterModelResult = await hookSystem.fireAfterModelEvent(
          {
            model: sendParams.model,
            messages: sendParams.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            })),
            raw_messages: sendParams.messages,
            system: sendParams.system,
            tools: sendParams.tools,
          },
          {
            text: responseText,
            content_blocks: response.content,
            stop_reason: response.stopReason ?? undefined,
            thinking_blocks: (response as any)._thinkingBlocks,
            usage: {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              cacheReadInputTokens: (response.usage as any).cacheReadInputTokens,
              cacheCreationInputTokens: (response.usage as any).cacheCreationInputTokens,
              // 缺口分析二类：reasoning token 透传给采集器（thinking 模型隐藏成本单独计）
              reasoningTokens: (response.usage as any).reasoningTokens,
            },
            cost_usd: thisCost,
            api_duration_ms: apiDuration,
            cache_savings_usd: cacheSavingsUSD,
            // 首个任意内容 chunk 的 TTFT（与 StreamPhase(first_content) 同值），纯 tool_use 轮也有
            ttft_ms: takeFirstContentTtft(state.turnCount),
            // D5：与上面归一化同一个身份 —— 轨迹的 context_usage_ratio 由 collector 按它归一化
            provider: usageProvider, // T12.3：Provider 维度标记
            base_url: config.baseURL, // 端点维度：区分同模型不同渠道，便于排查 + 重算精确计费
            // P2-6：取走 provider 侧暂存的网关请求标识（读一次即清，见 api/request-id.ts）。
            // 取走时机必须是**本轮组装 AfterModel 时**：早了拿不到（响应头还没来），
            // 晚了会被下一轮的请求覆盖。
            gateway_request_id: takeLastRequestId(),
            // L3-A：工具参数质量事实（聚合整数），让 F1 判定可从 events.jsonl 离线复算。
            tool_use_facts: summarizeToolUseParams(response.content, (name) =>
              toolRegistry.get(name)?.inputSchema(),
            ),
          },
        );
        if (afterModelResult.finalOutput?.isBlockingDecision()) {
          log.info(
            "HOOK",
            `AfterModel hook 阻止响应: ${afterModelResult.finalOutput.getEffectiveReason()}`,
          );
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }
        if (afterModelResult.finalOutput?.shouldStopExecution()) {
          log.info(
            "HOOK",
            `AfterModel hook 停止执行: ${afterModelResult.finalOutput.getEffectiveReason()}`,
          );
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }
      }

      // ─── 流式降级检测与 Tombstone ───
      if (deps.checkFallbackOccurred?.()) {
        log.info("QUERY_LOOP", "检测到模型降级，yield tombstone 通知上层清理残留内容");
        // 降级发生时，已经推送给 UI 的部分 assistant 消息需要撤回
        const assistantMsg = { role: "assistant" as const, content: response.content };
        yield { kind: "tombstone", message: assistantMsg, reason: "模型降级，使用备用模型重试" };
        deps.resetFallbackFlag?.();
        // 注意：降级后 response 已经是备用模型的完整响应，不需要重试
      }

      // ─── F1：空参数 tool_use 退化检测与重试（DeepSeek 大上下文兜底）───
      // 根因：模型生成 tool_use 声明但参数为空（input={}），并以 end_turn 自行停止。
      // 不干预则走到下方 end_turn 分支直接退出、永不重试 → 任务卡死。
      // 处理：①把空参数 tool_use 替换为 text（消除孤儿，避免 OpenAI 400）；
      //      ②重试前先压缩上下文（reactiveCompact），让 input tokens 单调下降，
      //        直接打击"大上下文"根因，而非原样追加提示重发（那只会加剧退化）；
      //      ③最多重试 MAX_EMPTY_PARAM_RETRIES 次，耗尽后**硬停本轮**（sanitized 后入历史 +
      //        如实呈现退化 + yield done，不假装完成，也不 fall-through 到收尾闸门链）。
      //
      // P2-7：这两行注释此前写的是「耗尽后放行（替换后的 content 已无 tool_use，会正常走
      // end_turn 结束）」，而实现一直是就地 `yield done; return`。文档与代码不一致，且
      // 二者的语义差别很实在：走 end_turn 会跑 AfterAgent / Stop Hook / unanswered / todo /
      // hypothesis / Goal 整条闸门链，硬停一条都不跑。
      //
      // 选定**硬停**、改注释对齐实现，而不是反过来让代码 fall-through：
      //   - 走到这里的事实是「模型连续 MAX_EMPTY_PARAM_RETRIES 次吐不出工具参数」，
      //     即模型在当前上下文下已退化。闸门链的每一道门（todo/hypothesis/Goal）都是
      //     **靠注入提示再续一轮**来起作用的 —— 对一个连参数都生成不出来的模型，
      //     续命只会把同一个退化再跑一遍，这正是 CC「死亡螺旋」那条教训的形态
      //     （见下方 isEndTurnLike 白名单处的 P0-2 注释）。
      //   - 本轮 stopReason 并不一定是 end_turn（实测也有 max_tokens/null 走到这里），
      //     fall-through 还要先伪造一个 end_turn 语义，那是把退化包装成正常收尾。
      // 唯一真正的缺陷是遥测归因（下方 turnStopReason 处修掉），不是控制流。
      // 注入工具 schema 查询：让检测器结合 required 字段区分"真退化"与"本就无必填参数"
      // （如 enter_plan_mode 的合法 input={} 不应被误判为退化，否则 plan mode 永远进不去）。
      const getSchema = (name: string) => toolRegistry.get(name)?.inputSchema();
      const emptyParamHits = detectEmptyParamToolUses(response.content, getSchema);
      if (emptyParamHits.length > 0) {
        const names = emptyParamHits.map((h) => h.name).join("、");
        // 始终先把空参数 tool_use 替换为 text，再入历史（无论是否还重试，都要消除孤儿）
        const sanitizedContent = replaceEmptyParamToolUses(response.content, getSchema);

        const retries = state.emptyParamRetryCount ?? 0;
        if (retries < MAX_EMPTY_PARAM_RETRIES) {
          state.emptyParamRetryCount = retries + 1;

          ctxMgr.addMessage({
            role: "assistant",
            content: sanitizedContent,
            ...(response._meta ? { _meta: response._meta } : {}),
          });
          yield {
            kind: "assistant_message",
            message: { role: "assistant", content: sanitizedContent },
            persistMeta: {
              usage: {
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                cacheReadInputTokens: (response.usage as any).cacheReadInputTokens,
                cacheCreationInputTokens: (response.usage as any).cacheCreationInputTokens,
              },
              model: config.model,
              stopReason: response.stopReason ?? undefined,
              msgId: (response as any).id ?? undefined,
            },
          };

          // ─── P0-2：空参数重试的压缩必须过「上下文占用率」门禁 ───
          //
          // 事故背景（2026-07-29）：这里原本**无条件**调 reactiveCompact——完全不看占用率。
          // 那次会话峰值占用只有 17.6%（1M 窗口），任何阈值压缩路径都没触发过，却因为模型吐了
          // 一个坏 JSON（evidence 值漏引号）走到这条重试路径，于是"压缩"了一把：横幅画出
          // 「对话已压缩」，还给模型注入「系统已为你精简对话上下文」——而消息一条都没少。
          // 用户看到的「占用率才 17% 却突然被压缩」正是从这里来的：**它是根本不该发生的压缩**。
          //
          // 判据走 getCompactionLevel()（阈值判定的单一事实源，与 /context 展示同源，
          // 与 provider 无关）：只有已进入 soft 档及以上，"大上下文加剧模型吐坏参数"这个原始
          // 动机才成立；低占用下空参数是模型偶发退化/截断，压缩既无收益又白烧一次重排。
          const levelBeforeRetry = ctxMgr.getCompactionLevel(toolCount);
          let compactResult: ReactiveCompactResult = {
            success: false,
            messageCountBefore: ctxMgr.messageCount(),
            messageCountAfter: ctxMgr.messageCount(),
            strategy: "none",
          };
          if (levelBeforeRetry === "none") {
            log.info(
              "QUERY_LOOP",
              `F1：空参数重试跳过压缩——上下文占用未达 soft 档（level=none，${ctxMgr.messageCount()} 条消息），` +
                `压缩无收益且会误导模型`,
            );
          } else {
            compactResult = reactiveCompact(ctxMgr);
            if (compactResult.success) {
              log.info(
                "QUERY_LOOP",
                `F1：空参数重试前压缩上下文 ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条（level=${levelBeforeRetry}）`,
              );
              state.goalReminderPendingAfterCompact = true;
              state.todoReminderPendingAfterCompact = true;
              state.deferredToolsPendingAfterCompact = true;
              const { banner } = settleCompaction(deps, sessionState.sessionId, compactScope, {
                trigger: "empty_param_retry",
                messageCountBefore: compactResult.messageCountBefore,
                messageCountAfter: compactResult.messageCountAfter,
                tokensBefore: compactResult.tokensBefore,
                tokensAfter: compactResult.tokensAfter,
                strategy: compactResult.strategy,
              });
              if (banner) yield banner;
              // P1-13：同上，reactiveCompact 压动了就走与 auto/manual 同一套收尾。
              if (banner) {
                await deps.postCompactTail?.({
                  trigger: "reactive",
                  messagesBefore: compactResult.messageCountBefore,
                  tokensBefore: compactResult.tokensBefore,
                });
              }
            } else {
              // 失败也落 CompactionAttempt（此前只手写 +1）。空参数重试是主动压缩（API 没拒收），
              // 消息太少 / 无安全分割点判 noop、不计失败。
              settleCompaction(deps, sessionState.sessionId, compactScope, {
                trigger: "empty_param_retry",
                messageCountBefore: compactResult.messageCountBefore,
                messageCountAfter: compactResult.messageCountAfter,
                tokensBefore: compactResult.tokensBefore,
                tokensAfter: compactResult.tokensAfter,
                strategy: compactResult.strategy,
                ...(compactResult.noopReason ? { noopReason: compactResult.noopReason } : {}),
              });
            }
          }

          // 注入"参数为空请重试"提示
          ctxMgr.addMessage({
            role: "user",
            content: [
              {
                type: "text",
                text: buildEmptyParamRetryMessage(
                  emptyParamHits,
                  state.emptyParamRetryCount,
                  MAX_EMPTY_PARAM_RETRIES,
                  compactResult.success,
                  response.stopReason ?? undefined,
                ),
              },
            ],
          });

          log.warn(
            "QUERY_LOOP",
            `F1：检测到空参数 tool_use「${names}」（stop=${response.stopReason}），` +
              `替换为 text 并重试 ${state.emptyParamRetryCount}/${MAX_EMPTY_PARAM_RETRIES}`,
          );
          yield {
            kind: "system",
            level: "warning",
            text: `检测到工具调用参数为空（模型退化），自动重试 (${state.emptyParamRetryCount}/${MAX_EMPTY_PARAM_RETRIES})`,
          };
          emitEmptyParamRetry(deps, sessionState.sessionId, {
            turn: state.turnCount,
            stopReason: response.stopReason,
            hits: emptyParamHits,
            getSchema,
            attempt: state.emptyParamRetryCount,
            compacted: compactResult.success,
            compactLevel: levelBeforeRetry,
          });
          setTransition(state, { type: "empty_param_retry" }, deps, sessionState.sessionId);
          continue;
        }

        // 重试耗尽：sanitized 后入历史 + 如实呈现退化 + 硬停本轮（理由见上方 ③ 的 P2-7 注释）
        emitEmptyParamRetry(deps, sessionState.sessionId, {
          turn: state.turnCount,
          stopReason: response.stopReason,
          hits: emptyParamHits,
          getSchema,
          attempt: retries + 1,
          compacted: false,
          exhausted: true,
        });
        noteGateExhausted("empty_param", MAX_EMPTY_PARAM_RETRIES, MAX_EMPTY_PARAM_RETRIES);
        log.error(
          "QUERY_LOOP",
          `F1：空参数重试已达上限 ${MAX_EMPTY_PARAM_RETRIES}，工具「${names}」仍参数为空，硬停本轮并如实呈现退化`,
        );
        ctxMgr.addMessage({
          role: "assistant",
          content: sanitizedContent,
          ...(response._meta ? { _meta: response._meta } : {}),
        });
        yield {
          kind: "assistant_message",
          message: { role: "assistant", content: sanitizedContent },
          persistMeta: {
            usage: {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              cacheReadInputTokens: (response.usage as any).cacheReadInputTokens,
              cacheCreationInputTokens: (response.usage as any).cacheCreationInputTokens,
            },
            model: config.model,
            stopReason: response.stopReason ?? undefined,
            msgId: (response as any).id ?? undefined,
          },
        };
        yield {
          kind: "system",
          level: "warning",
          text: `工具调用参数持续为空（已重试 ${MAX_EMPTY_PARAM_RETRIES} 次），模型在当前上下文下无法正常生成工具参数，停止重试。`,
        };
        // P2-7：显式归因「其它提前收尾」。
        //
        // 不赋值的后果是实测过的错账：finally 的统一出口在「未 abort、未打满 maxTurns」时
        // 兜底归到 `error`（那一档的语义是"抛错穿透 finally"）。于是"模型吐不出参数"这类
        // **模型退化**会混进 error 样本里，既虚高错误率，又让真正的异常穿透被稀释得看不见。
        // 选 `other` 而非 `end_turn`：本轮并没有正常说完（见 TurnStopReason 各档注释），
        // 归 end_turn 会把退化算进正常收尾样本，那是反方向的错账。
        turnStopReason = "other";
        // 硬停不是「正常说完」：带 incompleteReason，SDK / 无头不再把模型退化记成 success。
        state.incompleteReason = "empty_param_exhausted";
        yield {
          kind: "done",
          turns: state.turnCount,
          // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
          turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          incompleteReason: state.incompleteReason,
        };
        exitedViaReturn = true;
        return;
      }

      // ─── 添加助手消息到历史 ───
      ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
        ...(response._meta ? { _meta: response._meta } : {}),
      });

      // P1-G3：本次 API 调用的 usage/model/stopReason 随 assistant_message 落盘（按单条回复归因）。
      const assistantPersistMeta = {
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadInputTokens: (response.usage as any).cacheReadInputTokens,
          cacheCreationInputTokens: (response.usage as any).cacheCreationInputTokens,
        },
        model: config.model,
        stopReason: response.stopReason ?? undefined,
        msgId: (response as any).id ?? undefined,
      };
      yield {
        kind: "assistant_message",
        message: { role: "assistant", content: response.content },
        persistMeta: assistantPersistMeta,
      };

      // ─── 内容循环检测 ───
      if (responseText && loopDetector.recordContent(responseText)) {
        const recovered = await recoverFromLoop(loopDetector, ctxMgr, "内容重复模式");
        if (!recovered) {
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }
        yield { kind: "loop_detected", detail: "内容重复模式" };
        yield {
          kind: "loop_recovery",
          attempt: loopDetector.getRecoveryAttempts(),
          maxAttempts: loopDetector.getMaxRecoveryAttempts(),
        };
        setTransition(state, { type: "loop_recovery" }, deps, sessionState.sessionId);
        continue;
      }

      // ─── 方案③：思考发散熔断（早期哨兵，deepseek-reasoning-leak 修复 5.3）───
      // 统计本轮思考字符数并入历史，检测"连续 N 轮单调递增且末轮超阈值"（分析瘫痪的
      // 最早信号）。命中则置 pending 标记，下一轮循环开头经 reminderParts 注入收敛提示
      //（不在此直接插消息，避免破坏 assistant/tool_result 配对——同 pendingContradictions）。
      // 真因⓪修好后此路径应极少触发，留作回归指标。
      // 2026-07-07：整段受 isThinkingDivergenceDetectionEnabled() gate 保护，默认关闭（对齐 CC）。
      // 此前这段绕过 SID_ENABLE_LOOP_DETECTION 全局 gate，用户关不掉；现纳入统一治理。
      if (isThinkingDivergenceDetectionEnabled()) {
        const thinkingLen = measureThinkingLen(response.content as any);
        state.thinkingLenHistory = pushThinkingLen(state.thinkingLenHistory, thinkingLen);
        const interventions = state.thinkingDivergenceInterventions ?? 0;
        if (
          isThinkingDiverging(state.thinkingLenHistory) &&
          interventions < MAX_THINKING_DIVERGENCE_INTERVENTIONS &&
          !state.pendingThinkingDivergenceReminder
        ) {
          state.pendingThinkingDivergenceReminder = true;
          state.thinkingDivergenceInterventions = interventions + 1;
          log.warn(
            "QUERY_LOOP",
            `方案③：检测到思考发散（近${state.thinkingLenHistory.length}轮思考字符 ${state.thinkingLenHistory.join("→")}），` +
              `将于下一轮注入收敛提示 (${state.thinkingDivergenceInterventions}/${MAX_THINKING_DIVERGENCE_INTERVENTIONS})`,
          );
          yield {
            kind: "system",
            level: "warning",
            text: `检测到思考量持续激增（可能陷入分析瘫痪），自动引导收敛 (${state.thinkingDivergenceInterventions}/${MAX_THINKING_DIVERGENCE_INTERVENTIONS})`,
          };
        }
      }

      // ─── P2-1：产出量停滞检测（对齐 CC diminishing-returns 哲学，从产出量而非内容重复角度）───
      // 每轮都记录（tool_use 轮和 end_turn 轮都要，停滞常发生在连续 tool_use 轮），不要求
      // 单调、不要求重复——只要连续 OUTPUT_STALL_WINDOW 轮产出量持续很小就命中。
      // 命中则置 pending 标记，下一轮循环开头经 reminderParts 注入软提醒（同 pendingThinkingDivergenceReminder
      // 机制，不在此直接插消息，避免破坏 assistant/tool_result 配对）。只作提醒，不占用
      // LoopDetector 恢复计数、不会 terminate——这是"可能卡住"的软信号，不是判定循环。
      // 2026-07-07：整段受 isOutputStallDetectionEnabled() gate 保护，默认关闭（对齐 CC）。
      // 此前这段绕过 SID_ENABLE_LOOP_DETECTION 全局 gate，用户关不掉；现纳入统一治理。
      if (isOutputStallDetectionEnabled()) {
        const toolUseCount = response.content.filter((b) => b.type === "tool_use").length;
        const outputVolume = measureTurnOutputVolume(responseText, toolUseCount);
        state.outputVolumeHistory = pushOutputVolume(state.outputVolumeHistory, outputVolume);
        const stallInterventions = state.outputStallInterventions ?? 0;
        if (
          isOutputStalling(state.outputVolumeHistory) &&
          stallInterventions < MAX_OUTPUT_STALL_INTERVENTIONS &&
          !state.pendingOutputStallReminder
        ) {
          state.pendingOutputStallReminder = true;
          state.outputStallInterventions = stallInterventions + 1;
          // 命中后清空历史，避免刚提醒完又因窗口里还残留着旧的低产出值而连续多轮反复触发。
          state.outputVolumeHistory = [];
          log.warn(
            "QUERY_LOOP",
            `P2-1：检测到产出停滞（近 ${OUTPUT_STALL_WINDOW} 轮产出量持续偏低），` +
              `将于下一轮注入提醒 (${state.outputStallInterventions}/${MAX_OUTPUT_STALL_INTERVENTIONS})`,
          );
          yield {
            kind: "system",
            level: "info",
            text: `检测到最近几轮产出量偏低（可能陷入停滞），自动引导确认 (${state.outputStallInterventions}/${MAX_OUTPUT_STALL_INTERVENTIONS})`,
          };
        }
      }

      // ─── 检查停止原因 ───
      // F2：end_turn 兜底——模型有时 stop_reason=end_turn 却在 content 里留下正常参数的 tool_use。
      // 此处的 tool_use 必为非空参数（空参数已被上方 F1 拦截：要么 continue 重试，要么 return）。
      // 若仍有 tool_use，说明模型有未执行的工具调用 → 不在此结束，fall-through 到下方 tool_use 分支
      // 正常执行（复用循环检测 / UI 事件 / followup / tool_result 全套，避免重写执行逻辑）。
      const hasPendingToolUse = response.content.some((b) => b.type === "tool_use");
      // F2 fall-through：end_turn/stop（协议偏差）或 max_tokens/length（截断时已带完整工具）。
      // content_filter 等其它 reason 仍不进 F2，截断续写只留给无 tool_use 的纯文本。
      //
      // P0-2（对齐 CC 死亡螺旋防御）：isEndTurnLike 是白名单匹配（=== "end_turn" || === "stop"），
      // 不是黑名单匹配（!== "error" 之类）。这是下面 AfterAgent hook / Stop Hooks 只在模型真正
      // 产出正常响应时才执行的关键前提——API 错误（无论是上面的 catch 块里被 continue/return/
      // throw 处理掉的异常，还是 processStream 非抛出式返回的 stopReason="error"）都不会匹配这个
      // 白名单，天然不会流入 Stop Hooks。CC 的教训是：error → hook blocking → retry → error → …
      // 的死亡螺旋，根源就是"模型从未真正产出过响应"时仍跑了基于响应内容的验证/修复流程。
      // 如果未来要重构这里的停止原因判断逻辑，必须保持"白名单枚举可继续的情况"这个方向，
      // 不要改成"排除已知的错误情况"——后者每新增一种未识别的错误 stopReason 都会重新
      // 打开这个口子（fail-open），而白名单天然对未知值 fail-closed。
      // stop_sequence（模型撞到配置的 stop 序列）与 end_turn/stop 同属"正常终止"，
      // 必须走完整收尾链（AfterAgent hook / Stop hooks / todo gate / goal gate / session memory 提取），
      // 而不是落到下方"未识别停止原因"分支弹 terminal 警告并跳过全部收尾。
      // 对齐 CC：stop_sequence 在 CC 全源码零特殊处理，直接 fall-through 当正常结束。
      // 白名单方向不变（fail-closed 防死亡螺旋，见上方 P0-2 注释），这里只是补齐一个已知的正常终止 reason。
      //
      // 2026-10-29：判据收敛到 stop-reason-policy.ts 的 classifyStopReason（单一事实源，
      // 子循环 agentic-loop.ts 调同一份）。下方各分支的进入条件都从 stopAction 派生，
      // 不再各自比较 stopReason 字面量——新增一种 stopReason 只改分类器一处。
      // P1-4：max_tokens/length 带着非空 tool_use 时先执行工具（why=f2_truncated），
      // 截断续写只留给纯文本截断。content_filter 等白名单外取值不进 F2。
      const stopAction = classifyStopReason({
        stopReason: response.stopReason,
        hasToolUse: hasPendingToolUse,
        hasAnyContent: response.content.length > 0,
      });
      const isEndTurnLike = stopAction.kind === "finalize";
      const f2FallThrough = stopAction.kind === "execute_tools" && stopAction.why !== "tool_use";
      if (f2FallThrough) {
        // §2.4 / P1-4：stop_reason 与 content 不一致（end_turn/stop 或 max_tokens 仍含 tool_use）。
        // 功能上 F2 fall-through 已能正确执行工具（不漏调），这里只补一条结构化 warn
        // 遥测（不改控制流），把"被动兜住"升级为"主动暴露"。
        // 发现 5：按 (provider, model) 首次 warn、之后只计数，计数走 StopReasonMismatch 事件进 digest。
        const mismatchProvider = response.usageProvider ?? config.provider;
        const mismatchCount = noteStopReasonMismatch(mismatchProvider, sendParams.model);
        if (mismatchCount === 1) {
          log.warn(
            "QUERY_LOOP",
            `stop_reason 与 content 不一致：声称 ${response.stopReason} 但含 tool_use（已自动兜底执行工具；同一 provider/model 后续只计数不再告警）`,
            {
              stopReason: response.stopReason,
              toolUseCount: response.content.filter((b) => b.type === "tool_use").length,
              provider: mismatchProvider,
              model: sendParams.model,
            },
          );
        }
        if (deps.traceAppendEvent) {
          try {
            deps.traceAppendEvent({
              event: "StopReasonMismatch",
              session_id: sessionState.sessionId,
              timestamp: new Date().toISOString(),
              data: {
                stopReason: response.stopReason,
                provider: mismatchProvider,
                model: sendParams.model,
              },
            });
          } catch {
            /* trace 写入失败不阻断主循环 */
          }
        }
      }
      if (isEndTurnLike) {
        // ─── S1 L1：end_turn 形态事实（每次都落，零行为）───
        // 后台任务 / 待投递通知是 L2 的结构排除项，也一并进事实，让「为什么没拦」可复算。
        let runningBg = false;
        let pendingNotif = false;
        try {
          runningBg = hasRunningBackgroundTasks();
          pendingNotif = hasPendingNotifications();
        } catch {
          /* 查询失败按「无」处理：只影响 L2 是否触发，不影响收尾 */
        }
        const endTurnShape = classifyEndTurnShape({
          text: responseText,
          hasToolUse: false,
          prevTurnHadToolUse: prevResponseHadToolUse,
          afterPromiseNudge: respondingToPromiseNudge,
        });
        emitEndTurnShape(endTurnShape, {
          stopReason: response.stopReason ?? undefined,
          outputTokens: response.usage.outputTokens ?? 0,
          reasoningTokens: (response.usage as any).reasoningTokens ?? 0,
          prevTurnHadToolUse: prevResponseHadToolUse,
          runningBackgroundTasks: runningBg,
          pendingNotifications: pendingNotif,
        });
        // AfterAgent hook
        //
        // P2-2：`clearContext` **推迟**到整条闸门链真正放行、`yield done` 之前才执行。
        // 此前是在这里立刻 `ctxMgr.clear()`（= `this.messages = []`），而它发生在
        // Stop Hook / unanswered / Todo / Hypothesis / Token Budget / Goal **之前**：
        // 随后 Stop Hook 往空历史上 addMessage，任何一道门 `continue` 都会把模型送进
        // 下一轮时只剩几条注入消息——清单还在、历史没了，续命等于把模型丢进失忆。
        // 置个标志位、由下方唯一收尾出口执行，语义才与 hook 名字（Agent 之后）一致。
        let afterAgentWantsClearContext = false;
        /**
         * P2-2：执行被推迟的 AfterAgent `clearContext`。
         *
         * 必须在本块每一个「真正收尾」的出口调用（forceStop / unanswered 耗尽 / 正常收尾），
         * 且**只能**在这些出口调用——任何 `continue` 分支都不得调用它，否则就退回到
         * 「闸门链中途清历史」那个 bug。幂等（清完置回 false）。
         */
        const applyDeferredClearContext = (): void => {
          if (!afterAgentWantsClearContext) return;
          afterAgentWantsClearContext = false;
          log.info("HOOK", "AfterAgent hook 请求的清除上下文：闸门链已放行，现在执行");
          ctxMgr.clear();
        };
        if (hookSystem) {
          const userInput = extractLastUserInput(ctxMgr);
          const afterResult = await hookSystem.fireAfterAgentEvent(userInput, responseText);
          // P2-2：hook 执行失败此前完全静默——`executeHooks` 内部吞掉异常后返回
          // `success:false` + errors，而这里既不看 success 也不看 errors，于是
          // 「hook 崩了」与「没配 hook」在日志里一模一样。AfterAgent 按设计不可 block
          // （见 hook/types.ts），所以这里**只观测不改控制流**：至少让排查有落点。
          if (afterResult.success === false) {
            log.warn(
              "HOOK",
              `AfterAgent hook 执行失败（不阻断收尾，按设计不可 block）：` +
                (afterResult.errors ?? []).map((e) => e?.message ?? String(e)).join("; "),
            );
          }
          if (afterResult.finalOutput?.shouldClearContext()) {
            log.info("HOOK", "AfterAgent hook 请求清除上下文（推迟到闸门链放行后执行）");
            afterAgentWantsClearContext = true;
          }
        }

        // ─── Stop Hooks 自动修复循环 ───
        if (hookSystem) {
          const { handleStopHooks } = await import("./stop-hooks.ts");
          const stopHookGen = handleStopHooks(
            hookSystem,
            ctxMgr,
            responseText,
            state.stopHookRetryCount ?? 0,
          );
          let stopResult: import("./stop-hooks.ts").StopHookResult | undefined;

          // 消费 stop hook generator 的 yield（system 消息等）
          while (true) {
            const next = await stopHookGen.next();
            if (next.done) {
              stopResult = next.value;
              break;
            }
            yield next.value; // 转发 system 消息给上层
          }

          if (stopResult?.shouldContinue) {
            // blocking error → 注入错误消息后继续循环让模型修复
            state.stopHookRetryCount = (state.stopHookRetryCount ?? 0) + 1;
            setTransition(state, { type: "stop_hook_retry" }, deps, sessionState.sessionId);
            continue;
          }

          // P2-3：验证真正跑过且全部通过 → 清零续命预算，与 todo gate 预算在
          // 清单完成数变化时复位同一取向。不清零的话，同一条用户消息里前面失败 3 次，
          // 后面每一轮 end_turn 都被当成"预算已耗尽"，即使模型已经修好也不再验证。
          // 只认 `passed`（真跑过且全通过），不认 `!shouldContinue && !forceStop`——
          // 后者把「耗尽仍失败」和「hook 抛异常」也算进去，那会让预算永远回满。
          if (stopResult?.passed === true && (state.stopHookRetryCount ?? 0) > 0) {
            log.info(
              "QUERY_LOOP",
              `Stop Hook 验证通过，清零续命计数（原 ${state.stopHookRetryCount}）`,
            );
            state.stopHookRetryCount = 0;
          }

          // 质量闸门：耗尽只是本门不再续命，后续闸门照常判定（gate-exhaustion.ts）。
          if (stopResult?.exhausted) {
            noteGateExhausted("stop_hook", state.stopHookRetryCount ?? 0, MAX_STOP_HOOK_RETRIES);
          }

          if (stopResult?.forceStop) {
            // P1-1：forceStop 必须立刻收尾。此前只打日志，后面 Todo/Goal/`+k` 闸门照跑，
            // Stop Hook 明确说停仍会被续到 maxTurns。
            log.info("QUERY_LOOP", "Stop Hook preventContinuation，强制结束");
            applyDeferredClearContext();
            turnStopReason = "other";
            yield {
              kind: "done",
              turns: state.turnCount,
              // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            };
            exitedViaReturn = true;
            return;
          }
        }

        // ─── 方案②：「未答复的 end_turn」兜底（不依赖 todo，deepseek-reasoning-leak 修复）───
        // stream-processor 判定本轮思考漂移进正文 / 只思考不答复（response._unansweredEndTurn）时，
        // 无论有没有 todo，都回注一次收敛提示并软续命——这是例③"重试无反应"的机制级破局点：
        // 完成度校验/重试链原本全以 todo 存在为前提，模型不建 todo 就彻底失效。
        // 放在 todo gate 之前，因为它不依赖 todo，且要在"假性完成"最早处拦下、驱动模型换策略。
        if (response._unansweredEndTurn === true) {
          const shape = response._unansweredShape;
          const retries = state.unansweredRetryCount ?? 0;
          // 每次命中都落一条事件（含耗尽那次）：形态分布只有 warn.log 文本可查时，
          // 「是不是误报 / 哪种形态在涨」只能逐个会话翻原始响应（2026-10-26 两例即如此）。
          emitUnansweredEndTurn(
            shape,
            retries < MAX_UNANSWERED_RETRIES ? retries + 1 : retries,
            retries >= MAX_UNANSWERED_RETRIES,
            response.usageProvider ?? config.provider,
            sendParams.model,
          );
          if (retries < MAX_UNANSWERED_RETRIES) {
            state.unansweredRetryCount = retries + 1;
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: buildUnansweredEndTurnMessage(shape) }],
            });
            log.warn(
              "QUERY_LOOP",
              `方案②：检测到未答复的 end_turn（形态 ${shape ?? "unknown"}），回注收敛提示并软续命 ${state.unansweredRetryCount}/${MAX_UNANSWERED_RETRIES}`,
            );
            yield {
              kind: "system",
              level: "warning",
              text: `${describeUnansweredRetry(shape)} (${state.unansweredRetryCount}/${MAX_UNANSWERED_RETRIES})`,
            };
            setTransition(state, { type: "unanswered_retry" }, deps, sessionState.sessionId);
            continue;
          }
          // P1-3：耗尽后必须直接收尾。旧实现只 yield 警告再 fall-through 到 Goal /
          // Token Budget，后者会 continue，把「放行结束」做成「放行给下一道续命门」。
          noteGateExhausted("unanswered", retries, MAX_UNANSWERED_RETRIES);
          log.warn(
            "QUERY_LOOP",
            `方案②：未答复续命已达上限 ${MAX_UNANSWERED_RETRIES}（形态 ${shape ?? "unknown"}），整条闸门链收尾并如实呈现`,
          );
          yield {
            kind: "system",
            level: "warning",
            text: describeUnansweredExhausted(shape, MAX_UNANSWERED_RETRIES),
          };
          state.unansweredRetryCount = 0;
          applyDeferredClearContext();
          turnStopReason = normalizeTurnStopReason(response.stopReason);
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }

        // ─── S1 L2：短文本「承诺未兑现」→ 续跑一次（仅主循环，独立计数，每 prompt 封顶 1 次）───
        // 判据见 promise-nudge.ts 文件头。与上面 `_unansweredEndTurn` 分支并列而不合并：
        // 计数器、transition、文案全部独立（共用 unansweredRetryCount 会因工具执行清零而循环）。
        // 放在 todo gate 之前：两者都只在「本轮无工具调用」时到达，而本形态的续跑更具体。
        const promiseDecision = decidePromiseNudge(endTurnShape, {
          nudgeCount: state.promiseNudgeCount ?? 0,
          runningBackgroundTasks: runningBg,
          pendingNotifications: pendingNotif,
          disabled: isPromiseNudgeDisabled(),
        });
        if (promiseDecision?.fire) {
          state.promiseNudgeCount = (state.promiseNudgeCount ?? 0) + 1;
          saveS1Carry();
          // 内部 origin：TUI 隐藏；显式落盘：否则 `-c` 恢复后原 end_turn 与续跑那轮
          // assistant 直接相邻（现有 gate 注入只改内存，见方案 §3 S1「持久化」）。
          const nudgeMsg = buildInternalMessage("promise-nudge", "user", PROMISE_NUDGE_MESSAGE);
          ctxMgr.addMessage(nudgeMsg);
          deps.sessionStore?.appendMessage(nudgeMsg);
          pendingPromiseNudge = { lang: promiseDecision.lang };
          log.warn(
            "QUERY_LOOP",
            `S1 L2：短文本承诺未兑现（text_len=${endTurnShape.textLen}），注入续跑提示（本 prompt 第 ${state.promiseNudgeCount} 次）`,
          );
          setTransition(state, { type: "promise_nudge" }, deps, sessionState.sessionId);
          continue;
        }
        if (promiseDecision?.reason === "capped") {
          noteGateExhausted("promise_nudge", state.promiseNudgeCount ?? 0, MAX_PROMISE_NUDGES);
        }
        if (promiseDecision) {
          emitPromiseNudge(promiseDecision.lang, false, {
            outcome: "not_fired",
            skip_reason: promiseDecision.reason,
          });
        }

        // ─── P0-3：end_turn 完成度硬校验（对标 claude-code stopHooks.ts）───
        // 根因 1、2 修复——模型常"做了一半就 end_turn"。这里在收尾前查 todo：
        // 仍有 pending/in_progress 项 → 注入提醒并软续命（最多 MAX_TODO_GATE_RETRIES 次），
        // 把"人肉完成度校验器"内置进 harness。续命耗尽后放行，但如实列出未完成项，不假装完成。
        if (deps.getTodoState) {
          const todoState = deps.getTodoState();
          const unfinished = todoState ? countUnfinished(todoState.todos) : 0;
          // 预算挂 SessionState、按完成数复位（2026-10-06）：旧实现挂 LoopState，
          // 每条用户消息归零 + 每次 todo_write（哪怕只改措辞）归零，同一份停滞清单可被无限次拦截。
          const budget = todoState ? getTodoGateBudget(sessionState, todoState.todos) : null;
          if (todoState && budget && unfinished > 0) {
            // 误判自愈信号：本轮"有实质产出"（写了一段实质文字，如输出了完整报告）却试图收尾。
            // 本 gate 只在 `isEndTurnLike && !hasPendingToolUse` 分支到达，即本轮没有工具调用，
            // todo_write 本轮必然没执行，于是"有产出却不翻状态位"= producedSubstantialText。
            // 计数与续命预算同一复位口径（完成数变化才清零）。
            const producedSubstantialText =
              responseText.trim().length >= TODO_GATE_PRODUCTIVE_TEXT_MIN;
            if (producedSubstantialText) budget.productiveNoUpdate += 1;

            // 2e：本份清单振荡超阈值时不再劝「继续」——劝回去只会再振荡一轮（ce7ea52e 11:53
            // 那次唯一的自主收尾就是这样被劝回的）。置 exhaustedNotified 让下方耗尽提示不再重复。
            const stallGateHandoff =
              stallSwitches.enabled && budget.oscillations >= STALL_GATE_OSCILLATION_THRESHOLD;
            if (stallGateHandoff && !budget.exhaustedNotified) {
              budget.exhaustedNotified = true;
              noteGateExhausted("todo", budget.retries, MAX_TODO_GATE_RETRIES);
              log.warn(
                "QUERY_LOOP",
                `P0-3：清单振荡 ${budget.oscillations} 次 ≥ ${STALL_GATE_OSCILLATION_THRESHOLD}，放行收尾不再续命`,
              );
              yield {
                kind: "system",
                level: "warning",
                text: buildStallGateHandoffMessage(unfinished, budget.oscillations),
              };
            }
            if (!stallGateHandoff && budget.retries < MAX_TODO_GATE_RETRIES) {
              budget.retries += 1;
              ctxMgr.addMessage({
                role: "user",
                content: [
                  {
                    type: "text",
                    // 「重复输出」修复：把本轮"已输出实质正文"的判定传下去，让提醒在
                    // 已交付时明确禁止重述。producedSubstantialText 就在上面几行算好，
                    // 是这一层独有的精确信号——工具层拿不到，所以约束必须由这里下达。
                    text: buildTodoGateMessage(todoState.todos, producedSubstantialText),
                  },
                ],
              });
              log.info(
                "QUERY_LOOP",
                `P0-3：end_turn 拦截——仍有 ${unfinished} 项未完成，软续命 ${budget.retries}/${MAX_TODO_GATE_RETRIES}`,
              );
              yield {
                kind: "system",
                level: "info",
                // P2-1：中性措辞，避免"检测到…未完成"的报错感——这是正常的完成度兜底推进，非错误。
                text: `清单还有 ${unfinished} 项待完成，继续推进 (${budget.retries}/${MAX_TODO_GATE_RETRIES})`,
              };
              setTransition(state, { type: "todo_gate_retry" }, deps, sessionState.sessionId);
              continue;
            }

            // 续命耗尽。同一清单状态下只呈现一次——之后的 end_turn 直接放行：
            // 此前每条新用户消息都会再弹一次同样的红字，用户读到的是"又没做完"，
            // 而实际是"同一份清单、什么都没变"。
            if (!budget.exhaustedNotified) {
              budget.exhaustedNotified = true;
              // 质量闸门：只是本门不再续命，后续 hypothesis / token_budget / goal 照常判定。
              noteGateExhausted("todo", budget.retries, MAX_TODO_GATE_RETRIES);
              // 区分两种外部观测相同、本质不同的收尾：
              const forgotMark = budget.productiveNoUpdate >= TODO_GATE_FORGOT_MARK_THRESHOLD;
              if (forgotMark) {
                // B) 极可能"忘标记"：每次续命模型都在实质应答却始终不翻状态位。抛"未完成"是假警报，
                // 反而误导用户以为交付物有缺失。改为中性收尾（warn 日志保留，供排查门禁误判率）。
                log.warn(
                  "QUERY_LOOP",
                  `P0-3：续命耗尽且判定为"忘标记"（连续 ${budget.productiveNoUpdate} 次有产出却未翻状态位），` +
                    `抑制假警报，中性收尾；仍有 ${unfinished} 项未勾选`,
                );
                yield {
                  kind: "system",
                  level: "info",
                  text: buildTodoGateForgotMarkMessage(),
                };
              } else {
                // A) 真没做完：放行但如实呈现未完成项，不假装完成。
                log.warn(
                  "QUERY_LOOP",
                  `P0-3：完成度续命已达上限 ${MAX_TODO_GATE_RETRIES}，本门放行（后续闸门照常判定），仍有 ${unfinished} 项未完成`,
                );
                yield {
                  kind: "system",
                  level: "warning",
                  text: buildTodoGateExhaustedMessage(todoState.todos),
                };
              }
            }
          } else if (todoState && blockedTodos(todoState.todos).length > 0) {
            // 只剩 blocked（模型可推进项为 0）：**不拦截**——下一步主语是用户，再催模型只会
            // 产出同义重复（会话 20261005-233851-9b91e1b7 的 7 次）。给用户一条中性说明，
            // 同一批 blocked 项只说一次（签名去重，挂会话级预算上，跨用户消息有效）。
            const sig = blockedSignature(todoState.todos);
            if (budget && budget.handoffSignature !== sig) {
              budget.handoffSignature = sig;
              log.info(
                "QUERY_LOOP",
                `P0-3：end_turn 放行——剩余 ${blockedTodos(todoState.todos).length} 项 blocked（等待用户/外部）`,
              );
              yield {
                kind: "system",
                level: "info",
                text: buildTodoBlockedHandoffMessage(todoState.todos),
              };
            }
          }
        }

        // 环节③ 机制3（交付门禁）：模型试图收尾，但假设登记表里仍有未确认（open 或 refuted）
        // 假设时，注入门禁提醒并软续命——逼它先把假设结清（去验证→confirm，或 refute/降级），
        // 而不是把未证实的假设当结论交付。这是 fdb47f30 那类"把猜测写成根因"的最后一道闸。
        // 续命有限次：模型确实无法定论时放行，但门禁提醒已要求它在交付物里如实降级。
        //
        // 闸门用 hasUnsettled() 而非 hasOpen()：后者只看 open，与载荷 unsettled()
        // （status !== confirmed）口径不一致。轨迹 20260730-142920-d98e7f16 实测门禁
        // 注入 0 次——H1-H6 全 refuted、0 open，闸门不响，而这恰是最该拦的场景。
        if (deps.getHypothesisLedger) {
          const ledger = deps.getHypothesisLedger();
          // 缺口1：闸门增加第二个条件 hasChallengedConfirmed()。
          // hasUnsettled() 的口径刻意**不动**（confirmed 仍不算未结清，否则每条确认假设
          // 都拦一道、正常交付被误伤），但"确认后又被证据打脸"必须单独拦——那是
          // "提前宣布胜利"绕过审查的后窗：`falsifier` 不可修改防的是事后挪靶子，
          // 却没有任何机制防提前宣布胜利，而后者达到完全相同的效果且更省事。
          if (ledger && (ledger.hasUnsettled() || ledger.hasChallengedConfirmed())) {
            const retries = state.hypothesisGateRetryCount ?? 0;
            // 续命预算按"还有没有可推进的动作"分档，而不是一刀切 2 次：
            //   - 有 open 假设 → 2 次：open 是可推进的（去取证 → confirm/refute），
            //     多给一次机会换来的是真结论。
            //   - 全是 refuted（0 open）→ 1 次：refute 是**终态**，裁决不可改，模型
            //     唯一能做的就是"别把它写成结论/如实标注已证伪"。这一点提醒一次就够，
            //     再拦第二次纯属多烧一轮 token 且无动作可做——正是本次要避免的
            //     "多了步骤、没有收益"。
            // 缺口1：续命预算的分档判据里，"确认后被打脸"算**可推进动作**——模型可以
            // reopen 去补证据、也可以复核后维持结论，两者都是实质动作，与 open 同档。
            const gateHasOpen = ledger.hasOpen() || ledger.hasChallengedConfirmed();
            const MAX_HYPOTHESIS_GATE_RETRIES = gateHasOpen ? 2 : 1;
            if (retries < MAX_HYPOTHESIS_GATE_RETRIES) {
              state.hypothesisGateRetryCount = retries + 1;
              const unsettled = ledger.unsettled();
              const challengedConfirmed = ledger.challengedConfirmed();
              ctxMgr.addMessage({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: buildDeliveryGateReminder(unsettled, challengedConfirmed),
                  },
                ],
              });
              log.info(
                "QUERY_LOOP",
                `环节③ 交付门禁拦截——${unsettled.length} 条假设未确认` +
                  (challengedConfirmed.length > 0
                    ? ` + ${challengedConfirmed.length} 条已确认假设确认后被证据挑战`
                    : "") +
                  `，软续命 ${state.hypothesisGateRetryCount}/${MAX_HYPOTHESIS_GATE_RETRIES}`,
              );
              yield {
                kind: "system",
                level: "info",
                text:
                  (unsettled.length > 0
                    ? `检测到 ${unsettled.length} 条假设未结清`
                    : `检测到 ${challengedConfirmed.length} 条已确认假设存在反证`) +
                  `，请先裁决再收尾 (${state.hypothesisGateRetryCount}/${MAX_HYPOTHESIS_GATE_RETRIES})`,
              };
              setTransition(state, { type: "hypothesis_gate_retry" }, deps, sessionState.sessionId);
              continue;
            }
            noteGateExhausted("hypothesis", retries, MAX_HYPOTHESIS_GATE_RETRIES);
            log.warn(
              "QUERY_LOOP",
              `环节③ 交付门禁续命已达上限 ${MAX_HYPOTHESIS_GATE_RETRIES}，本门放行（后续闸门照常判定；模型应已在交付物中如实降级未确认假设）`,
            );
          } else if (ledger && (state.hypothesisGateRetryCount ?? 0) > 0) {
            // P2-3：登记表**已结清**（无 unsettled、无"确认后被打脸"）→ 清零续命预算，
            // 与 todo gate 预算在清单完成数变化时复位同一取向。
            //
            // 不清零的实测形态：全 refuted 时 cap=1，用掉这一次之后计数永久停在 1；
            // 后面模型登记了新的 unsettled 假设，`retries < MAX` 从此恒假，门禁**直接放行**
            // ——一道自称"最后一道闸"的门，在同一条用户消息里只响一次。
            // 位置在 `else` 而不是收尾出口：这里是"门禁本轮不该拦"的唯一判定点，
            // 且它与门禁自身共用同一份 hasUnsettled/hasChallengedConfirmed 口径，不会漂。
            log.info(
              "QUERY_LOOP",
              `环节③ 交付门禁：登记表已结清，清零续命计数（原 ${state.hypothesisGateRetryCount}）`,
            );
            state.hypothesisGateRetryCount = 0;
          }

          // 缺口2 层次1（交付物内容检查）：门禁只看登记表状态，从不看模型实际写出的字
          // ——被推翻的说法可以原样写进交付物而不触发任何检查，机制3 的"不得作为结论
          // 交付"因此只是声明、不是校验。这里补上校验：用 refuted 假设 statement 里
          // **过了泛化门槛**的具体标识符去匹配本会话写出的交付物文本。
          //
          // 与上面的门禁分开续命预算（refutedReuseGateRetryCount）：共用会让先触发的
          // 那道把预算吃光、另一道永久哑火——正是上一轮修复里 todo/work-log 共享计数器
          // 踩过的坑。只续命 1 次：这是一次"请自查"，模型要么改要么确认无碍，无需第二次。
          if (ledger && !state.pendingRefutedReuseCleared) {
            try {
              const refuted = ledger.refutedItems();
              if (refuted.length > 0) {
                const deliverable = getDeliverableText(sessionState);
                const reuseHits = detectRefutedReuse(refuted, deliverable);
                const reuseRetries = state.refutedReuseGateRetryCount ?? 0;
                if (reuseHits.length > 0 && reuseRetries < 1) {
                  state.refutedReuseGateRetryCount = reuseRetries + 1;
                  // 一次性置位（本条用户消息内）：不置位的话模型改完再收尾会命中同一批
                  // 标识符——它可能只是在如实标注"该假设已被证伪"（那正是门禁要求的正确
                  // 做法），反复质疑模型写对的东西是纯负收益。
                  state.pendingRefutedReuseCleared = true;
                  // 同时清空会话级交付物缓冲：`pendingRefutedReuseCleared` 挂在 LoopState、
                  // 随下一条用户消息归零，若缓冲不清，下一条消息会拿**旧文本**再命中一次
                  // 同样的标识符（模型此时甚至没写任何新东西）。清空后，只有新写出的内容
                  // 才可能再触发——这才是"检查新交付物"而不是"反复检查同一段文本"。
                  resetDeliverableText(sessionState);
                  ctxMgr.addMessage({
                    role: "user",
                    content: [{ type: "text", text: buildRefutedReuseReminder(reuseHits) }],
                  });
                  log.info(
                    "QUERY_LOOP",
                    `缺口2 交付物复用检查命中 ${reuseHits.length} 条已推翻假设的说法（${reuseHits
                      .map((h) => `${h.hypothesisId}:${h.matchedIdentifier}`)
                      .join(",")}），软续命 1/1 请模型自查`,
                  );
                  yield {
                    kind: "system",
                    level: "info",
                    text: `交付物中出现 ${reuseHits.length} 处与已推翻假设重合的表述，请自查 (1/1)`,
                  };
                  setTransition(
                    state,
                    { type: "hypothesis_gate_retry" },
                    deps,
                    sessionState.sessionId,
                  );
                  continue;
                }
              }
            } catch (e) {
              // 纯增量检查，异常一律吞掉——它绝不能反过来阻断正常收尾。
              log.warn(
                "QUERY_LOOP",
                `缺口2 交付物复用检查异常（不阻断收尾）: ${(e as Error)?.message}`,
              );
            }
          }
        }

        // ─── P0-3：Token Budget 续写 Gate ───
        // 只在本条用户消息带了 "+500k" 类预算指令时生效；与 /goal 互斥——goal 处于 active
        // 状态时跳过，交给下面的 Goal Gate 自己的预算/评估逻辑判定（两套"要不要继续"的
        // 机制不叠加，避免互相打架）。位置在 Hypothesis Gate 之后、Goal Gate 之前：
        // 前面几道 Gate 已经确认"完成度"层面没问题，这里再看"预算还有没有、值不值得继续"。
        if (state.tokenBudgetTarget !== undefined) {
          const activeGoal = deps.getGoalState?.();
          const goalIsActive = activeGoal != null && activeGoal.status === "active";
          if (!goalIsActive) {
            const currentUsage = sessionState.getTotalUsage();
            // P2-4：`consumed` 口径与基线（tokenBudgetBaselineUsage）**逐字同源**，
            // 见 tokenBudgetConsumed() 注释里为什么刻意不含 cacheRead。
            const consumed =
              tokenBudgetConsumed(currentUsage) - (state.tokenBudgetBaselineUsage ?? 0);
            const remaining = state.tokenBudgetTarget - consumed;

            if (remaining <= 0) {
              log.info(
                "QUERY_LOOP",
                `P0-3：预算已用完（目标 ${state.tokenBudgetTarget}），正常收尾`,
              );
              yield {
                kind: "system",
                level: "info",
                text: buildBudgetExhaustedNotice(state.tokenBudgetTarget),
              };
              // 落入下方正常收尾
            } else {
              budgetDiminishingDetector.record(response.usage.outputTokens);
              if (budgetDiminishingDetector.shouldStop()) {
                log.info("QUERY_LOOP", `P0-3：产出递减收益，提前收尾（预算剩余约 ${remaining}）`);
                yield {
                  kind: "system",
                  level: "info",
                  text: buildBudgetDiminishingNotice(remaining),
                };
                // 落入下方正常收尾
              } else {
                state.tokenBudgetContinuationCount = (state.tokenBudgetContinuationCount ?? 0) + 1;
                ctxMgr.addMessage({
                  role: "user",
                  content: [
                    { type: "text", text: buildBudgetContinuationMessage(consumed, remaining) },
                  ],
                });
                log.info(
                  "QUERY_LOOP",
                  `P0-3：预算续写 #${state.tokenBudgetContinuationCount}（剩余约 ${remaining} tokens）`,
                );
                yield {
                  kind: "system",
                  level: "info",
                  text: `预算续写中 (#${state.tokenBudgetContinuationCount}，剩余约 ${remaining.toLocaleString()} tokens)`,
                };
                setTransition(
                  state,
                  { type: "token_budget_continuation" },
                  deps,
                  sessionState.sessionId,
                );
                continue;
              }
            }
          }
        }

        // ─── /goal：Goal Gate（评估者判定目标是否满足）───
        // 位于 Gate 链最末——只有前三道 Gate 全部放行，才轮到 Goal Gate 做最终判定。
        // Plan Mode 中暂停 Goal Gate（计划模式不执行操作，不应评估完成度）。
        if (deps.getGoalState) {
          const goal = deps.getGoalState();
          const inPlanMode = deps.getCurrentPermissionMode?.() === "plan";
          if (goal && goal.status === "active" && !inPlanMode) {
            try {
              // 评估者模型：goal.evaluatorModel > subAgentModels.default > 主模型（刻意跳过 verify，
              // 理由见 resolveGoalEvaluatorModel）。与 /goal 命令的提示共用同一个解析函数。
              const evaluatorModel = resolveGoalEvaluatorModel({
                model: config.model,
                goal: effectiveGoalConfig,
                subAgentModels: config.subAgentModels,
              }).model;
              // F4（2026-09-03）：provider 按**评估器模型名**解析，读该模型在
              // availableModels 里声明的 provider/apiKey/baseURL。
              //
              // 原实现在这里手工 new：只按主 config.provider 二选一，并复用主模型的
              // key 与 baseURL。而 evaluatorModel 取自 subAgentModels.default，完全可能
              // 属于另一个 provider / 另一个网关 / 另一把 key —— 于是「deepseek 模型名，
              // 用 Anthropic 协议、Anthropic 的 key，发到 Anthropic 端点」，评估器每轮必 4xx。
              // 与 20260707 事故同源（6 次调用 0 成功 → 静默降级成「未满足」→ 空转 15 轮）。
              //
              // 兜底：未注入 getProviderForModel（极简/测试路径）时用主 provider——
              // 与改动前的同 provider 行为一致，不因缺注入而崩。
              const evaluatorProvider =
                deps.getProviderForModel?.(evaluatorModel) ??
                (config.provider === "anthropic"
                  ? new AnthropicProvider(config.anthropicKey, evaluatorModel, config.baseURL)
                  : new OpenAIProvider(config.openaiKey, evaluatorModel, config.baseURL));
              const evalConfig = {
                model: evaluatorModel,
                provider: evaluatorProvider,
                timeout: effectiveGoalConfig.evaluatorTimeout,
                minTurnsBeforeEval: effectiveGoalConfig.minTurnsBeforeEval,
              };

              const lastTurnUsage = {
                inputTokens: response.usage?.inputTokens ?? 0,
                outputTokens: response.usage?.outputTokens ?? 0,
                cacheCreationTokens: response.usage?.cacheCreationInputTokens ?? 0,
              };
              const goalGateOutput = await handleGoalGate({
                goal,
                messages: ctxMgr.getMessages(),
                turnUsage: lastTurnUsage,
                evalConfig,
                goalConfig: effectiveGoalConfig,
                blockedDetector: goalBlockedDetector,
                traceAppendEvent: deps.traceAppendEvent,
                sessionId: sessionState.sessionId,
                // 缺口7：GoalGateDecision 与 hypothesis 各事件统一轮次口径。
                // turn（goal.turnsUsed）是消息内计数、跨消息回绕，离线分析"决策发生在
                // 会话哪一阶段"时与 hypothesis 事件不可直接比较。absoluteTurn/promptSeq 补齐后可比。
                absoluteTurn: sessionState.getAbsoluteTurn(),
                promptSeq,
              });

              // 注入消息
              for (const msg of goalGateOutput.injectMessages) {
                ctxMgr.addMessage(msg);
              }
              // yield 系统消息
              for (const sysMsg of goalGateOutput.systemMessages) {
                yield { kind: "system", level: sysMsg.level, text: sysMsg.text };
              }

              const { result } = goalGateOutput;
              if (result.completed) {
                deps.updateGoalState?.((g) => {
                  g.status = "complete";
                });
                log.info("GOAL_GATE", "目标已达成，正常收尾");
                // 落入下方正常收尾
              } else if (result.impossible) {
                deps.updateGoalState?.((g) => {
                  g.status = "impossible";
                });
                log.info("GOAL_GATE", "目标不可能达成，正常收尾");
                // 落入下方正常收尾
              } else if (result.shouldContinue) {
                deps.updateGoalState?.((g) => {
                  g.lastEvalReason = result.evalResult?.reason;
                });
                // P3-1（2026-09-23）：预算已进入 warning 档时记更具体的
                // `goal_budget_warning`，否则这个变体全仓零 `setTransition` ——
                // 「预算告警续跑」按 `LoopTransition.type` 统计恒为 0（告警文案本身
                // 一直在进对话，缺的只是可观测接线）。
                //
                // ⚠️ 必须**替换**而不是追加一条事件：一次 continue 只对应一条 transition，
                // 追加会让「按 type 数续跑次数」的分母凭空多一份 —— 分母口径一变，
                // 曲线整体平移。所以 `goal_gate_retry` 与 `goal_budget_warning`
                // 在同一次 continue 上互斥，两者之和才是「Goal 闸门续跑总数」。
                setTransition(
                  state,
                  { type: result.budgetWarning ? "goal_budget_warning" : "goal_gate_retry" },
                  deps,
                  sessionState.sessionId,
                );
                continue;
              } else {
                // shouldContinue=false && !completed && !impossible
                //   → 轮次超限 / 预算耗尽 / blocked：handleGoalGate 已直接改了 goal.status
                //     （同一对象引用），但必须显式触发 updateGoalState 才能落盘持久化 + 刷新 TUI 状态栏。
                //     缺这一步会导致终态不写 JSONL（resume 时仍显示 active）、状态栏不更新。
                const terminalStatus = goal.status;
                deps.updateGoalState?.((g) => {
                  g.status = terminalStatus;
                  if (result.evalResult?.reason) g.lastEvalReason = result.evalResult.reason;
                });
                log.info("GOAL_GATE", `目标终止（${terminalStatus}），正常收尾`);
                // 落入下方正常收尾
              }
            } catch (e: any) {
              // Goal Gate 不得阻断主循环
              log.warn(
                "GOAL_GATE",
                `Goal Gate 异常（已忽略，正常收尾）：${e?.message ?? String(e)}`,
              );
            }
          }
        }

        const totalUsage = sessionState.getTotalUsage();
        log.info(
          "QUERY_LOOP",
          `对话结束 (${response.stopReason})，共 ${state.turnCount} 轮，in=${totalUsage.inputTokens} out=${totalUsage.outputTokens}，累计费用 $${sessionState.totalCostUSD.toFixed(4)}`,
        );
        // F1：正常收尾，清零连续退化计数
        state.emptyParamRetryCount = 0;
        // 方案②：正常收尾（含续命耗尽放行），清零未答复连续计数
        state.unansweredRetryCount = 0;
        // Step 0：end_turn 是自然断点——触发 Session Memory 提取，把本轮终态沉淀进笔记，
        // 下次压缩可优先用它而非从头 LLM 摘要；随后跑后台记忆提取写 MEMORY.md。
        //
        // ⚠️ PR1（幽灵流白烧修复）：这两条**必须过 `runBackgroundTask` 单飞闸门**，
        // 不能各自裸 fire-and-forget。它们各自内部的 `pending` 互斥只防"同一个任务重入"，
        // 完全不防"两个不同任务并发" —— 实测 `TurnComplete(end_turn)` 之后两个 fork
        // 交替发了 7 次十万 token 级请求、跑了 44 秒，用户为一个已答完的任务多付约 ¥2.3。
        // 闸门语义是**串行 + 按 label 待补一笔**：两条紧挨着提交，第二条记为待补、
        // 等第一条跑完再放行（F3：旧的「丢弃」语义让第二条恒被拒）。待补每个 label
        // 至多一笔，不会攒成一串请求。详见 background-task-gate.ts 文件头。
        //
        // 仍不 await：await 会把用户可感知的收尾延迟拉长到实测 44s（方案 §5.1 B3 已否决）。
        if (deps.updateSessionMemory) {
          runBackgroundTask("session-memory-update", () => deps.updateSessionMemory!());
        }
        if (deps.extractMemories) {
          runBackgroundTask("memory-extract", () => deps.extractMemories!());
        }
        // P2-2：AfterAgent 请求的清历史在这里才执行——整条闸门链已放行，不会再有
        // `continue` 把模型送进下一轮（否则它面对的就是一段空历史）。
        applyDeferredClearContext();
        // P1-4：唯一的"模型正常说完了"出口。归一化而非透传 stopReason ——
        // end_turn / stop / stop_sequence 三值同义，透传等于把归一责任推给每个消费方。
        turnStopReason = normalizeTurnStopReason(response.stopReason);
        // S1 L1：最终停在「承诺形」短文本上（L2 封顶 / 被后台任务或通知排除 / 英文只度量 /
        // env 关闭）就常驻提示一句，让「说了要做却没做」不再静默。persistent：写历史区，`done` 不清。
        // 只认承诺形、不认 short_after_tools：回放里那 8 条短完成陈述 / 求助每次都弹提示是噪声，
        // 它们的事实已进 EndTurnShape 与 digest，不靠 TUI 提示。
        if (endTurnShape.kind === "promise_after_tools") {
          yield {
            kind: "system",
            level: "info",
            text: PLAIN_TEXT_END_TURN_NOTICE,
            persistent: true,
          };
        }
        yield {
          kind: "done",
          turns: state.turnCount,
          // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
          turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
        };
        exitedViaReturn = true;
        return;
      }

      // ─── 处理工具调用 ───
      // 进入条件：stop_reason=tool_use（正常路径），或 F2 fall-through——
      // stop_reason=end_turn/stop 或 max_tokens/length 但 content 仍有（非空参数）tool_use 未执行。
      // 报 tool_use 却一个 tool_use 块都没有的不进这里（分类器判 unknown，见下方如实收尾）：
      // 旧条件 `stopReason === "tool_use"` 会让它 executeTools([]) 后 continue，白烧一次往返。
      if (stopAction.kind === "execute_tools") {
        const toolBlocks = response.content.filter((b) => b.type === "tool_use");
        const toolNames = toolBlocks
          .map((b) => (b.type === "tool_use" ? b.name : ""))
          .filter(Boolean);
        if (response.stopReason !== "tool_use") {
          log.info(
            "QUERY_LOOP",
            `F2：${response.stopReason} 含未执行 tool_use，兜底执行: ${toolNames.join(", ")}`,
          );
        } else {
          log.info("QUERY_LOOP", `工具调用: ${toolNames.join(", ")}`);
        }

        // 工具调用循环检测
        let loopDetected = false;
        for (const b of toolBlocks) {
          if (b.type === "tool_use") {
            // Step 0：Session Memory 工具调用计数（双阈值之一）
            deps.recordSessionMemoryToolCall?.();
            if (loopDetector.recordToolCall(b.name, b.input)) {
              loopDetected = true;
              break;
            }
          }
        }
        if (loopDetected) {
          const recovered = await recoverFromLoop(loopDetector, ctxMgr, "工具调用重复");
          if (!recovered) {
            yield {
              kind: "done",
              turns: state.turnCount,
              // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            };
            exitedViaReturn = true;
            return;
          }
          yield { kind: "loop_detected", detail: "工具调用重复" };
          yield {
            kind: "loop_recovery",
            attempt: loopDetector.getRecoveryAttempts(),
            maxAttempts: loopDetector.getMaxRecoveryAttempts(),
          };
          setTransition(state, { type: "loop_recovery" }, deps, sessionState.sessionId);
          continue;
        }

        // LLM 认知循环检测
        if (loopDetector.shouldRunLLMCheck()) {
          const llmLoopDetected = await runLLMLoopCheck(loopDetector, loopConfig, ctxMgr);
          if (llmLoopDetected) {
            const recovered = await recoverFromLoop(loopDetector, ctxMgr, "LLM 认知检测到循环模式");
            if (!recovered) {
              yield {
                kind: "done",
                turns: state.turnCount,
                // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
                turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
              };
              exitedViaReturn = true;
              return;
            }
            yield { kind: "loop_detected", detail: "LLM 认知检测到循环模式" };
            yield {
              kind: "loop_recovery",
              attempt: loopDetector.getRecoveryAttempts(),
              maxAttempts: loopDetector.getMaxRecoveryAttempts(),
            };
            setTransition(state, { type: "loop_recovery" }, deps, sessionState.sessionId);
            continue;
          }
        }

        // yield 工具开始事件
        for (const b of toolBlocks) {
          if (b.type === "tool_use") {
            yield { kind: "tool_start", toolName: b.name, toolInput: b.input };
            // P1-4：在**实际派发**处累加，不数响应里的 tool_use 块数 —— 后者含被循环
            // 检测拦下 / 被 abort 跳过的块，数出来是"模型想调多少"而非"真调了多少"。
            state.toolCallsDispatched = (state.toolCallsDispatched ?? 0) + 1;
            // S4 可见性：本 prompt 的写入类 / 只读类派发数（bash 改动天然不计入，事实而非判据）
            if (FILE_MUTATING_TOOLS.has(b.name)) {
              state.promptEditWriteCount = (state.promptEditWriteCount ?? 0) + 1;
            } else if (isReadFamilyTool(b.name)) {
              state.promptReadonlyCount = (state.promptReadonlyCount ?? 0) + 1;
            }
            // 可观测性：把 hypothesis_register / hypothesis_challenge 的实际调用落成 trace 事件
            // （events.jsonl），与 HypothesisGuideInjected 配对——前者记"注入命中"、后者记"模型采纳"，
            // 两者相除即「防线采纳率」，可被 trace-digest 自动统计，无需离线 grep。
            if (
              deps.traceAppendEvent &&
              (b.name === "hypothesis_register" || b.name === "hypothesis_challenge")
            ) {
              try {
                deps.traceAppendEvent({
                  event: "HypothesisToolUsed",
                  session_id: sessionState.sessionId,
                  timestamp: new Date().toISOString(),
                  data: {
                    tool: b.name,
                    // 缺口7：`data.turn` 是**每条用户消息内重置**的计数器，此前它是这个事件里
                    // 唯一的轮次口径，导致"这条假设存活了多久""登记发生在会话哪个阶段"
                    // （缺口 2 的核心度量）在跨消息会话里全部失真。补 absoluteTurn/promptSeq。
                    ...turnMetrics(state, sessionState, promptSeq),
                    guideInjected: state.hypothesisGuideInjected === true,
                  },
                });
              } catch {
                /* trace 写入失败不阻断 */
              }
            }
            // 缺口2 层次1（交付物文本采集）：把 write/edit 类工具**写出去的内容**攒进
            // 会话级缓冲，供收尾时检查"是否复用了已推翻假设的说法"。
            //
            // 为什么必须在这里采集、而不是收尾时回溯上下文：交付物内容多为大段文本，
            // 上下文里可能已被 compact 折叠或截断，收尾时回溯不到；而这里是它进入
            // 系统的唯一入口。只在登记表里真有 refuted 假设时才采集——不用这套机制的
            // 会话（占实测 89.7%）不该为此付任何内存代价。
            if (deps.getHypothesisLedger) {
              try {
                const ledger = deps.getHypothesisLedger();
                if (ledger && ledger.refutedItems().length > 0) {
                  appendDeliverableText(sessionState, b.name, b.input);
                }
              } catch {
                /* 采集失败不阻断主循环 */
              }
            }
          }
        }

        // 执行工具
        const toolPerfHandle = getPerfTimer().start(`tool_batch_${state.turnCount}`);
        let toolResults: import("../llm/types.ts").ContentBlock[];
        let toolFollowup: import("../llm/types.ts").ContentBlock[] | undefined;
        let toolDurations: Map<string, number> | undefined;
        try {
          const ret = await deps.executeTools(response.content);
          toolResults = ret.results;
          toolFollowup = ret.followup;
          toolDurations = ret.durations;
        } catch (err: any) {
          toolPerfHandle.end();
          if (isAbortError(err)) {
            // A2：用户取消工具执行 → 补上取消的 tool_result（保持 tool_use/tool_result 协议配对），
            // 然后优雅收尾（yield done + return），而非 throw err 让异常穿透。
            // 对标 claude-code：abort 是正常的"用户中断"而非错误路径。
            const cancelResults = toolBlocks
              .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
              .map((b) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content: "用户取消了此工具调用",
                is_error: true,
              }));
            ctxMgr.addMessage({ role: "user", content: cancelResults });
            // B2：assistant（含 tool_use）已在上方 yield assistant_message 时由 engine 持久化，此处仅补 cancel result，保持配对。
            try {
              deps.sessionStore?.appendMessage({ role: "user", content: cancelResults });
            } catch {
              /* 持久化失败不阻断 */
            }
            log.info(
              "QUERY_LOOP",
              "工具执行被用户取消，已补 cancel result，优雅收尾（reason=aborted_tools）",
            );
            yield {
              kind: "done",
              turns: state.turnCount,
              // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
              incompleteReason: (state.incompleteReason = "aborted"),
            };
            exitedViaReturn = true;
            return;
          }
          // AGENT-2 双重防护：非 abort 异常会 throw 穿透，但此时 assistant(含 tool_use) 已入历史，
          // 工具结果缺失 → 孤儿 tool_use。发送前的 backfillOrphanToolResults 关卡是主防护，
          // 这里在 throw 前先就地补齐本轮 tool_use 的 error 占位 result，让 ctxMgr 历史与
          // sessionStore 落盘当场即满足协议配对，避免异常路径毒化后续 / 恢复时的会话历史。
          const errorResults = toolBlocks
            .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
            .map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: `工具执行异常中断：${err?.message ?? String(err)}`,
              is_error: true,
            }));
          if (errorResults.length > 0) {
            ctxMgr.addMessage({ role: "user", content: errorResults });
            try {
              deps.sessionStore?.appendMessage({ role: "user", content: errorResults });
            } catch {
              /* 持久化失败不阻断 */
            }
            log.warn(
              "QUERY_LOOP",
              `工具执行抛出非 abort 异常，已为 ${errorResults.length} 个 tool_use 补 error result 后再抛出`,
            );
          }
          throw err;
        }
        const toolBatchElapsed = toolPerfHandle.end();
        ctxMgr.addMessage({ role: "user", content: toolResults });
        // B2 方案 a：tool_result 与入历史同步持久化（appendMessage 按 role=user 自动分派为 tool_result 记录）。
        try {
          deps.sessionStore?.appendMessage({ role: "user", content: toolResults });
        } catch {
          /* 持久化失败不阻断 */
        }

        // 环节③ 机制2（矛盾中断·触发端）：把本轮所有 tool_result 文本拼起来，扫描是否与
        // 任何 open 假设的证伪条件线索矛盾。命中则暂存到 state，下一轮循环开头经 reminder
        // 通道注入"矛盾中断"，强制模型来 hypothesis_challenge 裁决——这正是 fdb47f30 缺的
        // 那一下：拿到推翻早期叙事的证据时，主动停下来裁决，而非视而不见继续推进。
        if (deps.getHypothesisLedger) {
          try {
            const ledger = deps.getHypothesisLedger();
            if (ledger && !ledger.isEmpty()) {
              // 负收益防线审计 发现 2/3（2026-07-30）：证据收集改走 collectEvidenceTexts——
              //   发现 2：剔除假设工具自身的回执。实测 6 次真实注入里 2 次是"登记假设的回执
              //     触发自己"：hypothesis_register 的 output（fmtHypothesis）逐字复述 falsifier
              //     全文 → 进 tool_result → 必然命中刚从同一段 falsifier 提取的 cue，纯自噬。
              //   发现 3：逐条传入而非 join("\n") 成一个大串，让指纹按 tool_result 各算各的，
              //     避免"拼接串前 120 字符相同"把整轮真证据连带吞掉（实测 11.7% 伪碰撞）。
              const evidenceItems = collectEvidenceTexts(toolResults, (id) => {
                const useBlock = response.content.find((b) => b.type === "tool_use" && b.id === id);
                return useBlock && useBlock.type === "tool_use" ? useBlock.name : "";
              });
              const hits = ledger.detectContradictions(evidenceItems);
              // 缺口5（会话内词频自适应·统计端）：与 detectContradictions **同一批**文本
              // 喂给频次表。必须在 detect **之后**调用：先检测再计数，才能保证一条 cue
              // 的首次命中永远放行（详见 shouldSuppressByFrequency 的护栏 2）。
              ledger.observeEvidence(evidenceItems);
              if (hits.length > 0) {
                state.pendingContradictions = [...(state.pendingContradictions ?? []), ...hits];
                const reopenCount = hits.filter((h) => h.afterConfirm).length;
                log.info(
                  "QUERY_LOOP",
                  `假设登记表矛盾检测命中 ${hits.length} 条（${hits.map((h) => h.hypothesisId).join(",")}）` +
                    (reopenCount > 0 ? `，其中 ${reopenCount} 条为已确认假设的翻案挑战` : "") +
                    `，下一轮注入矛盾中断`,
                );
              }

              // 缺口2 层次2（假设登记表空转·检测端）：登记表非空但已连续 N 轮无任何假设
              // 操作，而模型仍在读/改代码——这段"中段空转"是三道闸门的共同盲区（它们只
              // 在登记时和收尾时工作）。用会话累计轮次判定，不能用消息内 turnCount：
              // 后者每条用户消息归零，长会话里永远凑不满阈值 → 这道提醒会永久哑火。
              if (ledger.claimStaleNag(sessionState.getAbsoluteTurn(), HYPOTHESIS_STALE_TURNS)) {
                const idle = sessionState.getAbsoluteTurn() - ledger.lastActivityTurn();
                state.pendingHypothesisStaleReminder = buildStaleLedgerReminder(
                  idle,
                  ledger.all().length,
                );
                log.info(
                  "QUERY_LOOP",
                  `假设登记表已空转 ${idle} 轮（共 ${ledger.all().length} 条假设），下一轮注入续期提醒（仅一次）`,
                );
              }

              // 缺陷3（连续推翻 → 换策略·检测端）：连推 N 条假设且一条没 confirm，
              // 说明取证手段本身不对（多为凭静态推理外推），该换 git 历史/实测/问用户，
              // 而不是登记下一条同类假设。
              // 「只给一次」的标志挂在 ledger（会话级）而非 state（每条用户消息重建）——
              // claimStrategyNag 把判据与置位做成原子，返回 >0 即表示本次该提示。
              const nagCount = ledger.claimStrategyNag(CONSECUTIVE_REFUTATION_NAG_THRESHOLD);
              if (nagCount > 0) {
                state.pendingHypothesisStrategyShift = nagCount;
                log.info(
                  "QUERY_LOOP",
                  `连续推翻 ${nagCount} 条假设且零确认，下一轮注入换策略提示（仅一次）`,
                );
              }
            }
          } catch (e: any) {
            // 矛盾检测不得阻断主循环
            log.warn("QUERY_LOOP", `假设矛盾检测异常（已忽略）：${e?.message ?? String(e)}`);
          }
        }

        // ─── /goal：从工具结果自动收集证据（Evidence Log）───
        // 不依赖模型配合，自动从 tool_result 中提取关键操作结果。
        // Evidence Log 独立于对话历史，Compact 不影响证据完整性。
        if (deps.getGoalState) {
          const goal = deps.getGoalState();
          if (goal && goal.status === "active") {
            try {
              const toolResultTexts = toolResults
                .filter((r): r is typeof r & { type: "tool_result" } => r.type === "tool_result")
                .map((r) => {
                  // 从对应的 tool_use 块找出工具名
                  const toolUseBlock = response.content.find(
                    (b) => b.type === "tool_use" && b.id === (r as any).tool_use_id,
                  );
                  const toolName =
                    toolUseBlock && toolUseBlock.type === "tool_use"
                      ? toolUseBlock.name
                      : "unknown";
                  return {
                    toolName,
                    result: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
                    // F2：把 is_error 一并带进证据。fast-path 判「测试是否通过」不能只看
                    // 输出文本里有没有 `0 fail`——那是文本形态，退出码才是语义。
                    isError: r.is_error === true,
                  };
                });
              const newEvidence = collectEvidenceFromTurn(toolResultTexts, goal.turnsUsed);
              if (newEvidence.length > 0) {
                goal.evidenceLog.push(...newEvidence);
                // 幂等同步：赋数组引用而非再 push（getGoalState/updateGoalState 在生产中
                // 操作同一对象，若此处再 push 会导致证据被重复记录两次）。
                deps.updateGoalState?.((g) => {
                  g.evidenceLog = goal.evidenceLog;
                });
                log.debug(
                  "GOAL_EVIDENCE",
                  `收集 ${newEvidence.length} 条证据（第 ${goal.turnsUsed} 轮）`,
                );
              }
            } catch (e: any) {
              // 证据收集不得阻断主循环
              log.warn("GOAL_EVIDENCE", `证据收集异常（已忽略）：${e?.message ?? String(e)}`);
            }
          }
        }

        // ADR-019：plan-approved 等"工具完成后再追加"的 user 消息，必须在 toolResults 之后 enqueue。
        if (toolFollowup && toolFollowup.length > 0) {
          ctxMgr.addMessage({ role: "user", content: toolFollowup });
          try {
            deps.sessionStore?.appendMessage({ role: "user", content: toolFollowup });
          } catch {
            /* 持久化失败不阻断 */
          }
        }

        // yield 工具结束事件
        const resultMap = new Map<string, import("../llm/types.ts").ContentBlock>();
        for (const r of toolResults) {
          if (r.type === "tool_result") resultMap.set(r.tool_use_id, r);
        }
        // 回退口径：执行层没给真实耗时时（老实现/异常路径未记录）才按批次平摊。
        // 平摊是**失真**的——并行批次 [1s, 1s, 1s, 20s] 会让 4 个工具全报 ~5.75s，
        // 把唯一的慢工具藏起来。所以只在拿不到真值时用，且逐工具优先取真值。
        const fallbackDuration = Math.round(
          toolBlocks.length > 0 ? toolBatchElapsed / toolBlocks.length : toolBatchElapsed,
        );

        for (const b of toolBlocks) {
          if (b.type !== "tool_use") continue;
          const result = resultMap.get(b.id);
          const isError = result && result.type === "tool_result" ? !!result.is_error : false;
          const elapsedMs = toolDurations?.get(b.id) ?? fallbackDuration;
          yield { kind: "tool_end", toolName: b.name, result: { isError, elapsedMs } };
        }

        // F1：工具成功执行 → 模型已恢复正常生成参数的能力，清零连续退化计数
        state.emptyParamRetryCount = 0;
        // 方案②：工具成功执行 → 模型已在正常推进（非"只思考不答复"），清零未答复计数
        state.unansweredRetryCount = 0;

        // B26 顺带：`--json-schema` 下 StructuredOutput 已捕获合规载荷 = 任务交付完毕，就地收尾。
        // 子代理路径（agentic-loop）靠 hasCapturedOutput 旁路结束，顶层主循环此前没有这个出口：
        // 实测模型拿到成功返回后同参连调 99 次（会话 20261002-212543-660c152b，102 次 API / $1.06），
        // 只有 maxTurns 能停住它。判据只认工具自报的 hasCapturedOutput，不认「本轮调过它」——
        // 校验不通过的那次必须照常续轮，让模型按回喂的错误重试。
        if (
          toolBlocks.some((b) => b.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL_NAME)
        ) {
          const so = toolRegistry.get(STRUCTURED_OUTPUT_TOOL_NAME) as
            | { hasCapturedOutput?: boolean }
            | undefined;
          if (so?.hasCapturedOutput === true) {
            log.info("QUERY_LOOP", "StructuredOutput 已捕获合规输出，主循环收尾");
            turnStopReason = "end_turn";
            yield {
              kind: "done",
              turns: state.turnCount,
              // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
              structuredOutputDelivered: true,
            };
            exitedViaReturn = true;
            return;
          }
        }

        // ⚠️ PR1（§5.1 B1 / §5.7）：这里**原先**还有一处 `deps.updateSessionMemory?.()`
        // 的工具轮触发（"本轮工具结果已入历史，增量提取"），**已刻意删除**。
        //
        // 删的理由是它与主循环下一轮请求**并发**：实测同一会话的 index 8/9/11/12/14/15
        // 全部出现多流抢跑（`fetch_sent` 2–5 次），成因就是这处触发。而 fork 继承主对话
        // 全历史，每个请求十万 token 级 —— 一次工具轮增量提取的代价，与一次完整的
        // end_turn 提取相同。
        //
        // 取舍如实标注（拿"更省"换掉一点"更准"）：删掉之后 Session Memory 只在
        // `end_turn` 更新，于是**长工具链会话在首个 end_turn 之前压缩时拿不到笔记**，
        // `auto-compact` 会回退传统 LLM 摘要（`trySessionMemoryCompaction` 命中失败即回退，
        // 是既有的降级路径，不是新增故障）。代价是那一次压缩多一次摘要调用；
        // 收益是每个工具轮不再各自烧一次十万 token 的 fork。
        // 提取本身没有丢：`end_turn` 那处（本文件上方）仍在，且双阈值判断不变。

        // P1-2/P2-2：本轮工具输入喂给 skill 激活协调器（条件激活 + 动态发现）。
        // 新激活/发现的 skill 会在下一轮开始经 drainSkillListingDelta → reminderParts 增量注入。
        if (deps.onSkillToolResults) {
          const toolInputs = toolBlocks
            .filter((b) => b.type === "tool_use")
            .map((b) => (b as import("../llm/types.ts").ToolUseBlock).input);
          // 刻意不 await：动态发现含动态 import + 磁盘扫描，await 会把它计入每个工具轮（伤更快）。
          // 晚到的激活由 drainListingDelta 按「真实可见集合 − 已发送」补发，至多晚一轮不会丢（P1-7）。
          // 协调器内部两段各自 try/catch 已 warn；能漏到这里的是协调器自身的结构性错误，
          // 恰恰最该知道——不许再 `.catch(() => )` 静默吞掉。
          deps.onSkillToolResults(toolInputs).catch((err: unknown) => {
            getLogger().warn(
              "SKILL",
              `skill 激活协调器异常（不阻断主循环）: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }

        // ─── 停滞升级阶梯：每个工具轮观测一次（stall-escalation.ts）───
        // 放在止损阀之前：止损阀的 remind 分支会 `continue`，放在后面那几轮就漏观测。
        // 代价是 P2-20 空转计数要到下一个工具轮才被读到（同一 state 字段，滞后一轮，不丢）。
        if (state.stall) {
          const obs = await collectStallObservation(
            toolBlocks,
            resultMap,
            state.stall.fileHashes.keys(),
          );
          const decision = observeStallTurn(
            state.stall,
            {
              ...obs,
              unchangedReports:
                (state.unchangedReportsInPrompt ?? 0) - state.stall.unchangedReports,
              oscillations:
                (sessionState.get(TODO_GATE_BUDGET_KEY) as TodoGateBudget | undefined)
                  ?.oscillations ?? 0,
            },
            stallSwitches.hardStop,
          );
          if (decision.level !== 0) {
            const acted = decision.level === 1 || decision.acted;
            emitStallEscalationEvent(deps, sessionState.sessionId, {
              ...turnMetrics(state, sessionState, promptSeq),
              level: decision.level,
              acted,
              ...decision.signals,
            });
            if (decision.level === 1) {
              state.pendingStallReminder = decision.message;
              log.warn(
                "QUERY_LOOP",
                `停滞升级 L1：连续 ${decision.signals.turnsSinceNewState} 个工具轮无新工作区状态，下一轮注入收敛提示`,
              );
            } else if (!acted) {
              log.warn(
                "QUERY_LOOP",
                `停滞升级 L2（影子）：判据命中但 stallHardStop 未开启，只记事件不停（第 ${decision.signals.l2Count} 次）`,
              );
            } else {
              log.warn("QUERY_LOOP", "停滞升级 L2：由 harness 结束本轮，走强制总结出口交还用户");
              state.stallStopRequested = true;
              // goal gate 遇 stalled 不续跑：goal 会话恰好最需要刹车，置 blocked 让后续不再自动续跑
              const goal = deps.getGoalState?.();
              if (goal && goal.status === "active") {
                deps.updateGoalState?.((g) => {
                  g.status = "blocked";
                  g.updatedAt = Date.now();
                });
              }
              yield {
                kind: "system",
                level: "warning",
                text: "任务停滞（反复改动又改回 / 重复操作无新进展），已暂停并请模型总结现状，由你决定下一步",
              };
              break;
            }
          }
        }

        // ─── 方向 2/4/6：无进展只读命令重复检测 + git-status 刷新止损阀 ───
        // 根因（根因分析-commit任务git状态快照冻结死循环.md）：git-status 快照冻结进 system
        // prompt 整会话不刷新，任务完成后模型被"快照说脏/实时说净"的矛盾锁死，反复空跑
        // git status 直到用户 ESC。此处识别"连续相同只读探查命令 + 输出稳定不变"，注入携带
        // **实时** git 状态的收敛提醒（cache-safe，走 user 消息不碰 system prompt 静态前缀），
        // 注满上限仍空转则强制收尾。检测/文案是纯函数（repeated-readonly-guard.ts），此处只做副作用。
        {
          // 从本轮工具调用提取"只读探查动作 + 实时输出"。判据(★缺口 B 修复 §4.2/§3b)：
          //   - bash 且命令是只读探查(含 cd 前缀,见 isReadonlyProbeCommand)→ 计入 probes;
          //   - 纯只读检查工具(read/ls/glob/grep/lsp)→ 归一化为 `工具名 入参` 也计入 probes,
          //     使"git status ↔ read 同一区域"交替空转能构成稳定复合签名而被识别,
          //     不再被交替的 read 当"有进展"清零(历史死循环的关键缺口);
          //   - 其它一切(写操作、编辑、其它 bash 命令、task_*/todo_write 等有产出工具、文本产出)
          //     = 真进展,置 hadOtherActivity=true 触发清零。
          const probes: Array<{ command: string; output: string }> = [];
          const measuredProgress = getMeasuredProgress(sessionState);
          let hadOtherActivity = responseText.trim().length > 0;
          for (const b of toolBlocks) {
            if (b.type !== "tool_use") continue;
            const readOutput = () => {
              const r = resultMap.get(b.id);
              const raw =
                r && r.type === "tool_result"
                  ? typeof r.content === "string"
                    ? r.content
                    : JSON.stringify(r.content)
                  : "";
              // 发现 4 防回归：read 的效率提示是每轮自增的元信息("第N次读取"),不是文件内容。
              // 做"卡住"签名前必须剥离——否则相同区域的重复读每轮签名都不同,repeatCount 永远清零,
              // 反而瘫痪 git-status 冻结死循环止损阀(缺口B)。只影响 read 家族,其它探查输出无此标记、原样返回。
              return stripReadEfficiencyHint(raw);
            };
            const cmd = b.name === "bash" ? (b.input as any)?.command : undefined;

            // ─── P1-4 item 1：采集"实测进展"两个维度（与下方止损阀共用这次遍历）───
            //
            // 这里是全 harness 里唯一能同时看到「工具入参 + 真实返回值」的地方，故两件事都在此记：
            //   ① 文件落盘：edit/write/notebook_edit 执行完 → 磁盘确实变了（不可伪造的进展证据）；
            //   ② 可量化观测值：任何 bash 命令，只要输出是单个标量（`grep -c` / `wc -l` / 自研
            //      脚本吐一个数字）就登记，首末值不同即"世界确实变了"。
            //
            // 判据刻意是**形态**而非命令名：harness 不该知道用户项目的检查命令是 tsc 还是
            // cargo check 还是 pytest（写死命令名 = 只对 TS 项目有效，换语言就静默失效，
            // 而静默失效的信号比没有信号更糟）。详见 measured-progress.ts 顶部注释。
            if (FILE_MUTATING_TOOLS.has(b.name)) {
              recordFileChange(measuredProgress, (b.input as any)?.file_path);
              recordFileChange(measuredProgress, (b.input as any)?.notebook_path);
              // 返工检测：只认执行成功的落盘（失败的 edit 没改磁盘，不算返工也不算进展）
              const r = resultMap.get(b.id);
              const failed = !!(r && r.type === "tool_result" && (r as any).is_error);
              if (!failed) {
                const rework = getTodoReworkState(sessionState);
                const current = deps.getTodoState?.()?.todos ?? null;
                recordFileEditForRework(rework, (b.input as any)?.file_path, current);
                recordFileEditForRework(rework, (b.input as any)?.notebook_path, current);
              }
            } else if (b.name === "bash" && typeof cmd === "string") {
              recordScalarObservation(measuredProgress, cmd, readOutput());
            }

            if (b.name === "bash" && typeof cmd === "string" && isReadonlyProbeCommand(cmd)) {
              probes.push({ command: cmd, output: readOutput() });
            } else if (isReadFamilyTool(b.name)) {
              // 纯只读检查工具:用"工具名 + 稳定序列化入参"作为签名命令,
              // 读同一区域(入参相同)且返回相同 → 与 git status 一起构成稳定签名。
              probes.push({ command: makeToolProbeCommand(b.name, b.input), output: readOutput() });
            } else {
              // 写操作、编辑、其它 bash、有产出工具 = 有进展。
              hadOtherActivity = true;
            }

            // ─── P2-20：同指纹同返回值空转（运行时口径，只报不拦）───
            //
            // 覆盖上面两道阀的盲区：`probes` 只收 bash 只读白名单命令与
            // read/ls/glob/grep/lsp，`lowYieldSpin` 只收输出是单标量的 bash。
            // web_fetch / web_search / tool_search，以及「返回一大段完全相同文本」的调用
            // 两道都不命中 —— 而 digest 的 observationEntropyPathological 判的正是这个形态，
            // 却只在 /insights 离线算，运行时零动作（同参同返回值连转 22 次也没有任何信号）。
            //
            // 这里**不做任何干预**（不注入、不收尾）：工具循环检测默认全关是有实测背书的
            // 否决（误判率≈100%，见 .agents/notes/rejected/feature/2026-07-14-*），
            // 那份否决同时指出正确切法是「输入 + 输出双重复」，并说当时卡在「检测器看不到
            // observation」。本阀就是那个双判据，先采数（触发率 + 工具分布）再谈干预 ——
            // 阈值 3 从未在运行时验证过误报率，没有分母就拦是在猜。
            //
            // 文件落盘类工具（edit/write/notebook_edit）不入本阀：它们的返回值本来就常是
            // 「已写入」这类固定短语，连续相同是**正常**的，计进去纯噪声。
            if (!FILE_MUTATING_TOOLS.has(b.name)) {
              if (!state.unchangedObservation) {
                state.unchangedObservation = createUnchangedObservationState();
              }
              const unchanged = observeToolResult(state.unchangedObservation, {
                toolName: b.name,
                input: b.input,
                output: readOutput(),
              });
              if (unchanged.shouldReport) {
                state.unchangedReportsInPrompt = (state.unchangedReportsInPrompt ?? 0) + 1;
                log.warn(
                  "QUERY_LOOP",
                  `同参同返回值空转：\`${unchanged.tool}\` 连续 ${unchanged.run} 次入参与返回值` +
                    `完全相同（阈值 ${UNCHANGED_OBSERVATION_THRESHOLD}），重复劳动未产出新信息。` +
                    `本阀只告警不干预`,
                );
                if (deps.traceAppendEvent) {
                  try {
                    deps.traceAppendEvent({
                      event: "UnchangedObservationRun",
                      session_id: sessionState.sessionId,
                      timestamp: new Date().toISOString(),
                      data: {
                        ...turnMetrics(state, sessionState, promptSeq),
                        tool: unchanged.tool,
                        run: unchanged.run,
                        threshold: UNCHANGED_OBSERVATION_THRESHOLD,
                        // 与离线 digest 的 observationEntropyPathological 同口径同阈值，
                        // 可直接对照「运行时报过几次」与「周报判了几个病态会话」。
                        intervened: false,
                      },
                    });
                  } catch {
                    /* trace 写入失败不阻断主循环 */
                  }
                }
              }
            }
          }
          // ─── P1-4 item 3：低信息量空转检测（独立于上面那道只读探查阀）───
          //
          // 为什么必须独立一道而不是调那道的阈值：事故里的
          // `cd <repo> && bunx tsc --noEmit 2>&1 | grep -c "error TS"` 含管道且 bunx 不在
          // 只读白名单，实测 isReadOnlyCommand=false → isReadonlyProbeCommand=false，
          // 33 次空转一次都进不了 repeatedReadonly。缺的不是阈值，是这个形态的检测本身。
          // 判据是"输出是单标量且不变 + 无落盘 + 无面向用户文本"，见 low-yield-spin.ts。
          {
            const bashCommands: string[] = [];
            const bashOutputs: string[] = [];
            let hadFileMutation = false;
            for (const b of toolBlocks) {
              if (b.type !== "tool_use") continue;
              if (FILE_MUTATING_TOOLS.has(b.name)) {
                hadFileMutation = true;
                continue;
              }
              if (b.name !== "bash") continue;
              const c = (b.input as any)?.command;
              if (typeof c !== "string") continue;
              const r = resultMap.get(b.id);
              bashCommands.push(c);
              bashOutputs.push(
                r && r.type === "tool_result"
                  ? typeof r.content === "string"
                    ? r.content
                    : JSON.stringify(r.content)
                  : "",
              );
            }
            if (!state.lowYieldSpin) state.lowYieldSpin = createLowYieldSpinState();
            const lowYield = observeLowYieldTurn(state.lowYieldSpin, {
              commands: bashCommands,
              outputs: bashOutputs,
              hadFileMutation,
              // responseText 是面向用户的文本产出（thinking 不在其中）——"只思考不交付"
              // 正是本阀要盯的形态，故有文本产出即视为有交付、清零。
              hadTextOutput: responseText.trim().length > 0,
            });
            if (lowYield.intervene && lowYield.command !== undefined) {
              state.pendingLowYieldSpinReminder = buildLowYieldSpinReminder(
                lowYield.command,
                lowYield.output ?? "",
                lowYield.repeatTurns,
              );
              log.warn(
                "QUERY_LOOP",
                `低信息量空转：连续 ${lowYield.repeatTurns} 轮同参同返回值的单标量命令 ` +
                  `\`${lowYield.command.trim()}\`（阈值 ${LOW_YIELD_SPIN_THRESHOLD}），` +
                  `下一轮注入可执行替代命令（第 ${state.lowYieldSpin.interventionCount}/${MAX_LOW_YIELD_INTERVENTIONS} 次）`,
              );
              // 可观测性：与 RepeatedReadonlyGuardTriggered 同机制。没有埋点的话，
              // "这道阀有没有触发过、有没有误伤"只能靠离线重放猜（发现 1 的教训）。
              if (deps.traceAppendEvent) {
                try {
                  deps.traceAppendEvent({
                    event: "LowYieldSpinIntervened",
                    session_id: sessionState.sessionId,
                    timestamp: new Date().toISOString(),
                    data: {
                      ...turnMetrics(state, sessionState, promptSeq),
                      repeatTurns: lowYield.repeatTurns,
                      interventionCount: state.lowYieldSpin.interventionCount,
                      cap: MAX_LOW_YIELD_INTERVENTIONS,
                      command: lowYield.command.trim().slice(0, 200),
                      output: (lowYield.output ?? "").trim().slice(0, 40),
                    },
                  });
                } catch {
                  /* trace 写入失败不阻断主循环 */
                }
              }
            }
          }

          if (!state.repeatedReadonly) state.repeatedReadonly = createRepeatedReadonlyState();
          const decision = observeRepeatedReadonly(
            state.repeatedReadonly,
            probes,
            hadOtherActivity,
          );
          if (decision.stuck && decision.action === "remind" && decision.command !== undefined) {
            // 重新抓取实时 git 状态块，作为权威事实随提醒下发（压制冻结快照）。
            let freshGitStatus: string | null = null;
            try {
              const { generateGitStatusAttachment, clearGitStatusCache } =
                await import("../config/attachments.ts");
              const { getCwd } = await import("../bootstrap/state.ts");
              clearGitStatusCache(); // 先失效缓存，确保拿到的是最新状态（方向 3 同源）
              // 用 getCwd() 而非 process.cwd()：bash 工具的 cd 追踪走全局状态而非 process.chdir，
              // 只有 getCwd() 能反映会话内 cd 后的真实目录，与 bash 命令实际执行目录一致。
              freshGitStatus = generateGitStatusAttachment(getCwd())?.content ?? null;
            } catch {
              /* 抓取失败不阻断，提醒仍带命令实时输出 */
            }
            // 与 pendingContradictions 同机制：不在此直接 addMessage（那会永久落历史、长任务膨胀），
            // 而是置 pending，下一轮循环开头经 reminderParts → injectReminders 注入（仅本轮、缓存友好）。
            state.pendingStuckReminder = buildStuckReminder(
              decision.command,
              decision.output ?? "",
              freshGitStatus,
            );
            log.warn(
              "QUERY_LOOP",
              `无进展止损：连续 ${state.repeatedReadonly.repeatCount} 轮空跑只读命令 \`${decision.command.trim()}\`，` +
                `下一轮经 reminder 通道注入实时 git 状态收敛提醒（第 ${state.repeatedReadonly.reminderCount}/${2} 次）`,
            );
            emitStuckGuardEvent(deps, sessionState.sessionId, {
              action: "remind",
              ...turnMetrics(state, sessionState, promptSeq),
              repeatCount: state.repeatedReadonly.repeatCount,
              reminderCount: state.repeatedReadonly.reminderCount,
              command: decision.command.trim().slice(0, 200),
              probeCount: probes.length,
            });
            yield {
              kind: "system",
              level: "warning",
              text: `检测到反复执行同一只读命令且结果不变，已注入实时状态并提示收敛`,
            };
            setTransition(state, { type: "tool_use" }, deps, sessionState.sessionId);
            continue;
          }
          if (decision.stuck && decision.action === "terminate" && decision.command !== undefined) {
            // 已注满提醒上限仍空转 → 强制收尾，避免无限循环到用户 ESC。
            const notice = buildTerminateNotice(decision.command);
            ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: notice }] });
            try {
              deps.sessionStore?.appendMessage({
                role: "user",
                content: [{ type: "text", text: notice }],
              });
            } catch {
              /* 持久化失败不阻断 */
            }
            log.warn(
              "QUERY_LOOP",
              `无进展止损：连续空跑只读命令 \`${decision.command.trim()}\` 且提醒无效，强制收尾（避免无限循环）`,
            );
            // 埋点务必在 yield done 之前发：这是全 harness 唯一会**掐断用户任务**的动作，
            // 若埋在 return 之后就永远不会执行，而它恰恰是最需要留痕的一次。
            emitStuckGuardEvent(deps, sessionState.sessionId, {
              action: "terminate",
              ...turnMetrics(state, sessionState, promptSeq),
              repeatCount: state.repeatedReadonly?.repeatCount ?? 0,
              reminderCount: state.repeatedReadonly?.reminderCount ?? 0,
              command: decision.command.trim().slice(0, 200),
              probeCount: probes.length,
            });
            yield {
              kind: "system",
              level: "warning",
              text: `连续空转于同一只读命令，已强制结束以避免无限循环`,
            };
            yield {
              kind: "done",
              turns: state.turnCount,
              // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
              turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            };
            exitedViaReturn = true;
            return;
          }
        }

        // ─── 缺口1 Phase B：mid-turn 抢占式 drain（安全检查点 = 工具批次之间）───
        // 此处是天然安全点：本轮 tool_use 已全部拿到配对的 tool_result 并入历史
        //（上方 addMessage(toolResults)），不存在孤儿 → 满足不变量 1（finalizeMessagesForSend 配对）。
        // 仅 drain `now` 级（用户显式中断/改向）：把排队的高优先级用户输入 mid-turn 插入为 user 消息，
        // 让模型在下一轮立刻看到，而非等到整个任务 end_turn 后才接续（对齐 CC drain mid-turn between turns）。
        // next/later 级（普通排队输入 / 后台通知）不在此插入，仍走回合边界 drain，避免打断正常推进。
        // 灰度：默认关闭，SID_ENABLE_MIDTURN_DRAIN=1 开启；关闭时行为与改造前完全一致（向后兼容）。
        if (process.env.SID_ENABLE_MIDTURN_DRAIN === "1" && hasPending("now")) {
          // 只取 now 级的 user-input（按 priority+kind 双条件），不误吞 / 丢弃其余 now 级 kind。
          // 非 user-input 的 now 级命令（如未来的孤儿权限响应）保留在队列，走各自专门通道。
          const preempts = drainByPriorityAndKind("now", "user-input");
          const injected = injectQueuedCommandsAsUserMessage(preempts, ctxMgr, deps);
          if (injected > 0) {
            log.info(
              "QUERY_LOOP",
              `mid-turn 抢占：注入 ${injected} 条 now 级用户输入，本轮工具结果已配对无孤儿`,
            );
            yield {
              kind: "system",
              level: "info",
              text: `已插入 ${injected} 条新输入，将在下一轮优先处理`,
            };
          }
        }

        setTransition(state, { type: "tool_use" }, deps, sessionState.sessionId);
        continue;
      }

      // ─── max_tokens 续写（含递减收益检测 + 分级恢复）───
      if (stopAction.kind === "recover" && stopAction.how === "max_tokens") {
        diminishingDetector.record(response.usage.outputTokens);

        if (diminishingDetector.shouldStop()) {
          // Top 3（2026-07-07 约束型误伤修复）：递减收益命中不再直接 `return` 终止整轮——
          // 那会在模型"没说完"时静默掐断，且与"分段小步写大文件"的续写引导自相矛盾。
          // 改为：第一次命中 → 停止自动续写，注入一次"让手提示"把决定权交还模型（它可以
          // 收尾、换分段策略、或调工具继续），continue 让模型自己走下一轮；仅当让手后仍
          // 撞 max_tokens 且再次命中递减收益时，才真正终止（避免无限续写烧 token）。
          if (!state.diminishingReturnsHandoffDone) {
            state.diminishingReturnsHandoffDone = true;
            diminishingDetector.reset(); // 让手后重新计数，给模型一个干净的续写窗口
            log.warn(
              "QUERY_LOOP",
              `max_tokens 续写递减收益命中（已续写 ${diminishingDetector.count} 次），停止自动续写并让手给模型自行决定`,
            );
            yield {
              kind: "system",
              level: "info",
              text: `连续续写产出递减，已停止自动续写，交由模型决定下一步`,
            };
            const handoffNotice =
              `<system-reminder>\n` +
              `连续自动续写多次后每次产出都很少，已停止自动续写。请你自己决定下一步：\n` +
              `1. 如果内容已基本完成，直接收尾并说明结论，不要为了"继续"而继续。\n` +
              `2. 如果确实还有大量内容要写，改用分段策略：单次工具调用（如 write 的 content）` +
              `不要超过输出上限，先写一部分落盘，再用 edit / bash 追加剩余部分。\n` +
              `3. 如果卡在某处，明确说出卡点，或改调其他工具去推进。\n` +
              `请勿向用户提及本提醒。\n` +
              `</system-reminder>`;
            ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: handoffNotice }] });
            try {
              deps.sessionStore?.appendMessage({
                role: "user",
                content: [{ type: "text", text: handoffNotice }],
              });
            } catch {
              /* 持久化失败不阻断让手 */
            }
            setTransition(state, { type: "max_tokens_continuation" }, deps, sessionState.sessionId);
            continue;
          }
          // 让手后仍收敛不了 → 终止，避免无限续写
          log.warn(
            "QUERY_LOOP",
            `max_tokens 续写递减收益二次命中（让手后仍未收敛，已续写 ${diminishingDetector.count} 次），停止续写`,
          );
          yield {
            kind: "system",
            level: "info",
            text: `输出续写已达上限（${diminishingDetector.count} 次），自动停止`,
          };
          yield {
            kind: "done",
            turns: state.turnCount,
            // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          };
          exitedViaReturn = true;
          return;
        }

        // Stage 1：首次截断且当前上限低于模型硬上限 → 提升上限重试，不注入续写提示
        // 当用户显式设了较低 maxTokens 或 effort 模式压低输出时，直接提升上限通常一步解决
        //
        // ⚠ 必须按**真名**查：三段查询全按名匹配，喂本地别名
        // （前缀式如 gw-claude-sonnet-4-6）必然 miss → modelMax=undefined → 下面
        // `if (modelMax && ...)` 直接短路 → **Stage 1 整块永久跳过**，本该一步解决的
        // 截断退化成反复走 Stage 2 续写。与 fallback.ts 两处同一类错误，
        // 别名与真名相同时 resolveWireModel 原样返回，行为不变。
        //
        // 三段是「registry 精确 → 采集精确 → registry 模糊」（见 model-lookup.ts）。
        // 这里对模糊层的容忍度比别处高：拿到一个偏小的猜测值只会让 Stage 1 少抬一点上限，
        // 然后照旧退到 Stage 2 续写（功能正确、多烧一轮）；而完全拿不到值是 Stage 1
        // **整块跳过**。所以三段全查比只查 registry 严格更好，没有反方向的风险。
        const modelMax = resolveRegistryMaxOutputTokens(
          resolveWireModel(config.model, config.availableModels),
        );
        const currentCeiling = state.maxOutputTokensOverride ?? config.maxTokens;
        if (modelMax && currentCeiling < modelMax && state.maxOutputTokensRecoveryCount === 0) {
          state.maxOutputTokensOverride = modelMax;
          state.maxOutputTokensRecoveryCount++;
          log.info("QUERY_LOOP", `输出截断，提升 maxTokens 上限: ${currentCeiling} → ${modelMax}`);
          setTransition(state, { type: "max_tokens_escalate" }, deps, sessionState.sessionId);
          continue;
        }

        // Stage 2：已至模型上限或提升无效 → 注入续写提示
        state.maxOutputTokensRecoveryCount++;
        log.info(
          "QUERY_LOOP",
          `输出达到 token 上限 (maxTokens=${state.maxOutputTokensOverride ?? config.maxTokens})，自动续写 #${state.maxOutputTokensRecoveryCount} (轮次 ${state.turnCount})`,
        );

        // 注入截断通知：告知模型上一次响应因输出长度上限被截断，请从中断处继续。
        // 不注入则模型对"为何被打断、从哪里续"完全无感知——续写时可能重头再来或跳过内容，
        // 甚至（当截断发生在工具调用参数中途时）反复重发同一个超大调用。对齐 claude-code
        // 的 [Response clipped] 提示。走 user 消息通道，随历史流入下一轮请求。
        {
          const clipNotice =
            `<system-reminder>\n` +
            `你的上一次响应因达到输出长度上限（max_tokens）被截断，尚未完成。请直接从被截断处继续——` +
            `不要道歉，不要重新开场，不要重复已经输出的内容。` +
            `如果被截断时正在写代码或文本中途，直接从断点处接续。\n` +
            `如果你正在写入大文件或长内容，请改用分段策略：单次工具调用的参数（如 write 的 content）` +
            `不要超过输出上限，先写一部分，再用 edit / bash 追加剩余部分。\n` +
            `（自动续写 ${state.maxOutputTokensRecoveryCount} 次）\n` +
            `</system-reminder>`;
          ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: clipNotice }] });
          try {
            deps.sessionStore?.appendMessage({
              role: "user",
              content: [{ type: "text", text: clipNotice }],
            });
          } catch {
            /* 持久化失败不阻断续写 */
          }
        }

        setTransition(state, { type: "max_tokens_continuation" }, deps, sessionState.sessionId);
        continue;
      }

      // ─── refusal（模型安全策略拒答，Opus 4.7+ 新增）───
      // [来源: anthropic-api.md:556,752]
      if (stopAction.kind === "terminal" && stopAction.reason === "refusal") {
        const refusalText =
          response.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("")
            .trim() || "模型基于安全策略拒绝回答";
        log.warn("QUERY_LOOP", `模型安全拒答: ${refusalText.slice(0, 200)}`);
        // refusal 在工具分支之后，content 里的 tool_use 不会执行——就地结算（见 terminal-finalize.ts）
        state.incompleteReason = "refusal";
        settleOrphanToolUses(ctxMgr, state.incompleteReason);
        turnStopReason = "other";
        yield {
          kind: "system",
          level: "warning",
          terminal: true,
          text: `[安全策略拒答] ${refusalText}`,
        };
        yield {
          kind: "done",
          turns: state.turnCount,
          // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
          turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
          incompleteReason: state.incompleteReason,
        };
        exitedViaReturn = true;
        return;
      }

      // ─── model_context_window_exceeded（撞模型 context window 上限，Claude 4.5+ 新增）───
      // 区别于 max_tokens（主动设的输出上限），这是输入+输出总和撞到模型硬上限。
      // 处理策略：压缩上下文后续写，**有界**。[来源: anthropic-api.md:553,559]
      //
      // 2026-10-24：此前本分支无任何封顶——压缩失败只给 consecutiveCompactFailures +1、
      // 从不检查熔断，也不走递减收益检测；transition 借用 max_tokens_continuation，还顺手
      // `maxOutputTokensRecoveryCount++`，让之后真正的 max_tokens 失去「先提高上限」那一档
      // （Stage 1 只在计数为 0 时尝试）。历史压不动 + 服务端持续返回该 stopReason 时，
      // 交互模式（maxTurns=Infinity）会一轮轮空烧到用户 ESC。
      //
      // 封顶与子代理同一取向（agent/agentic-loop.ts B5-1）：
      //   ① 压不动 → 立即收尾：已无可裁剪空间，再来一轮必然撞同一个上限；
      //   ② 压得动也只给 MAX_CTX_WINDOW_RECOVERIES 次 → 防「压一点、又撞上限」的慢速空转。
      // 两种收尾都带 incompleteReason，SDK / 无头不会把它记成 success。
      if (stopAction.kind === "recover" && stopAction.how === "ctx_window") {
        // 截断的那一轮内容已在上方入历史；它可能带着未执行的 tool_use，收尾前必须补占位
        // tool_result，否则下一条用户消息发送时 tool_use/tool_result 不配对（OpenAI 400）。
        // 与其它 terminal 出口共用 terminal-finalize.ts（续写路径同样要结算，故不只在收尾时调）。
        const settleCtxOrphans = (): void => {
          settleOrphanToolUses(ctxMgr, "context_window_exhausted");
        };
        const exhaust = (detail: string): void => {
          noteGateExhausted("context_window", used, MAX_CTX_WINDOW_RECOVERIES);
          log.error("QUERY_LOOP", `context window 恢复终止：${detail}`);
          settleCtxOrphans();
          turnStopReason = "other";
        };

        const used = state.ctxWindowRecoveryCount ?? 0;
        if (used >= MAX_CTX_WINDOW_RECOVERIES) {
          exhaust(`压缩续写已达 ${MAX_CTX_WINDOW_RECOVERIES} 次上限仍撞窗口上限`);
          yield {
            kind: "system",
            level: "error",
            terminal: true,
            text:
              `上下文反复撞到模型窗口上限（已压缩续写 ${MAX_CTX_WINDOW_RECOVERIES} 次仍未脱离），本轮已停止。\n` +
              `建议执行 /compact 或开新会话后再继续。`,
          };
          yield {
            kind: "done",
            turns: state.turnCount,
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            incompleteReason: (state.incompleteReason = "context_window_exhausted"),
          };
          exitedViaReturn = true;
          return;
        }

        log.warn("QUERY_LOOP", "撞到模型 context window 上限，触发上下文压缩后续写");
        // 这条路径不加占用率门禁：服务端已明确拒绝（撞到窗口硬上限），是"真溢出"的确凿证据，
        // 此时无论本地估算多少都该压——与空参数路径（无证据的猜测）性质完全不同。
        const compactResult = reactiveCompact(ctxMgr);
        // 成败都经 settleCompaction 落 CompactionAttempt（此前失败分支只写 warn.log，
        // 事件里看不到这条路径压没压动）。banner 非 null ⟺ 实测真压动了。
        const { banner, outcome: ctxWindowOutcome } = settleCompaction(
          deps,
          sessionState.sessionId,
          compactScope,
          {
            trigger: "ctx_window_exceeded",
            messageCountBefore: compactResult.messageCountBefore,
            messageCountAfter: compactResult.messageCountAfter,
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter,
            strategy: compactResult.strategy,
          },
        );

        // 恢复路径不许 noop：这里非 applied 即 failed，计数已由 settleCompaction 维护。
        if (ctxWindowOutcome !== "applied") {
          exhaust(`压缩未生效（${compactResult.messageCountBefore} 条未变）`);
          yield {
            kind: "system",
            level: "error",
            terminal: true,
            text: buildCompactCircuitBreakerText(state.consecutiveCompactFailures ?? 0, {
              fixedTokens: ctxMgr.estimateFixedOverheadTokens(toolRegistry.size()),
              totalTokens: ctxMgr.estimateTokens(toolRegistry.size()),
              memoryTokens: ctxMgr.getMemoryTokens(),
              maxTokens: ctxMgr.getMaxTokens(),
              latestUserInputTokens: ctxMgr.estimateLatestUserInputTokens(toolRegistry.size()),
            }),
          };
          yield {
            kind: "done",
            turns: state.turnCount,
            turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
            incompleteReason: (state.incompleteReason = "context_window_exhausted"),
          };
          exitedViaReturn = true;
          return;
        }

        state.ctxWindowRecoveryCount = used + 1;
        state.goalReminderPendingAfterCompact = true;
        state.todoReminderPendingAfterCompact = true;
        state.deferredToolsPendingAfterCompact = true;
        log.info(
          "QUERY_LOOP",
          `context_window_exceeded 压缩续写（第 ${state.ctxWindowRecoveryCount}/${MAX_CTX_WINDOW_RECOVERIES} 次）：` +
            `${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条`,
        );
        if (banner) yield banner;
        // P1-13：走与 auto/manual 同一套压缩后收尾。
        await deps.postCompactTail?.({
          trigger: "reactive",
          messagesBefore: compactResult.messageCountBefore,
          tokensBefore: compactResult.tokensBefore,
        });
        yield {
          kind: "system",
          level: "info",
          text: `输出因撞到模型上下文窗口上限被中断，已压缩上下文后续写 (${state.ctxWindowRecoveryCount}/${MAX_CTX_WINDOW_RECOVERIES})`,
        };
        settleCtxOrphans();
        setTransition(state, { type: "context_window_recovery" }, deps, sessionState.sessionId);
        continue;
      }

      // ─── pause_turn（server tool 暂停）───
      // [来源: anthropic-api.md:557]
      //
      // P2-5：**不再伪装成 `tool_use` continue**，改为落到下方"未识别停止原因"的显式收尾。
      //
      // 旧实现 `setTransition({type:"tool_use"}); continue;` 有三处与事实不符：
      //   ① 没有 `executeTools`，也没有把未完成的 server tool 结果接回历史 —— 真正的
      //      server-tool 续接要求把 `server_tool_use` 块原样回传，让上游继续那次调用。
      //      而本仓 Anthropic 解析对未知块类型（含 `server_tool_use`）直接丢成空 text
      //      （见 anthropic.ts 的"未知块类型静默忽略"），块早就没了，无从接回。
      //   ② `continue` 会让 while 顶部再 `turnCount++`，一轮预算白烧在一次什么都没做的往返上；
      //      上游没拿到任何新输入，大概率原样再回一个 pause_turn → 直到打满 maxTurns。
      //   ③ 观测上被记成 `LoopTransition.type=tool_use`，离线分析里**像是跑过工具**。
      //      按 type 统计工具轮次时它是纯噪音，而这正是"归因与真实信号脱节"那类反模式。
      //
      // 现状事实：本仓 `web_search` 是本地工具、不是 Anthropic server tool，全仓
      // 没有任何 server-tool 续接实现，所以这条分支实际是死路径。未实现续接之前，
      // 正确行为是**如实收尾**（下方分支会 yield 一条 terminal 提示 + done），而不是
      // 假装推进。真要支持 server tool，改动点是 anthropic.ts 保留 `server_tool_use`
      // 块 + 此处回传续接，两者缺一不可 —— 届时再开分支，别复活这个 `continue`。
      if (stopAction.kind === "terminal" && stopAction.reason === "pause_turn") {
        log.warn(
          "QUERY_LOOP",
          "收到 pause_turn（server tool 暂停）：本仓未实现 server-tool 续接，如实收尾不伪装 tool_use 续接",
          { contentBlocks: response.content.length },
        );
        // 不 continue、不 setTransition —— fall through 到下方未识别停止原因的统一收尾。
      }

      // ─── 其他停止原因（含 null）───
      // 背景（事故复盘 session 20260708-102143）：当上游返回"伪装成功的空流"
      // （如网关对不可用模型回 HTTP 200 + text/html 错误页，被 SSE 解析成 0 事件），
      // stopReason 会是 null 且 content 为空，一路穿透上面所有停止原因分支落到这里。
      // 此前本分支只写 warn.log + 静默 yield done——用户界面毫无提示，表现为"任务
      // 一闪而过就没了"。现在必须把这类静默失败暴露给用户（yield system error），
      // 且区分"空响应"（真故障）与"非空但停止原因未识别"（罕见，可能是新协议字段）。
      //
      // 走到这里的只有三种分类：terminal(pause_turn / empty_stream) 与 unknown（含报 tool_use
      // 却无 tool_use 块）。三者都带 incompleteReason，并就地结算孤儿 tool_use——此前这里
      // 不结算，靠下次发送前的 finalizeMessagesForSend 事后补占位。
      const hasAnyContent = response.content.length > 0;
      state.incompleteReason =
        stopAction.kind === "terminal" && stopAction.reason === "pause_turn"
          ? "pause_turn"
          : hasAnyContent
            ? "unknown_stop_reason"
            : "empty_stream";
      settleOrphanToolUses(ctxMgr, state.incompleteReason);
      turnStopReason = "other";
      if (!hasAnyContent) {
        // 空响应 + 未知/空停止原因 = 伪装成功的空流。如实报错，不假装完成。
        log.error(
          "QUERY_LOOP",
          `空响应且停止原因异常（stopReason=${response.stopReason}），判定为伪装成功的空流，本轮中断`,
        );
        yield {
          kind: "system",
          level: "error",
          text:
            `⚠️ 模型返回空响应（停止原因: ${response.stopReason ?? "null"}），本轮对话中断。\n` +
            `常见原因：主模型不可用触发降级、网关返回非流式错误页、或所配模型 ID 与网关实际可用模型不一致。\n` +
            `请检查 ~/.sid-code/settings.json 的 model / fallbackModel 是否为网关真实可用的模型，然后重新发送消息。`,
        };
      } else {
        // 有内容但停止原因未识别（罕见）：内容已通过 assistant_message 呈现，这里补一条
        // 提示说明本轮为何提前收尾，避免用户困惑"为什么突然停了"。
        //
        // 排查留痕：stopReason=null 且有内容的典型场景是"截断流"（代理 delta 后直接断流、
        // 从未发 message_delta 收尾帧）。补 contentBlocks / hasToolUse 上下文，便于事后从
        // 日志判断"提前收尾时到底积累了什么"（尤其是有 tool_use 却没执行的漏网场景）。
        log.warn("QUERY_LOOP", `未知停止原因: ${response.stopReason}`, {
          contentBlocks: response.content.length,
          hasToolUse: response.content.some((b) => b.type === "tool_use"),
        });
        yield {
          kind: "system",
          level: "warning",
          terminal: true,
          text: `模型以未识别的停止原因结束本轮（stopReason: ${response.stopReason ?? "null"}）。若回答不完整，请重新发送消息继续。`,
        };
      }
      yield {
        kind: "done",
        turns: state.turnCount,
        // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
        turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
        incompleteReason: state.incompleteReason,
      };
      exitedViaReturn = true;
      return;
    }
  } finally {
    // ─── P1-4：端到端耗时锚点（TurnComplete）───
    //
    // 放在 finally 而不是逐个出口：queryLoop 有 20+ 个 `yield done; return`，逐个补
    // 必然漏 —— 而漏掉的恰恰是异常/中断路径，也就是**最慢的那些轮次**。只在成功路径
    // 发事件会让 p95 系统性偏低，看起来"变快了"其实是把慢样本筛掉了（选择偏差）。
    // finally 覆盖正常 return / throw / 外部 .return() 中止三条路径，一个不漏。
    //
    // ⚠ 一个**必须**在这里点破的例外：本 finally 跑在 maxTurns 强制总结轮（下方，在 try
    // 之外）**之前**。若在此处就发事件，那条路径的端到端耗时会漏掉整个强制总结轮 ——
    // 而强制总结正是发生在最长的那些轮次上，漏掉等于系统性低估最慢样本，与"只在成功
    // 路径发事件"是同一种偏差。所以命中该条件时**推迟**到下方总结轮结束后再发。
    if (pendingPromiseNudge) {
      emitPromiseNudge(pendingPromiseNudge.lang, true, { outcome: "no_response" });
      pendingPromiseNudge = undefined;
    }
    if (!willRunForcedSummary()) emitTurnCompleteHere();

    // Fix 1：queryLoop 结束时批量清理本次 loopId 下所有快照残留
    clearAllSnapshots(loopId);

    // 主循环终止时：本次 queryLoop 的最后一轮已跑完，推进回合纪元（S3），再做一次收尾驱逐。
    // 根因：evictTerminalTasks() 每轮开头才调用，是"下一轮驱动"的清除——end_turn 之后再无
    // 下一轮开头。finally 覆盖正常 end_turn / 异常 / 外部 .return() 三条路径。
    //
    // 收尾时推进纪元是对的：最后一轮开头送达的通知，模型已在这一轮看过并作答。
    // 仍要等面板驻留期（completed/failed 30s、killed 3s）的，交给 TUI 的 1s 定时器
    // （App.tsx，对标 cc CoordinatorAgentStatus）；未送达的交给 registry 的安全阀定时器。
    // M5：只有最后一轮模型确实返回过响应才推进。ESC 中止在流式阶段 / 调用抛错退出时，
    // 最后一次注入的通知模型并没看到，推进纪元会让它在下一次 queryLoop 之前就可被驱逐。
    if (modelRespondedSinceTurnMark) {
      markMainTurnCompleted();
      modelRespondedSinceTurnMark = false;
    }
    try {
      evictTerminalTasks();
    } catch {
      /* 收尾清理不应影响主循环退出 */
    }
  }

  // ─── P1-1：主循环达到 maxTurns——强制请求总结（额外一轮，不计入 maxTurns）───
  // 对齐 src/agent/agentic-loop.ts:344-393 子代理版的同一做法：硬停在 maxTurns 时，
  // 最后一条 assistant 消息很可能是工具调用中途、或"让我先看看…"这类未收尾文本，直接
  // 把它当结果丢给用户体验很差。这里追加一轮不带工具的调用，逼模型输出结构化总结。
  // 用 deps.sendWithRetry/processStream（而非直连 provider）保持与 loop.ts 其余部分
  // 一致的可测试性；调用失败不阻断收尾（降级为下面按 turnCount 正常提示 max_turns）。
  // 停滞 L2 与 maxTurns 共用本出口，只有提示文本按触发原因区分。
  const stalledExit = state.stallStopRequested === true && state.turnCount < state.maxTurns;
  // 与其它出口同一写入点：下方 emitTurnCompleteHere 读 state.incompleteReason
  if (stalledExit) state.incompleteReason = "stalled";
  if ((state.turnCount >= state.maxTurns || stalledExit) && !deps.getAbortSignal?.()?.aborted) {
    log.info(
      "QUERY_LOOP",
      stalledExit
        ? "停滞升级 L2：请求强制总结（现状 / 卡点 / 可选方案）"
        : `P1-1：达到最大轮次 ${state.maxTurns}，请求强制总结`,
    );
    ctxMgr.addMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: stalledExit
            ? buildStallSummaryPrompt(deps.getGoalState?.()?.objective)
            : "你已达到最大轮次限制，无法继续调用工具。请立即总结你目前为止的所有发现和已完成的工作，以及尚未完成的部分，用结构化格式（列表/表格）呈现。不要再调用任何工具。",
        },
      ],
    });
    // ─── §20.4（2026-08-30 实测）：本轮必须入账 ───
    // 缺陷形态：P1-1 走 deps.sendWithRetry/processStream，但它在 while 循环**之外**，
    // 于是不经过循环内的 BeforeModel/AfterModel 发射点。后果是**同一轮在三处同时漏**：
    //   ① `metadata.total_tokens_received` / `total_cache_read_tokens`（累加在
    //      collector.handleAfterModel 内，而它 `!this.currentPair` 就 early-return）；
    //   ② `raw.jsonl` 不落这一条；
    //   ③ digest 首行的 `API N 次`（取数自上面两者）。
    // 实测判据：`HttpConnected=41` 而 `BeforeModel=40`、`raw.jsonl` 只 40 条，
    // 且 harbor 侧读数与 40 条 raw 的合计**逐字节相等** —— 不是少算一点，是整轮不在分母里。
    // ⚠️ 偏差**有方向**：只有撞满上限的题才有 P1-1 轮，而那正是最贵的一批
    //（实测一道 $3.54 的题漏掉 cache_read=122594），所以「更省」曲线是系统性偏低。
    //
    // 修法就是补发这两个 hook，让它走与循环内完全相同的入账路径 —— 不另造一条统计口径
    //（本仓教训：仓库里已有的口径重实现一遍就是重踩一遍）。
    const summaryParams = {
      model: config.model,
      messages: ctxMgr.getMessages(),
      system: ctxMgr.getSystemPrompt(),
      maxTokens: config.maxTokens,
      // 不传 tools，禁止模型继续调工具（对齐 agentic-loop.ts 强制总结轮的做法）。
    };
    if (hookSystem) {
      try {
        // ⚠️ 刻意**不检查** blocking/stopExecution 返回值：这里已在收尾路径上，
        // 主循环该跑的都跑完了，此时"阻止"没有可阻止的对象；而按循环内那套 return 掉，
        // 会跳过下方 max_turns yield 与 emitTurnCompleteHere() —— 用一个观测点换掉两个收尾信号。
        await hookSystem.fireBeforeModelEvent(
          {
            model: summaryParams.model,
            messages: summaryParams.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            })),
            config: { maxTokens: summaryParams.maxTokens },
            raw_messages: summaryParams.messages,
            system: summaryParams.system,
            // tools 刻意不传：本轮真的没下发工具，传了就是让轨迹撒谎。
          },
          {
            // ⚠️ `turn_index` 必须是 maxTurns + 1 而不是复用 maxTurns。
            // 复用正是"一个 index 出现两次 first_content"的成因（实测 idx=40 有两条，
            // ttft 12803 与 23657），按 index 聚合 TTFT 的脚本会把两次不同调用叠在一格里，
            // 而 P1-1 那次 ttft 高达 23s 量级、恰好落在 P95/P99 的尾部。
            stream_snapshot_ref: { turn_index: state.turnCount + 1, loop_id: loopId },
          },
        );
      } catch {
        /* 观测点失败绝不阻断收尾 */
      }
    }
    try {
      // 与上面 stream_snapshot_ref 同一个口径：让 provider 侧 StreamPhase/HttpConnected
      // 也带 41，而不是继续沿用主循环最后登记的 40。
      setSseDumpContext(sessionState.sessionId, state.turnCount + 1, loopId);
    } catch {
      /* 快照定位失败绝不影响收尾 */
    }
    try {
      const summaryStream = deps.sendWithRetry(summaryParams, deps.getAbortSignal?.());
      const summaryResponse = await deps.processStream(summaryStream);
      // ─── §20.4：用量入账（在 hook 之前，与循环内同序）───
      // updateUsage 是 cost 的来源；不调它，这一轮的钱就只出现在网关账单上、不出现在我们账里。
      try {
        sessionState.updateUsage(
          config.model,
          summaryResponse.usage,
          0, // apiDuration：本轮没有 perfHandle，填 0 而不是猜一个值（宁可缺，不可假）
          summaryResponse.usageProvider ?? config.provider, // D5
          config.baseURL,
        );
      } catch {
        /* 入账失败不阻断收尾 */
      }
      if (hookSystem) {
        try {
          await hookSystem.fireAfterModelEvent(
            {
              model: summaryParams.model,
              messages: summaryParams.messages.map((m) => ({
                role: m.role,
                content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              })),
              raw_messages: summaryParams.messages,
              system: summaryParams.system,
            },
            {
              text: summaryResponse.content
                .filter((b) => b.type === "text")
                .map((b) => (b.type === "text" ? b.text : ""))
                .join(""),
              content_blocks: summaryResponse.content,
              stop_reason: summaryResponse.stopReason ?? undefined,
              usage: {
                inputTokens: summaryResponse.usage.inputTokens,
                outputTokens: summaryResponse.usage.outputTokens,
                cacheReadInputTokens: (summaryResponse.usage as any).cacheReadInputTokens,
                cacheCreationInputTokens: (summaryResponse.usage as any).cacheCreationInputTokens,
                reasoningTokens: (summaryResponse.usage as any).reasoningTokens,
              },
              cost_usd: sessionState.calculateCost(
                config.model,
                summaryResponse.usage,
                summaryResponse.usageProvider ?? config.provider,
                config.baseURL,
              ),
              // 与主循环同一单一事实源（见主循环 cacheSavingsUSD 处注释）：不传则 TokenMeter
              // 会退回自算，span 记 0、metric 记自算值 —— 又回到两套口径
              cache_savings_usd: sessionState.calculateSavings(
                config.model,
                summaryResponse.usage,
                summaryResponse.usageProvider ?? config.provider,
                config.baseURL,
              ),
              // 总结轮 index = turnCount + 1（与上方 setSseDumpContext 同口径）
              ttft_ms: takeFirstContentTtft(state.turnCount + 1),
              provider: summaryResponse.usageProvider ?? config.provider,
              base_url: config.baseURL,
              gateway_request_id: takeLastRequestId(),
            },
          );
        } catch {
          /* 观测点失败绝不阻断收尾 */
        }
      }
      if (summaryResponse.content.length > 0) {
        // P1-1 是"禁止调工具的总结轮"（sendWithRetry 未传 tools），但响应仍可能含
        // tool_use（mock 忽略 tools 参数 / 模型异常）。tool_use 在此轮无法执行（既不走
        // executeTools，也不在 while 循环内的发送前 finalizeMessagesForSend 兜底范围内），
        // 入历史会形成孤儿 → 下次发送 OpenAI 400。剥离 tool_use，只保留 text/reasoning
        // 等非工具块。这是产生端修复（对齐"孤儿来源应在产生端排查"原则）。
        const summaryContent = summaryResponse.content.filter((b) => b.type !== "tool_use");
        if (summaryContent.length < summaryResponse.content.length) {
          log.warn(
            "QUERY_LOOP",
            `P1-1：强制总结轮响应含 ${summaryResponse.content.length - summaryContent.length} 个 tool_use（本轮未传 tools，无法执行），已剥离以防孤儿 → 400`,
          );
        }
        if (summaryContent.length > 0) {
          const summaryMessage = { role: "assistant" as const, content: summaryContent };
          ctxMgr.addMessage(summaryMessage);
          yield { kind: "assistant_message", message: summaryMessage };
        }
      }
    } catch (err: any) {
      log.warn("QUERY_LOOP", `P1-1：强制总结轮失败（不影响收尾）: ${err?.message ?? String(err)}`);
      // §20.4：此前这里**只有**这一行 warn —— 本轮既不进 raw.jsonl 也不进 hook，
      // 于是"总结轮失败"在轨迹里几乎不可见（实测三题都成功了，所以它尚未造成误判，
      // 但那是运气，不是防线）。落 errors.jsonl 让它至少有一个可查的落点。
      // index 用 maxTurns + 1，与上方 stream_snapshot_ref / setSseDumpContext 同口径。
      deps.recordError?.({
        phase: "stream",
        index: state.maxTurns + 1,
        error: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack?.split("\n").slice(0, 5).join("\n"),
        context: { forcedSummaryRound: true, maxTurns: state.maxTurns },
      });
    }
  }

  // 达到最大轮次
  if (state.turnCount >= state.maxTurns) {
    // 归因必须与"上限"一起说出来：实测 7/10 题报 error_max_turns，其中两题的 40 格
    // 里有 7 格是被上游掉流杀在零产出上的（见 LoopState.turnsConsumedWithoutAssistant）。
    // 只打"达到最大轮次"会把人引向调大 --max-turns，而真凶在网关。
    const stolen = state.turnsConsumedWithoutAssistant;
    log.warn(
      "QUERY_LOOP",
      `达到最大轮次限制: ${state.maxTurns}` +
        (stolen > 0
          ? `（其中 ${stolen} 轮被超时/看门狗杀在零产出上，实际只发生了 ${state.maxTurns - stolen} 次模型交互）`
          : ""),
    );
    yield {
      kind: "max_turns",
      maxTurns: state.maxTurns,
      turnsConsumedWithoutAssistant: stolen,
    };
  }
  // P1-4：强制总结轮跑完后的补发点。上方 finally 对这条路径刻意让位（见那里的注释），
  // 否则端到端耗时会漏掉整个总结轮 —— 而它恰好只发生在最长的那些轮次上。
  // 幂等位保证：走到这里若 finally 已发过（例如总结轮判据在两处之间变了），不会重复。
  emitTurnCompleteHere();
  yield {
    kind: "done",
    turns: state.turnCount,
    // §20.5：与 max_turns 路径同源同口径，见 types.ts 该字段注释。
    turnsConsumedWithoutAssistant: state.turnsConsumedWithoutAssistant,
    // 停滞叫停不是「正常说完」：headless 据此不续等后台任务，SDK 映射 error_stalled
    ...(state.incompleteReason ? { incompleteReason: state.incompleteReason } : {}),
  };
}

// ─── F1 结构化事件 ───

/**
 * L2-C：F1 每次命中（重试或耗尽）落一条 `EmptyParamRetry`。
 *
 * 此前判定依据（命中哪个工具、是否截断、schema 有没有 required、压没压、为什么没压）
 * 只在 warn.log 一行文本里；而 warn.log 自 2026-10-21 起同类只首次告警，F1 的频次与形态
 * 会彻底失去统计口径。`compact_level` 记的是**决策依据**：`none` 解释了「为什么没压」。
 */
function emitEmptyParamRetry(
  deps: Pick<QueryDeps, "traceAppendEvent">,
  sessionId: string,
  args: {
    turn: number;
    stopReason: string | null | undefined;
    hits: EmptyParamHit[];
    getSchema: (name: string) => unknown;
    attempt: number;
    compacted: boolean;
    compactLevel?: string;
    exhausted?: boolean;
    agentId?: string;
  },
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "EmptyParamRetry",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data: buildEmptyParamRetryData({ ...args, maxAttempts: MAX_EMPTY_PARAM_RETRIES }),
    });
  } catch {
    /* 埋点失败不阻断主循环 */
  }
}

// ─── 停滞升级阶梯辅助 ───

/** settings.stallHardStop；读不到按 undefined（= 影子）。与 grep.ts respectGitignore 同取法。 */
function readStallHardStopSetting(): boolean | undefined {
  try {
    const { getSettings } = require("../config/settings/settings.ts");
    const v = getSettings().settings.stallHardStop;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从本工具轮提取停滞观测：成功落盘的文件内容、非只读 bash 后已登记文件的最新内容、bash 输出。
 * 读文件失败记 null（删除也是一种状态）。只读已登记 / 刚改过的文件，开销与改动量同阶。
 */
async function collectStallObservation(
  toolBlocks: any[],
  resultMap: Map<string, any>,
  trackedFiles: Iterable<string>,
): Promise<Omit<StallTurnObservation, "unchangedReports" | "oscillations">> {
  const { getCwd } = await import("../bootstrap/state.ts");
  const cwd = getCwd();
  const read = (p: string): string | null => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  };
  const abs = (p: string) => (isAbsolute(p) ? p : resolvePath(cwd, p));
  const mutatedFiles: StallTurnObservation["mutatedFiles"] = [];
  const bashOutputs: string[] = [];
  let ranMutatingBash = false;
  for (const b of toolBlocks) {
    if (b.type !== "tool_use") continue;
    const r = resultMap.get(b.id);
    const failed = !!(r && r.type === "tool_result" && r.is_error);
    if (FILE_MUTATING_TOOLS.has(b.name)) {
      if (failed) continue;
      for (const raw of [b.input?.file_path, b.input?.notebook_path]) {
        if (typeof raw === "string" && raw.trim()) {
          const p = abs(raw.trim());
          mutatedFiles.push({ path: p, content: read(p) });
        }
      }
    } else if (b.name === "bash") {
      const cmd = b.input?.command;
      if (typeof cmd === "string" && !isReadonlyProbeCommand(cmd)) ranMutatingBash = true;
      bashOutputs.push(
        r && r.type === "tool_result"
          ? typeof r.content === "string"
            ? r.content
            : JSON.stringify(r.content)
          : "",
      );
    }
  }
  // 非只读 bash（sed / git checkout / 生成器）可能改了 edit 账本里的文件：对已登记文件补算 hash，
  // 否则「用 bash 改回去」对 hash 判据是盲的。未登记的新文件仍是盲区（见 Agent Note）。
  const rehashedFiles = ranMutatingBash
    ? [...trackedFiles].map((p) => ({ path: p, content: read(p) }))
    : [];
  return { mutatedFiles, bashOutputs, rehashedFiles };
}

function emitStallEscalationEvent(
  deps: QueryDeps,
  sessionId: string,
  data: Record<string, unknown>,
): void {
  if (!deps.traceAppendEvent) return;
  try {
    deps.traceAppendEvent({
      event: "StallEscalation",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}

// ─── 辅助函数 ───

/** 循环恢复 */
async function recoverFromLoop(
  loopDetector: LoopDetector,
  ctxMgr: ContextManager,
  detail: string,
): Promise<boolean> {
  const log = getLogger();
  const canRecover = loopDetector.tryRecover();
  if (!canRecover) {
    // 恢复次数耗尽。按 recoveryExhaustedAction 决定：
    //  - continue（默认，保成功优先）：注入最终强提示 + 软重置检测器后**继续放行**，
    //    把"停不停"交给模型自己——避免一次循环误判废掉跑了几十轮的复杂长任务。
    //  - terminate（opt-in 回退旧行为）：补齐孤儿 tool_result 后终止任务。
    if (loopDetector.shouldContinueAfterExhausted()) {
      log.warn("QUERY_LOOP", "循环恢复次数耗尽，注入最终提示后继续放行（不终止任务）");
      // 仍需补齐未应答 tool_use 的占位 tool_result，与最终提示合并进同一条 user 消息，
      // 维持 tool_use/tool_result 协议配对 + user/assistant 角色交替（防孤儿 → OpenAI 400）。
      const orphanResults = buildPendingToolResults(
        ctxMgr.getMessages(),
        "[系统] 检测到非生产性循环，此工具调用未执行；这是最后提醒，请改换思路或如实告知用户。",
      );
      if (orphanResults.length > 0) {
        log.warn(
          "QUERY_LOOP",
          `耗尽后继续放行时补齐 ${orphanResults.length} 个未应答 tool_use 的占位 tool_result（防孤儿 → 400）`,
        );
      }
      ctxMgr.addMessage({
        role: "user",
        content: [...orphanResults, { type: "text", text: LOOP_RECOVERY_FINAL_PROMPT }],
      });
      // 软重置：清空各 detector 窗口 + 归零 recoveryAttempts（保留 turnCount），
      // 避免下一轮立刻又判耗尽刷屏；真死循环会重新累积并再次提示，但永不终止。
      loopDetector.softResetForContinue();
      return true;
    }

    log.warn("QUERY_LOOP", "循环恢复次数耗尽，终止循环");
    // 即使放弃恢复，也必须补齐未应答 tool_use 的占位 tool_result——
    // 否则孤儿残留在历史里，下一条用户消息发送时仍会 OpenAI 400。
    const pending = buildPendingToolResults(
      ctxMgr.getMessages(),
      "[系统] 循环恢复次数耗尽，此工具调用未执行。",
    );
    if (pending.length > 0) {
      ctxMgr.addMessage({ role: "user", content: pending });
      log.warn(
        "QUERY_LOOP",
        `放弃恢复前补齐 ${pending.length} 个未应答 tool_use 的占位 tool_result（防孤儿 → 400）`,
      );
    }
    return false;
  }

  const attempt = loopDetector.getRecoveryAttempts();
  const maxAttempts = loopDetector.getMaxRecoveryAttempts();
  log.info("QUERY_LOOP", `注入循环恢复提示 (${attempt}/${maxAttempts})，原因: ${detail}`);

  // 根因修复（系统级查漏补缺方案 第四条孤儿来源）：
  // 循环检测可能在 stopReason=tool_use 的轮次触发——此时 assistant 的 tool_use 已入历史，
  // 但 executeTools 被 continue 跳过，这些 tool_use 永远拿不到 tool_result → 孤儿 → OpenAI 400。
  // 这里把"未应答的 tool_use 补 error 占位 tool_result" + "恢复提示" 合并进**同一条 user 消息**，
  // 既维持 tool_use/tool_result 协议配对，又保持 user/assistant 角色交替。
  const orphanResults = buildPendingToolResults(
    ctxMgr.getMessages(),
    "[系统] 检测到非生产性循环，此工具调用未执行；请改换思路，不要重复等价调用。",
  );
  if (orphanResults.length > 0) {
    log.warn(
      "QUERY_LOOP",
      `循环恢复时补齐 ${orphanResults.length} 个未应答 tool_use 的占位 tool_result（防孤儿 → 400）`,
    );
  }

  // P1-3：按触发成因选文案。同参状态轮询要给「改用阻塞等待」，搜索类死循环要给
  // 「换工具/放宽匹配」——后者对轮询一条都不适用，给错建议等于没给，模型只会继续轮询。
  const recoveryPrompt =
    loopDetector.lastTrigger === "polling" ? LOOP_RECOVERY_POLLING_PROMPT : LOOP_RECOVERY_PROMPT;

  ctxMgr.addMessage({
    role: "user",
    content: [...orphanResults, { type: "text", text: recoveryPrompt }],
  });

  return true;
}

/**
 * 出队全部待投递的后台任务通知，合成一条 user 消息注入上下文并落盘。返回注入条数。
 *
 * 两个调用点：queryLoop 每轮开头（通知在轮中到达）、QueryEngine.resumeWithNotifications
 * （通知在主循环空闲后到达）。收口在这一个函数里，保证两条路径注入形状一致。
 *
 * 一次性合成「一条」user 消息，而非逐条 addMessage：逐条会触发 ctxMgr 的「连续同 role
 * 合并」——content 会连结，但 _meta 是浅合并，_meta.notif 会被后一条覆盖，TUI 结构化渲染
 * 只剩最后一条（回归）。content 每条一个 text 块（保留 XML 边界），_meta.notif 收集为数组。
 *
 * 落盘：此前通知只进内存不进 sessionStore，`-c` 恢复的会话里主代理"看过"的子代理结论
 * 凭空消失，后续回答失去依据。与 injectQueuedCommandsAsUserMessage 同样补上持久化。
 */
export function injectPendingNotifications(
  ctxMgr: ContextManager,
  sessionStore?: QueryDeps["sessionStore"],
): number {
  const notifications = dequeuePendingNotifications();
  if (notifications.length === 0) return 0;
  const message = {
    role: "user" as const,
    content: notifications.map((n) => ({ type: "text" as const, text: n.content })),
    // 多层防泄漏标记（对标 CC AttachmentMessage + isMeta + origin）：
    // 即使 addMessage 角色交替合并把 notification 追加到 tool_result 消息，
    // history-adapter 仍能通过 _meta.origin 快速识别并走折叠渲染路径。
    //
    // notif：结构化快照数组。TUI 侧优先遍历它渲染，不再对 content 文本做正则重解析——
    // 这样子代理结论里含 </result> / </task-notification> 字面量也不会破坏解析。
    _meta: {
      origin: "task-notification",
      isMeta: true,
      notif: notifications.map((n) => n.structured).filter(Boolean),
    },
  };
  ctxMgr.addMessage(message);
  // S3：这一刻通知才真正进了模型上下文——「已送达」从这里起算，而不是入队时。
  // 只在这里置位：两个调用点（轮中 / 空闲唤醒）都经过本函数。
  // B2：只认**终态**通知。shell 停滞检测给运行中任务发的「疑似等输入」通知也带 taskId，
  // 它送达不代表完成通知送达；registry 侧同样按任务 status 拦了一道（两道都留）。
  markNotificationsDelivered(
    notifications
      .filter((n) => n.structured && isTerminalStatus(n.structured.status))
      .map((n) => n.structured!.taskId),
  );
  try {
    sessionStore?.appendMessage(message);
  } catch {
    /* 持久化失败不阻断主循环 */
  }
  getLogger().info("QUERY_LOOP", `注入 ${notifications.length} 条后台任务通知`);
  return notifications.length;
}

/**
 * 缺口1 Phase B：把 drain 出的队列命令注入为一条 user 消息（mid-turn 抢占用）。
 *
 * 只处理 user-input 类命令（payload 为文本）；其余 kind（task-notification 等）在此不注入
 *（它们各有专门的回合边界注入路径，不应经 mid-turn now 通道插入）。
 * 多条聚合成「一条」user 消息、每条一个 text 块（与任务通知注入同策略，避免逐条 addMessage
 * 触发 ctxMgr 同 role 合并导致 _meta 覆盖）。返回实际注入的条数。
 *
 * 安全前提：调用点必须已保证消息序列无孤儿 tool_use（本轮 tool_result 已配对入历史），
 * 故此处直接 addMessage 一条 user 文本不会破坏配对（不变量 1）。
 */
function injectQueuedCommandsAsUserMessage(
  commands: QueuedCommand[],
  ctxMgr: ContextManager,
  deps: QueryDeps,
): number {
  const texts = commands
    .filter((c) => c.kind === "user-input" && typeof c.payload === "string" && c.payload.trim())
    .map((c) => c.payload as string);
  if (texts.length === 0) return 0;

  const content = texts.map((t) => ({ type: "text" as const, text: t }));
  ctxMgr.addMessage({ role: "user", content });
  try {
    deps.sessionStore?.appendMessage({ role: "user", content });
  } catch {
    /* 持久化失败不阻断主循环 */
  }
  return texts.length;
}

/** LLM 认知循环检测 */
async function runLLMLoopCheck(
  loopDetector: LoopDetector,
  loopConfig: QueryLoopConfig,
  ctxMgr: ContextManager,
): Promise<boolean> {
  const log = getLogger();
  log.info("QUERY_LOOP", "启动 LLM 认知循环检测");

  // timeoutId 在 try 内赋值、finally 内 clearTimeout，须在 try 外声明以保证 finally 可见。
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const messages = ctxMgr.getMessages();
    const recentMessages = messages.slice(-20);
    const prompt = loopDetector.buildLLMCheckPrompt(recentMessages);

    // 创建 30s 超时 AbortController（避免 sendWithRetry 的流式 for-await 永久阻塞）
    const existingSignal = loopConfig.deps.getAbortSignal();
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 30_000);

    // 如果已有 signal 被 abort，也 abort 新的 controller
    if (existingSignal) {
      existingSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const stream = loopConfig.deps.sendWithRetry(
      {
        model: loopConfig.config.model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        system: "你是一个对话模式分析器。只返回 JSON，不要其他内容。",
        maxTokens: 200,
      },
      controller.signal,
    );

    let resultText = "";
    for await (const event of stream) {
      // A8 纵深防御：认知检测 side-call 检查 signal
      if (controller.signal.aborted) {
        throw new Error("Request aborted");
      }
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        resultText += event.delta.text;
      }
    }

    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.debug("QUERY_LOOP", "LLM 认知检测返回非 JSON 格式，跳过");
      return false;
    }

    const result: LLMLoopCheckResult = JSON.parse(jsonMatch[0]);
    return loopDetector.processLLMResult(result);
  } catch (err: any) {
    log.warn("QUERY_LOOP", `LLM 认知检测失败: ${err.message}`);
    return false;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** 提取最后一条用户输入文本 */
function extractLastUserInput(ctxMgr: ContextManager): string {
  const messages = ctxMgr.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const textBlocks = msg.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        return textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      }
    }
  }
  return "";
}

/**
 * S6：prompt-too-long 时记录「已放行输入上限」，学到后**当场** `setMaxTokens`。
 *
 * 只写缓存不调 setMaxTokens 的话本会话阈值不变（`ctxMgr.maxTokens` 只在换模型 / 恢复 /
 * 引导时更新），「第二次撞墙之后同会话不再撞」必然失败。用户显式配置了 contextWindow 时
 * 不动——用户配置最高优先（与 resolveContextLimit 同口径）。全程 best-effort：
 * 学习失败绝不能影响随后的响应式压缩恢复。
 */
export function learnAdmittedCeilingOnOverflow(
  ctxMgr: Pick<ContextManager, "getLastActualInputTokens" | "getMaxTokens" | "setMaxTokens">,
  config: Pick<Config, "model" | "baseURL" | "availableModels">,
): void {
  const log = getLogger();
  try {
    const mc = config.availableModels?.find((m) => m.name === config.model);
    if (typeof mc?.contextWindow === "number" && mc.contextWindow > 0) return;
    const result = recordContextOverflow({
      model: config.model,
      baseURL: mc?.baseURL ?? config.baseURL,
      admittedTokens: ctxMgr.getLastActualInputTokens(),
    });
    if (result.status === "skipped") {
      log.debug("CONTEXT_LEARN", `S6：跳过窗口学习（${result.reason}）`);
      return;
    }
    if (result.status === "pending") {
      log.info("CONTEXT_LEARN", `S6：记录第 ${result.overflows} 次溢出，满 2 次才写入已放行上限`);
      return;
    }
    if (result.ceiling < ctxMgr.getMaxTokens()) {
      log.warn(
        "CONTEXT_LEARN",
        `S6：学到本路由已放行输入上限 ${result.ceiling}（第 ${result.overflows} 次溢出），` +
          `上下文窗口 ${ctxMgr.getMaxTokens()} → ${result.ceiling}，本会话即时生效`,
      );
      ctxMgr.setMaxTokens(result.ceiling);
    }
  } catch (e) {
    log.debug("CONTEXT_LEARN", `S6：窗口学习失败（忽略）: ${(e as Error)?.message}`);
  }
}

/**
 * S5：发请求前剥掉末尾的内部 ack（压缩重注入 / 摘要的固定确认语）。
 *
 * reactive 压缩成功后直接 continue 重试，历史以 `assistant(ack)` 收尾——Anthropic 族会把它
 * 当作**预填**发出，让模型以为那句话是自己已说出的前缀。只剥请求副本、不动历史：
 * 历史仍以 ack 收尾，下一条用户输入因此不会被合并进内部消息（见 ContextManager.addMessage）。
 * 只剥一条且只剥 assistant：剥完末尾若仍是 assistant 说明历史本身就以真实答复收尾，不该再动。
 */
export function stripTrailingInternalAck<T extends Message>(messages: T[]): T[] {
  const last = messages[messages.length - 1];
  if (messages.length > 1 && last?.role === "assistant" && hasInternalOrigin(last)) {
    return messages.slice(0, -1);
  }
  return messages;
}
