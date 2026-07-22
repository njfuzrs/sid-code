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
import type { SendParams } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import type { HookSystem } from "../hook/system.ts";
import type { QuotaManager } from "../llm/quota.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import type { BudgetTracker } from "../telemetry/metrics/budget-tracker.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { resolveToolSearchEnabled } from "../tool/tool-search-auto.ts";
import { TOKEN_THRESHOLDS } from "../context/auto-compact.ts";
import { ModelFallback } from "../llm/fallback.ts";
import { isAwaitingHumanInput } from "./human-input-gate.ts";
import { setSseDumpContext } from "../llm/sse-chunk-dumper.ts";
import { resolveLoopTimeouts, computeBackoffMs } from "../config/network-profile.ts";
import { emitTimeoutFired, emitTimeoutRetry, emitTimeoutRetryExhausted, armIneffectiveCheck, emitWatchdogKill, getStreamSnapshot, clearStreamSnapshot, clearAllSnapshots } from "../trace/stream-observer.ts";
import { SessionState } from "../session/state.ts";
import { getLogger, getSessionMetrics, getPerfTimer } from "../debug/index.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT, LOOP_RECOVERY_FINAL_PROMPT } from "../agent/loop-detection.ts";
import type { LLMLoopCheckResult } from "../agent/loop-detection.ts";
import {
  checkMessageHistoryIntegrity,
  finalizeMessagesForSend,
} from "../agent/message-invariants.ts";
import { isAbortError, isInternalTimeoutAbortReason, RequestAbortedError } from "../llm/errors.ts";
import {
  resolveEffortCapability,
  resolveAppliedEffort,
  resolveThinking,
  getEffortEnvOverride,
  getThinkingEnvOverride,
} from "../llm/effort.ts";
import { isPromptTooLongError, reactiveCompact, DiminishingReturnsDetector } from "./reactive-compact.ts";
import {
  parseTokenBudgetDirective,
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
import { runCompactPipeline } from "./compact/index.ts";
import {
  MAX_EMPTY_PARAM_RETRIES,
  detectEmptyParamToolUses,
  replaceEmptyParamToolUses,
  buildEmptyParamRetryMessage,
} from "./empty-param.ts";
import {
  TODO_REMINDER_CONFIG,
  MAX_TODO_GATE_RETRIES,
  MAX_UNANSWERED_RETRIES,
  buildTodoReminder,
  buildTodoGateMessage,
  buildTodoGateExhaustedMessage,
  buildUnansweredEndTurnMessage,
  countUnfinished,
} from "./todo-reminder.ts";
import {
  PROGRESS_REMINDER_INTERVAL,
  snapshotFromTodos,
  persistProgress,
  buildProgressReminder,
} from "./work-log.ts";
import { dequeuePendingNotifications, evictTerminalTasks } from "../task/index.ts";
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
import { decideNagInjection, MAX_NO_PROGRESS_NAGS } from "./reminder-throttle.ts";
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
import { detectInvestigationContext, buildHypothesisGuideReminder } from "./hypothesis-guide.ts";
import { collectDiagnosticText, getLSPHealthWarning } from "../lsp/manager.ts";
import { buildPermissionModeReminder, PERMISSION_MODE_REMINDER_INTERVAL } from "./permission-reminder.ts";
import { buildContradictionReminder, buildDeliveryGateReminder } from "./hypothesis-ledger.ts";
import { buildGoalReminder } from "../goal/reminder.ts";
import { collectEvidenceFromTurn } from "../goal/evidence-collector.ts";
import { handleGoalGate } from "./goal-gate.ts";
import { BlockedDetector } from "../goal/blocked-detector.ts";
import { DEFAULT_GOAL_CONFIG } from "../goal/config.ts";
import {
  checkResponseForCacheBreak,
  recordPromptState,
  recordCacheBreak,
  formatCacheBreakReport,
  notifyCompaction,
} from "../api/cache-detection.ts";
import { getEffectiveBetaHeaders } from "../api/beta-header-latch.ts";
import type {
  QueryLoopYield,
  QueryDeps,
  LoopState,
} from "./types.ts";
import { createInitialLoopState } from "./types.ts";
import { setTransition } from "./transition.ts";
import { lookupRegistry } from "../llm/model-registry.ts";

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
  deps: QueryDeps;
}

/**
 * 核心执行循环 — async generator
 *
 * 每次 yield 一个 QueryLoopYield 事件给上层消费。
 * 上层通过 for await...of 消费，天然支持背压。
 */
export async function* queryLoop(
  loopConfig: QueryLoopConfig,
): AsyncGenerator<QueryLoopYield> {
  const log = getLogger();
  const {
    config,
    ctxMgr,
    toolRegistry,
    sessionState,
    hookSystem,
    thinking,
    deps,
  } = loopConfig;

  const loopDetector = new LoopDetector();
  const state: LoopState = createInitialLoopState(config.maxTurns || Infinity);
  const diminishingDetector = new DiminishingReturnsDetector();
  // P0-3：Token Budget 续写——解析本条用户消息里的 "+500k" 类预算指令（一次性，
  // 随每条新用户消息的新 state 天然重置，见 LoopState.tokenBudgetTarget 注释）。
  // 命中则记录目标值与当前累计 usage 基线；复用 DiminishingReturnsDetector 判断
  // "产出是否递减"，但续写次数上限调宽到 1000——真正的停止条件是预算耗尽，不是
  // 次数（见 token-budget-continuation.ts 顶部注释）。
  const parsedTokenBudget = parseTokenBudgetDirective(extractLastUserInput(ctxMgr));
  if (parsedTokenBudget !== undefined) {
    state.tokenBudgetTarget = parsedTokenBudget;
    const baseline = sessionState.getTotalUsage();
    state.tokenBudgetBaselineUsage =
      baseline.inputTokens + baseline.outputTokens + (baseline.cacheCreationInputTokens ?? 0);
    log.info("QUERY_LOOP", `P0-3：检测到 Token Budget 指令，目标 ${parsedTokenBudget.toLocaleString()} tokens`);
  }
  const budgetDiminishingDetector = new DiminishingReturnsDetector({ maxRecoveryCount: 1000, diminishingThreshold: 500 });
  // Fix 1：每次 queryLoop 生成唯一 loopId，用于 snapshot namespace 隔离
  const loopId = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // /goal：合并用户 config.goal 与内置默认值（用户未配则全走默认）
  const effectiveGoalConfig = { ...DEFAULT_GOAL_CONFIG, ...config.goal };
  // /goal：卡住检测器（基于评估者返回的 blockerKey 精确匹配）
  const goalBlockedDetector = new BlockedDetector(
    effectiveGoalConfig.blockedThreshold,
  );

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
    const deferredDefinitions = toolRegistry
      .definitions()
      .filter((d) => !activeNames.has(d.name));
    return resolveToolSearchEnabled(config.toolSearch, {
      model: config.model,
      availableModels: config.availableModels,
      deferredDefinitions,
    });
  })();

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
  try {
  while (state.turnCount < state.maxTurns) {
    state.turnCount++;
    loopDetector.recordTurn();

    // ─── 后台任务完成通知回注（对标 claude-code <task-notification> 投递）───
    // 根因修复：后台子代理（run_in_background=true）完成后 completeAgentTask/failAgentTask
    // 把 <task-notification> 塞进 pendingQueue，但真实主循环 queryLoop 此前从不出队，
    // 导致"完成后会通知你"成为虚假承诺。这里在每轮开头出队并作为 user 消息注入，
    // 让主代理被动收到后台子代理的结构化结果/失败信息。
    const notifications = dequeuePendingNotifications();
    if (notifications.length > 0) {
      // 一次性把所有通知合成「一条」user 消息注入，而非逐条 addMessage。
      // 原因：逐条 addMessage 会触发 ctxMgr 的「连续同 role 合并」——content 会连结，
      // 但 _meta 是浅合并，_meta.notif 会被后一条覆盖，导致 TUI 结构化渲染只剩最后一条、
      // 前面的通知从面板消失（回归）。这里主动聚合：content 每条一个 text 块（保留 XML
      // 边界，LLM 侧语义不变），_meta.notif 收集为**数组**（TUI 侧遍历渲染，不丢任何一条）。
      ctxMgr.addMessage({
        role: "user",
        content: notifications.map(n => ({ type: "text" as const, text: n.content })),
        // 多层防泄漏标记（对标 CC AttachmentMessage + isMeta + origin）：
        // 即使 addMessage 角色交替合并把 notification 追加到 tool_result 消息，
        // history-adapter 仍能通过 _meta.origin 快速识别并走折叠渲染路径。
        //
        // notif：结构化快照数组。TUI 侧优先遍历它渲染，不再对 content 文本做正则重解析——
        // 这样子代理结论里含 </result> / </task-notification> 字面量也不会破坏解析
        // （根治「点4」：删掉需要转义的解析路径，而非给脆弱的转义往返打补丁）。
        // 注入 LLM 的仍是 content 里的完整 XML 文本，语义不变、字面量原样保留。
        _meta: {
          origin: "task-notification",
          isMeta: true,
          notif: notifications.map(n => n.structured).filter(Boolean),
        },
      });
      log.info("QUERY_LOOP", `注入 ${notifications.length} 条后台任务通知`);
    }

    // 通知注入后驱逐已完成且已通知的后台任务：其完成信息已进对话，面板条目即属冗余。
    // 不在此清除则「后台任务 · N 已完成」会永久驻留（evictTerminalTasks 此前从未被调用）。
    // 通知队列独立于任务注册表，驱逐不会丢失任何通知。
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

    log.info("QUERY_LOOP", `轮次 ${state.turnCount}/${state.maxTurns}，消息数 ${ctxMgr.getMessages().length}，上下文 ${usagePercent.toFixed(0)}%`);

    // ─── 分级压缩策略 ───
    // 优先使用新的四层阈值（context/auto-compact.ts），再回退到现有三层逻辑
    const remainingTokens = contextMax - currentTokens;
    const newLevel = (() => {
      if (remainingTokens <= TOKEN_THRESHOLDS.blocking) return "blocking";
      if (remainingTokens <= TOKEN_THRESHOLDS.autoCompact) return "autoCompact";
      return null;
    })();

    const compactionLevel = ctxMgr.getCompactionLevel(toolCount);

    // blocking：强制截断（不调用 LLM）
    if (newLevel === "blocking") {
      log.warn("QUERY_LOOP", `上下文阻塞 (剩余 ${remainingTokens} tokens)，强制截断`);
      const msgCountBefore = ctxMgr.messageCount();
      ctxMgr.emergencyTruncate();
      ctxMgr.addCompactBoundary(`阻塞级压缩：剩余 ${remainingTokens} tokens`, msgCountBefore);
      ctxMgr.releaseBeforeBoundary();
      state.goalReminderPendingAfterCompact = true;
      state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
    } else {
      switch (compactionLevel) {
      case "emergency":
        log.warn("QUERY_LOOP", `上下文紧急 (${usagePercent.toFixed(0)}%)，强制截断`);
        {
          const msgCountBefore = ctxMgr.messageCount();
          ctxMgr.emergencyTruncate();
          ctxMgr.addCompactBoundary(`紧急压缩：使用率 ${usagePercent.toFixed(0)}%`, msgCountBefore);
        }
        state.goalReminderPendingAfterCompact = true;
        state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
        break;
      case "hard": {
        log.warn("QUERY_LOOP", `上下文接近上限 (${usagePercent.toFixed(0)}%)，启动渐进式压缩管道`);
        const msgCountBefore = ctxMgr.messageCount();
        const pipelineResult = runCompactPipeline(ctxMgr.getMessages(), {
          currentUsageRatio: usagePercent / 100,
          maxTokens: contextMax,
          toolCount,
        });

        if (pipelineResult.steps.length > 0) {
          ctxMgr.setMessages(pipelineResult.messages);
          log.info("QUERY_LOOP", `渐进式压缩: ${pipelineResult.steps.join(" → ")}，节省 ${pipelineResult.totalSavedChars} 字符`);
          yield { kind: "system", level: "info", text: `渐进式压缩: ${pipelineResult.steps.join(" → ")}` };
        }

        if (pipelineResult.needsAutoCompact) {
          // §2.2：autoCompact 前先尝试 Context Collapse（分段摘要老消息，中等成本）。
          // collapse 成功（usage 降到目标）→ 跳过昂贵的全量 autoCompact；不够 → 继续 autoCompact。
          let collapsed = false;
          if (deps.contextCollapse) {
            try {
              const ratioAfterPipeline = ctxMgr.estimateTokens(toolCount) / contextMax;
              collapsed = await deps.contextCollapse(ratioAfterPipeline);
              if (collapsed) {
                log.info("QUERY_LOOP", "Context Collapse 成功，跳过 autoCompact");
                yield { kind: "system", level: "info", text: "上下文分段压缩完成" };
              }
            } catch (err: any) {
              log.warn("QUERY_LOOP", `Context Collapse 异常，回退 autoCompact: ${err.message}`);
              // 优化 1：collapse 失败被吞、静默回退 autoCompact——engine 层看不到。记 post_stream。
              deps.recordError?.({
                phase: "post_stream",
                index: state.turnCount,
                error: (err as Error)?.message ?? String(err),
                stack: (err as Error)?.stack?.split("\n").slice(0, 5).join("\n"),
                context: { kind: "context_collapse_failed", willRetry: false, fallback: "autoCompact" },
              });
            }
          }
          if (!collapsed) {
            log.warn("QUERY_LOOP", "轻量压缩不足，触发 LLM 摘要压缩");
            const outcome = await deps.autoCompact();
            // 静默-9：LLM 摘要失败/熔断降级为简单截断时（有损，丢弃老消息），
            // 原来无声无息——用户观感是"上下文突然失忆"却无提示。这里 yield warning 显式告知。
            if (outcome === "truncated") {
              yield {
                kind: "system",
                level: "warning",
                text: "上下文摘要压缩失败，已降级为简单截断（丢弃部分历史消息）。若后续回答缺失上下文，请重述关键信息。",
              };
            }
          }
        }

        ctxMgr.addCompactBoundary(`渐进式压缩: ${pipelineResult.steps.join(" → ")}`, msgCountBefore);
        ctxMgr.releaseBeforeBoundary();
        state.goalReminderPendingAfterCompact = true;
        state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
        break;
      }
      case "soft":
        // soft 档本身不在此执行任何压缩动作：工具输出遮罩与剪枝统一在发送前的
        // getCleanedMessages()（见本文件下方 cleanedMessages = ctxMgr.getCleanedMessages()）
        // 里应用。此处仅记录进入了 soft 档，便于排查——不要误以为这里执行了压缩。
        log.info("QUERY_LOOP", `上下文 ${usagePercent.toFixed(0)}%，进入 soft 档（遮罩/剪枝将在发送前 getCleanedMessages 统一应用）`);
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
            .map(o => `${o.name}(id=${o.id} @msg#${o.messageIndex})`)
            .join(", ");
          log.error(
            "QUERY_LOOP",
            `发送前孤儿兜底关卡触发：补齐 ${backfill.backfilled.length} 个孤儿 tool_use 的占位 tool_result（已修复，避免 OpenAI 400）：${detail}。` +
              `孤儿来源应在产生端排查（循环恢复/中断/followup/plan-mode）。`,
          );
        }
        if (backfill.stripped.length > 0) {
          const detail = backfill.stripped
            .map(d => `tool_use_id=${d.toolUseId} @msg#${d.messageIndex}`)
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

    const cleanedMessages = ctxMgr.getCleanedMessages();
    // 工具延迟加载开启时，首轮只发非延迟工具（activeDefinitions），延迟工具由模型经
    // tool_search 按需激活后才进上下文；关闭时发全量（definitions），行为与历史一致。
    const toolDefs =
      toolCount > 0
        ? toolSearchEnabled
          ? toolRegistry.activeDefinitions()
          : toolRegistry.definitions()
        : undefined;
    log.llmRequest(config.provider, config.model, cleanedMessages.length, toolDefs?.length ?? 0, config.maxTokens);

    // ─── System Reminder 注入（对标 Claude Code 每轮注入）───
    // 注意: getCleanedMessages 返回浅拷贝数组，消息对象仍是 ctxMgr 引用。
    // 这里不对 cleanedMessages 做 in-place 修改，而是构建新的 messages 数组。
    let finalMessages = cleanedMessages;

    // 收集本轮要注入的 system-reminder 片段（plan 提醒 + todo 回注）
    const reminderParts: string[] = [];

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
        const changed = state.lastSeenContextPressureLevel !== level;
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
      state.lastSeenContextPressureLevel = level;
    }

    // 缺口 C：permission mode 每轮可见（覆盖 plan 之外的所有 mode 切换）。
    // 根因：mode 指南只进被 5 分钟缓存冻结的 system prompt，运行时切 acceptEdits /
    // readonly / dontAsk 等不刷新，模型上下文里仍是会话启动时的旧 mode。
    // plan mode 另有 getPlanModeReminder 每轮注入兜住，故这里跳过 plan 避免重复。
    // delta 策略：mode 与上轮不同的那一轮强注入（防时机缺失）；非 default mode 持续时
    // 每 N 轮低频重述一次（防遗忘）。default mode 不注入（无额外约束）。
    if (deps.getCurrentPermissionMode) {
      const mode = deps.getCurrentPermissionMode();
      if (mode && mode !== "default" && mode !== "plan") {
        const changed = state.lastSeenPermissionMode !== mode;
        const turnsSinceMode = state.turnCount - (state.lastPermissionModeReminderTurn ?? 0);
        if (changed || turnsSinceMode >= PERMISSION_MODE_REMINDER_INTERVAL) {
          const modeReminder = buildPermissionModeReminder(mode, changed);
          if (modeReminder) {
            reminderParts.push(modeReminder);
            state.lastPermissionModeReminderTurn = state.turnCount;
          }
        }
      }
      // 无论是否注入，都刷新"上轮 mode"基线（含切回 default 的情况，下次再切走能识别为 changed）
      state.lastSeenPermissionMode = mode;
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
    // collectDiagnosticText 内部已做严重度过滤（仅 Error/Warning 注入）+ 跨轮次去重
    // （已投递的诊断不重复注入），故这里直接 push 即可，无需额外节流。
    // LSP 未配置 / 未就绪 / 无诊断时返回 null，不注入、不报错（降级正常）。
    //
    // 能力对齐门控：仅当具备 edit/write 工具时才注入诊断——诊断是给"能改代码的 agent"看的。
    // 这比 CC 的"有 Bash 才注入"更贴合本意（本项目靠 edit/write 修诊断、不依赖 bash）；
    // 纯只读会话不会被诊断噪音打扰。
    {
      const hasEditCapability = !!(toolRegistry.get("edit") || toolRegistry.get("write"));
      const diagnosticText = hasEditCapability ? collectDiagnosticText() : null;
      if (diagnosticText) {
        reminderParts.push(
          `# LSP 诊断（来自语言服务器的实时反馈）\n\n${diagnosticText}\n\n` +
            `以上是语言服务器对你刚编辑文件的实时分析结果。请关注其中的 Error / Warning，` +
            `在后续工作中修复这些问题；若与当前任务无关可暂不处理，但不要无视真实的类型/语法错误。`,
        );
        log.info("QUERY_LOOP", "G1：注入 LSP 诊断反馈");
      }
    }

    // P0-2：todo 每隔 N 轮回注完整清单（对标 claude-code attachments.ts）。
    // 根因 1 修复——todo 写完即沉没、只喂 TUI、从不回注 LLM，弱模型靠工作记忆追踪必然遗漏。
    // 触发条件：有未完成项 + (距上次 todo_write ≥ TURNS_SINCE_WRITE 轮，或距上次回注 ≥ TURNS_BETWEEN_REMINDERS 轮)。
    if (deps.getTodoState) {
      const todoState = deps.getTodoState();
      if (todoState && todoState.todos.length > 0 && countUnfinished(todoState.todos) > 0) {
        // P2-2：todo 状态变化（writeVersion 变化）即把进度快照落盘到 ~/.sid-code/progress/<sessionId>.md，
        // 形成抗压缩、抗清理、可跨会话的外部记忆（CLAUDE.md §0.1 Context 层）。
        if (state.lastSeenTodoWriteVersion !== todoState.writeVersion) {
          const snap = snapshotFromTodos(sessionState.sessionId, todoState.todos);
          persistProgress(snap);
        }

        // writeVersion 变化 → 模型刚更新过清单，刷新基线、本轮不重复回注
        if (state.lastSeenTodoWriteVersion !== todoState.writeVersion) {
          state.lastSeenTodoWriteVersion = todoState.writeVersion;
          state.lastTodoReminderTurn = state.turnCount;
          state.todoReminderPendingAfterCompact = false;
          // 对话重播幻觉修复（Fix 2/3）：writeVersion 变化 = 模型确实更新了清单 = 有进展。
          // 清零"无进展催促"计数（恢复注入能力），并刷新 end_turn todo gate 预算——
          // 同一条用户消息内模型完成部分项后，gate 不该继续消耗上一段停滞攒下的续命额度。
          state.noProgressNagCount = 0;
          state.todoGateRetryCount = 0;
        } else {
          const turnsSinceReminder = state.turnCount - (state.lastTodoReminderTurn ?? 0);
          // 压缩后强制回注（与 goalReminderPendingAfterCompact 同机制）
          const afterCompact = state.todoReminderPendingAfterCompact === true;
          const shouldInjectTodo = turnsSinceReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
            || afterCompact;
          if (shouldInjectTodo) {
            // 去重 + 封顶（对话重播幻觉修复 Fix 1/2）：与上次注入内容逐字节相同（无进展）
            // 或连续催促已达上限时跳过——避免把"内容近似、无新用户指令"的提醒反复注入成
            // 幻影用户消息，正是弱模型误判"消息被截断/上一轮重播"的根因。
            // 例外：compact 后强制回注（afterCompact）必须绕过去重 + 封顶——历史被压缩后，
            // 模型上下文里的 todo 清单已丢失，必须恢复一次，否则任务列表永久消失（违背
            // todoReminderPendingAfterCompact 的设计意图）；且不计入封顶（真实上下文事件，非无进展催促）。
            const candidate = buildTodoReminder(todoState.todos);
            const decision = afterCompact
              ? { inject: true, countedAsNoProgress: false }
              : decideNagInjection({
                  candidate,
                  lastInjectedText: state.lastInjectedTodoReminderText,
                  noProgressNagCount: state.noProgressNagCount ?? 0,
                });
            if (decision.inject) {
              reminderParts.push(candidate);
              state.lastTodoReminderTurn = state.turnCount;
              state.todoReminderPendingAfterCompact = false;
              state.lastInjectedTodoReminderText = candidate;
              // 本轮 writeVersion 未变化（进入 else 分支即代表无进展），计入封顶计数
              if (decision.countedAsNoProgress) {
                state.noProgressNagCount = (state.noProgressNagCount ?? 0) + 1;
              }
              log.info("QUERY_LOOP", `P0-2：回注 todo 清单（${countUnfinished(todoState.todos)} 项未完成，无进展催促 ${state.noProgressNagCount}/${MAX_NO_PROGRESS_NAGS}）`);
            } else {
              // 仍推进 cadence，避免下一轮立刻又算"到期"反复重算
              state.lastTodoReminderTurn = state.turnCount;
              state.todoReminderPendingAfterCompact = false;
            }
          }
        }

        // P2-2：每隔 PROGRESS_REMINDER_INTERVAL 轮额外回注一次"工作日志摘要"，
        // 强调持久进度 + 别重复已完成项（与 P0-2 的 todo 原文回注互补）。
        const turnsSinceProgress = state.turnCount - (state.lastProgressReminderTurn ?? 0);
        if (turnsSinceProgress >= PROGRESS_REMINDER_INTERVAL) {
          const snap = snapshotFromTodos(sessionState.sessionId, todoState.todos);
          const progressReminder = buildProgressReminder(snap);
          // 去重 + 封顶（对话重播幻觉修复 Fix 1/2）：与 todo 回注同机制。P2-2 摘要在
          // todo 长期停滞时内容几乎逐字节相同（idx 41/87/112 就是这样的三连重复），
          // 是造"幻影用户消息"的重灾区，必须去重 + 封顶。
          const decision = decideNagInjection({
            candidate: progressReminder,
            lastInjectedText: state.lastInjectedProgressReminderText,
            noProgressNagCount: state.noProgressNagCount ?? 0,
          });
          if (decision.inject && progressReminder) {
            reminderParts.push(progressReminder);
            state.lastProgressReminderTurn = state.turnCount;
            state.lastInjectedProgressReminderText = progressReminder;
            if (decision.countedAsNoProgress) {
              state.noProgressNagCount = (state.noProgressNagCount ?? 0) + 1;
            }
            log.info("QUERY_LOOP", `P2-2：回注工作日志摘要（已完成 ${snap.completed.length} / 待办 ${snap.pending.length}，无进展催促 ${state.noProgressNagCount}/${MAX_NO_PROGRESS_NAGS}）`);
          } else {
            // 跳过注入仍推进 cadence，避免每轮重算
            state.lastProgressReminderTurn = state.turnCount;
          }
        }
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
    if (state.turnCount === 1 && !state.hypothesisGuideInjected) {
      const userText = extractLastUserInput(ctxMgr);
      if (detectInvestigationContext(userText)) {
        reminderParts.push(buildHypothesisGuideReminder());
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
                turn: state.turnCount,
                userTextPreview: userText.slice(0, 200),
              },
            });
          } catch { /* trace 写入失败不阻断 */ }
        }
      }
    }

    // 环节③ 机制2（矛盾中断·注入端）：上一轮检出的矛盾命中，本轮注入高优先级提醒，
    // 逼模型停下来用 hypothesis_challenge 裁决。放在 reminderParts 最前（unshift），
    // 让它在所有提醒里最先被读到——抗沉没成本的关键时刻不能被淹没。
    if (state.pendingContradictions && state.pendingContradictions.length > 0) {
      reminderParts.unshift(buildContradictionReminder(state.pendingContradictions));
      log.info(
        "QUERY_LOOP",
        `注入矛盾中断提醒（${state.pendingContradictions.length} 条假设待裁决）`,
      );
      state.pendingContradictions = undefined; // 注入后清空，避免重复
    }

    // 方向 2/4/6（git-status 快照冻结死循环止损阀·注入端）：上一轮检出"卡在只读命令上"，
    // 本轮经 reminderParts 注入携带实时 git 状态的收敛提醒。放在最前（unshift），确保模型
    // 在被冻结快照带偏前先读到实时事实。走 reminder 通道（仅本轮注入、不落历史、缓存友好），
    // 与 pendingContradictions 同机制，注入后清空避免重复。
    if (state.pendingStuckReminder) {
      reminderParts.unshift(state.pendingStuckReminder);
      log.info("QUERY_LOOP", "注入无进展止损收敛提醒（实时 git 状态）");
      state.pendingStuckReminder = undefined;
    }

    // 方案③（思考发散·注入端）：上一轮检出的思考发散，本轮经 reminder 通道注入收敛提示。
    // 放在 unshift 高优先级——分析瘫痪时越早读到越好。注入后清空 pending 标记。
    if (state.pendingThinkingDivergenceReminder) {
      reminderParts.unshift(buildThinkingDivergenceMessage(state.thinkingLenHistory ?? []));
      log.info("QUERY_LOOP", "方案③：注入思考发散收敛提示");
      state.pendingThinkingDivergenceReminder = false;
    }

    // P2-1（产出量停滞·注入端）：上一轮检出连续低产出，本轮经 reminder 通道注入软提醒。
    // 优先级低于思考发散（push 而非 unshift）——分析瘫痪比"可能卡住"更紧急。注入后清空 pending 标记。
    if (state.pendingOutputStallReminder) {
      reminderParts.push(buildOutputStallMessage(state.outputVolumeHistory ?? []));
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
      if (shouldRemindSoftTurnLimit(state.turnCount, softLimit, state.softTurnLimitReminded ?? false)) {
        reminderParts.push(buildSoftTurnLimitReminder(state.turnCount, softLimit!));
        state.softTurnLimitReminded = true;
        log.info("QUERY_LOOP", `第四层：注入 SID_MAX_TURNS 软阈值提醒（第 ${state.turnCount} 轮，阈值 ${softLimit}）`);
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
        deps.updateGoalState?.(g => { g.turnsUsed = goal.turnsUsed; g.updatedAt = goal.updatedAt; });

        // 按间隔回注（首轮必注入，之后每 N 轮，compact 后强制注入）
        const turnsSinceGoalReminder = state.turnCount - (state.lastGoalReminderTurn ?? 0);
        const shouldInject = goal.turnsUsed === 1
          || turnsSinceGoalReminder >= effectiveGoalConfig.reminderInterval
          || state.goalReminderPendingAfterCompact;
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
        reminderParts.push(
          `# MCP Server Instructions\n\n` +
            `以下 MCP 服务器提供了使用说明，请在使用对应工具时遵循这些指令：\n\n` +
            mcpBlocks.join("\n\n"),
        );
        log.info("QUERY_LOOP", `注入 ${mcpBlocks.length} 个 MCP server instructions`);
      }
    }

    if (reminderParts.length > 0) {
      // 注入逻辑抽到 reminder-inject.ts（纯函数，便于单测）。
      // 关键：纯 tool_result 轮（plan 探索高频场景）无 text block 时会追加 text block，
      // 不再放弃注入——修复了工具轮漏注入 reminder 的回归。
      finalMessages = injectReminders(finalMessages, reminderParts);
    }

    // 工具延迟加载：每轮注入 <available-deferred-tools> 提醒，告诉模型有哪些工具
    // 尚未加载、可经 tool_search 调出。不注入则模型对延迟工具完全无感知，
    // 整个延迟机制形同虚设（对标 claude-code claude.ts deferredToolList 注入）。
    // 单独处理（不进 reminderParts）：它每轮都注、非节流，且内容独立成块。
    if (toolSearchEnabled) {
      const deferredNames = toolRegistry.deferredToolNames();
      if (deferredNames.length > 0) {
        finalMessages = injectReminders(finalMessages, [
          `<available-deferred-tools>\n${deferredNames.join("\n")}\n</available-deferred-tools>\n` +
            `以上工具尚未加载到上下文。需要时用 tool_search 工具按名称（select:<工具名>，多个用逗号分隔）` +
            `或关键词调出，激活后即可在后续轮次正常调用。`,
        ]);
      }
    }

    const sendParams: SendParams = {
      model: config.model,
      messages: finalMessages,
      system: ctxMgr.getSystemPrompt(),
      maxTokens: state.maxOutputTokensOverride ?? config.maxTokens,
      tools: toolDefs,
    };

    // ─── Effort / Thinking 旋钮 → 各 provider 线格式（能力感知映射层，effort.ts）───
    // 每轮取最新运行时态（照搬 getCurrentPermissionMode 模式，保证 /effort、/think 切换当轮生效）。
    // 未注入 getter 时回退旧逻辑（thinking hint 直接写 SendParams），保证向后兼容。
    if (deps.getEffortSetting || deps.getThinkingSetting) {
      const modelConfig = config.availableModels?.find(m => m.name === config.model);
      const cap = resolveEffortCapability({
        model: config.model,
        provider: config.provider,
        baseURL: modelConfig?.baseURL ?? config.baseURL,
        modelConfig: modelConfig ? { supportsThinking: modelConfig.supportsThinking } : undefined,
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

      cap.applyToSendParams(sendParams, appliedEffort, appliedThinking);
    } else {
      // ── 向后兼容回退：无旋钮 getter 时，沿用 engine 透传的 thinking hint ──
      // - Anthropic provider 读 params.thinking.budgetTokens 开启 Extended Thinking；
      // - DeepSeek（OpenAI 兼容）按预算档位映射 reasoningEffort（50K→max，其余→high）。
      if (thinking) sendParams.thinking = thinking;
      if (thinking?.enabled) {
        sendParams.reasoningEffort = (thinking.budgetTokens >= 50_000 ? "max" : "high") as "high" | "max";
      }
    }

    // ─── BeforeModel hook ───
    if (hookSystem) {
      const beforeModelResult = await hookSystem.fireBeforeModelEvent({
        model: sendParams.model,
        messages: sendParams.messages.map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })),
        config: { maxTokens: sendParams.maxTokens },
        raw_messages: sendParams.messages,
        system: sendParams.system,
        tools: sendParams.tools,
      });
      if (beforeModelResult.finalOutput?.isBlockingDecision()) {
        log.info("HOOK", `BeforeModel hook 阻止 LLM 请求: ${beforeModelResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "done", turns: state.turnCount };
        return;
      }
      if (beforeModelResult.finalOutput?.shouldStopExecution()) {
        log.info("HOOK", `BeforeModel hook 停止执行: ${beforeModelResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "done", turns: state.turnCount };
        return;
      }
    }

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
      try { turnAbortController.abort(parentSignal.reason); } catch { /* ignore */ }
    }
    // 级联：父 signal 与子 signal 任一 abort，composedSignal 即 abort（reason 取先触发者）。
    // 传给底层 fetch/SDK 的用这个复合 signal，既响应用户级取消，也响应 turn 级自我中断。
    const composedSignal: AbortSignal = parentSignal
      ? AbortSignal.any([parentSignal, turnAbortController.signal])
      : turnAbortController.signal;
    // turn 级主动中断上游（超时/看门狗/清理）—— 只 abort 本轮子 controller，不碰会话级。
    const abortThisTurn = (reason: string) => {
      try { turnAbortController.abort(reason); } catch { /* ignore */ }
    };

    // ─── G2：cachedMicrocompact — 缓存友好压缩产出 cache_edits ───
    // 每轮发送前，对当前消息执行供应商感知的"缓存友好 microcompact"：
    // - Anthropic + 缓存温热 → 不改消息内容（保持前缀字节一致 → cache hit），产出 cache_edits
    // - Anthropic + 缓存已冷 → direct-clear：缓存反正已过期要整段重写，趁重写前先清老工具结果，
    //   缩小被重写的量并释放本地 token（对标 CC time-based microcompact 的核心洞察）
    // - 其它 provider → 由上方 getProviderName 门控挡在外，走 autoCompact pipeline 处理
    // 产出的 pendingCacheEdits 注入 sendParams.cacheEdits，由 anthropic.ts 携带到请求体。
    try {
      const microState = deps.getCachedMicrocompactState?.();
      if (microState && deps.getProviderName?.() === "anthropic") {
        const { cachedMicrocompact } = await import("./compact/cached-microcompact.ts");
        // 缓存冷热判定：距上一轮响应超过 5min ephemeral TTL 即视为已冷。
        // 首轮（lastResponseAt 未设）视为冷——无前缀可保，direct-clear 无损失。
        // 此前硬编码 cacheWarm:true 让 direct-clear 分支永不触发，CC 的"冷时清理"洞察被架空。
        const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
        const cacheWarm = state.lastResponseAt != null
          && (Date.now() - state.lastResponseAt) < PROMPT_CACHE_TTL_MS;
        const result = cachedMicrocompact(sendParams.messages, {
          providerName: "anthropic",
          cacheWarm,
          state: microState,
          emitCacheEdits: !process.env.SID_DISABLE_CACHE_EDITS,
        });
        if (result.path === "cache-preserving") {
          if (result.pendingCacheEdits && result.pendingCacheEdits.edits.length > 0) {
            sendParams.cacheEdits = result.pendingCacheEdits.edits;
            log.debug("CACHE_EDITS", `注入 ${sendParams.cacheEdits.length} 条 cache_edits`);
            // G1：cache_edits 删除后下次 cache_read 可能下降——通知检测器抑制
            const { notifyCacheDeletion } = await import("../api/cache-detection.ts");
            notifyCacheDeletion(sendParams.cacheEdits.length, "main");
          }
        } else if (result.compactedCount > 0) {
          // direct-clear（缓存已冷）：改写后的消息必须回灌，否则清理无效（本地 token 不释放）。
          // 前缀已因缓存过期失效，改写不额外损失命中；notifyCompaction 抑制这轮预期的 cache_read 下降。
          sendParams.messages = result.messages;
          finalMessages = result.messages;
          notifyCompaction("main");
          log.debug(
            "CACHE_EDITS",
            `缓存已冷 direct-clear：清理 ${result.compactedCount} 项工具结果，释放 ${result.savedChars} 字符`,
          );
        }
      }
    } catch (err: any) {
      log.debug("CACHE_EDITS", `cachedMicrocompact 失败（非阻断）: ${err?.message?.slice(0, 100)}`);
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
    } catch { /* 快照失败绝不影响主循环 */ }

    try {
      // 5.2：登记当前会话 id + 轮次 + loopId，供 provider 的 SSE 逐 chunk 采样落盘定位
      //（默认关闭，SID_CODE_DEBUG_SSE_DUMP=1 才真正落盘）。
      // Fix 1：loopId 传入 ambientCtx，使 emitStreamPhase 写入的快照带有正确的 namespace。
      setSseDumpContext(sessionState.sessionId, state.turnCount, loopId);
      stream = deps.sendWithRetry(sendParams, composedSignal);
    } catch (err: any) {
      // 优化 1：连接阶段异常落 errors.jsonl。此 catch 的所有处理路径都是降级重试
      //（prompt-too-long 响应式压缩 continue / 上下文溢出调 maxTokens 或 autoCompact continue），
      // 异常被吞不会冒泡到 engine 层——此前排查只见"重试后成功"，看不到最初为何失败。
      deps.recordError?.({
        phase: "connection",
        index: state.turnCount,
        error: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack?.split("\n").slice(0, 5).join("\n"),
        context: {
          willRetry: true,
          promptTooLong: isPromptTooLongError(err),
          attemptedReactiveCompact: state.hasAttemptedReactiveCompact,
        },
      });
      // prompt-too-long 错误扣留：自动触发响应式压缩重试
      if (isPromptTooLongError(err) && !state.hasAttemptedReactiveCompact) {
        log.warn("QUERY_LOOP", "检测到 prompt-too-long 错误，触发响应式压缩");
        const compactResult = reactiveCompact(ctxMgr);
        if (compactResult.success) {
          // P0-2：one-shot 标志位，只在此成功路径置真；不得在任何 continue 分支重置为
          // false（见 types.ts LoopState.hasAttemptedReactiveCompact 注释的 CC 教训）。
          state.hasAttemptedReactiveCompact = true;
          setTransition(state, { type: "reactive_compact" }, deps, sessionState.sessionId);
          notifyCompaction("main"); // G1：抑制紧接的 cache break 检测
          state.goalReminderPendingAfterCompact = true;
          state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
          yield { kind: "system", level: "info", text: `响应式压缩: ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条消息` };
          continue; // 重试
        }
        log.warn("QUERY_LOOP", "响应式压缩失败，尝试 maxTokens 调整");
      }

      const adjusted = deps.handleContextOverflow(err, sendParams.maxTokens);
      if (adjusted !== null) {
        log.info("QUERY_LOOP", `上下文溢出，自动调整 maxTokens: ${sendParams.maxTokens} → ${adjusted}`);
        sendParams.maxTokens = adjusted;
        stream = deps.sendWithRetry(sendParams, composedSignal);
      } else {
        log.warn("QUERY_LOOP", "上下文溢出且无法调整 maxTokens，触发自动压缩");
        notifyCompaction("main"); // G1：抑制紧接的 cache break 检测
        await deps.autoCompact();
        state.goalReminderPendingAfterCompact = true;
        state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
        setTransition(state, { type: "context_overflow_retry" }, deps, sessionState.sessionId);
        continue;
      }
    }

    // ─── 处理流式响应 ───
    const perfHandle = getPerfTimer().start(`llm_request_${state.turnCount}`);
    let ttftMs: number | undefined;
    const ttftStart = performance.now();

    let response: import("../llm/types.ts").AccumulatedResponse;
    // 网络超时体系统一由 resolveLoopTimeouts 解析（单套保活优先默认值，可经
    // settings.json network.* 或 SID_CODE_* 环境变量覆盖），详见
    // src/config/network-profile.ts 的优先级链说明。声明在 try 之外，
    // 使下方 catch 块（超时重试分支）也能读到同一份解析结果。
    const netTimeouts = resolveLoopTimeouts({ network: config.network });
    try {
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
      let humanInputPausedAt: number | null = null;  // 当前等待段起点（null=未在等待）
      let humanInputPauseAccumMs = 0;                 // 已结束的等待段累计总时长
      const turnStartedAt = Date.now();

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
      const turnTimeoutPromise = new Promise<never>((_resolve, reject) => {
        turnTimer = setInterval(() => {
          try {
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
            // 非等待业务耗时 = 墙钟总耗时 - 累计等待时长。达阈值才判硬超时。
            const businessElapsedMs = Date.now() - turnStartedAt - humanInputPauseAccumMs;
            if (businessElapsedMs < MAX_TURN_DURATION_MS) return;

            log.error("QUERY_LOOP", `单轮硬超时 ${MAX_TURN_DURATION_MS / 1000}s（已扣除 ${(humanInputPauseAccumMs / 1000).toFixed(0)}s 等待），强制让出控制权`);
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
            ) as (() => void);
            // 尽力而为：主动 abort 上游 fetch（即便对已 hang 的 reader 无效也无害）。
            // Fix 3 根治：只 abort 本轮子 controller，不碰会话级 signal。
            abortThisTurn("turn-timeout");
            reject(new Error(`单轮硬超时：${MAX_TURN_DURATION_MS / 1000}s 无完成`));
          } catch { /* 周期检查自身异常不外泄，等下个 tick */ }
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
      // 人机输入闸门配套状态（humanInputPausedAt / humanInputPauseAccumMs）已提升到 turn_hard
      // 之前定义，turn_hard 与 watchdog 共享同一套（H6）：两个 setInterval 都在单线程事件循环内
      // 跑，先跑的那个 tick 负责「结束等待→累计→置 null」，后跑的看到 null 即跳过，天然不会重复
      // 累计；共享还保证两条防线对「已扣除多少等待」看法一致，不会一个扣了另一个没扣而口径打架。
      const watchdogPromise = new Promise<never>((_resolve, reject) => {
        watchdogTimer = setInterval(() => {
          try {
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
            const snapshot = getStreamSnapshot(state.turnCount);
            // Fix 6（隐患 4）：快照缺失 = 还在等首字节，用 headerTimeoutMs（+10s 余量）
            // 而非固定 90s 阈值兜底——否则 DeepSeek 大上下文请求（首字节需 90-120s 属正常）
            // 会被看门狗抢先于 header timeout 之前误杀，浪费一次本可正常返回的重试机会。
            // 快照存在（已收到首字节）时仍用 WATCHDOG_NO_PROGRESS_MS 判定无进展。
            const effectiveThresholdMs = snapshot
              ? WATCHDOG_NO_PROGRESS_MS
              : netTimeouts.headerTimeoutMs + WATCHDOG_HEADER_GRACE_MS;
            // 快照存在用 lastContentProgressAt；缺失则退化为 watchdog 启动时间兜底。
            const lastProgressAt = snapshot?.lastContentProgressAt ?? watchdogStartedAt;
            // 扣除累计的用户等待时段，避免弹窗答完后残留的等待时长把无进展判超。
            const noProgressMs = Date.now() - lastProgressAt - humanInputPauseAccumMs;
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
            });
            // 尽力而为：主动 abort 上游 fetch（即便对已 hang 的 reader 无效也无害）。
            // Fix 3 根治：只 abort 本轮子 controller，不碰会话级 signal。
            abortThisTurn("watchdog-timeout");
            // reject 带 "timeout" 字样 → 下方 catch 命中 isTimeoutError → 复用超时重试分支。
            reject(new Error(`看门狗超时：${(effectiveThresholdMs / 1000).toFixed(0)}s 无业务进展`));
          } catch { /* 看门狗自身异常绝不影响主流程 */ }
        }, WATCHDOG_CHECK_INTERVAL_MS);
        // 同 turnTimer：不 unref——它是关键防线，宁可保持进程活跃直到 finally 清理。
      });

      // Fix 3：settled flag — 防止 race settle 后看门狗/超时 interval 冗余 abort（隐患 7）
      let raceSettled = false;

      try {
        response = await Promise.race([
          deps.processStream(stream, (_text) => {
            if (ttftMs === undefined) {
              ttftMs = performance.now() - ttftStart;
            }
            // 流式文本通过 QueryEngine 层的 onStreamText 回调桥接
          }, undefined,
          // Fix 3（同类路径根治）：把本轮 turn 级 controller 透传进 stream-processor，
          // 让其心跳/整体超时只 abort turn 级（经 composedSignal 级联中断上游 fetch），
          // 不再污染会话级共享 signal。
          turnAbortController),
          turnTimeoutPromise,
          watchdogPromise,
        ]);
        // onThinking 通过 QueryEngine 层的 streamThinkingCallback 桥接，queryLoop 自身无需处理
      } finally {
        raceSettled = true;
        if (turnTimer !== null) clearInterval(turnTimer);  // H6：turn_hard 已改为 setInterval 周期检查
        if (watchdogTimer !== null) clearInterval(watchdogTimer);
        // race 已 settle（正常返回或 catch 到 reject）→ disarm，证明超时确实生效。
        // 断言读取：disarm 仅在闭包内赋值，TS 线性流会把变量窄化成 null，故显式转型。
        (disarmTurnIneffective as (() => void) | null)?.();

        // Fix 3：主动终止 stream generator，防止孤儿继续在后台发请求写入 _snapshots
        if (stream && typeof (stream as any).return === "function") {
          try {
            (stream as AsyncGenerator).return(undefined);
          } catch { /* 忽略已终止的 generator 的错误 */ }
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
          setTransition(state, { type: "timeout_retry" }, deps, sessionState.sessionId);
          log.warn("QUERY_LOOP", `流式超时，重试 ${timeoutRetryCount + 1}/${maxRetries}`);
          // 缺口 4：记录超时重试事件
          emitTimeoutRetry({
            index: state.turnCount,
            attempt: timeoutRetryCount + 1,
            max: maxRetries,
            elapsed_ms: netTimeouts.maxTurnDurationMs,
            model: config.model,
          });
          // 指数退避 + jitter，避免零延迟重试恶化网关排队
          const backoffMs = computeBackoffMs(timeoutRetryCount, netTimeouts.retryBackoffBaseMs, netTimeouts.retryBackoffMaxMs);
          // TUI 去重：不再 yield system 文本打进消息流，改上报 RetryStatus 通道（带实时倒计时），
          // 与 fallback 引擎的 onRetry/onFallback 共用同一个组件，避免消息流出现重复提示行。
          deps.reportRetryStatus?.({
            kind: "retry",
            attempt: timeoutRetryCount + 1,
            delayMs: backoffMs,
            model: config.model,
            error: "请求超时",
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          // Fix 2：重试前清除本轮旧快照，防止看门狗读到上次失败的脏 lastContentProgressAt 立即误杀
          clearStreamSnapshot(state.turnCount);
          continue;
        }
        // 缺口 4：记录超时重试耗尽事件
        emitTimeoutRetryExhausted({
          index: state.turnCount,
          attempts: maxRetries,
          model: config.model,
        });
        log.error("QUERY_LOOP", `流式超时重试耗尽`);

        // 重试耗尽：yield 用户可见的错误提示，含配置逃生通道
        yield {
          kind: "system",
          level: "error",
          text: `⚠️ 模型请求超时（已重试 ${maxRetries} 次），本轮对话中断。\n`
            + `当前无进展超时阈值: ${netTimeouts.watchdogNoProgressMs / 1000}s，首字节超时: ${netTimeouts.headerTimeoutMs / 1000}s\n`
            + `可在 ~/.sid-code/settings.json 的 network.watchdogNoProgressMs / network.headerTimeoutMs 放宽，`
            + `或设置环境变量 SID_CODE_WATCHDOG_NO_PROGRESS_MS / SID_CODE_RESPONSE_HEADER_TIMEOUT_MS 覆盖。\n`
            + `请重新发送消息继续。`,
        };
        // 优雅退出：yield done 让 TUI 正确切换回"等待输入"状态
        yield { kind: "done", turns: state.turnCount };
        return;
      }

      // 流式阶段的 prompt-too-long 错误恢复（与连接阶段逻辑一致）
      if (isPromptTooLongError(err) && !state.hasAttemptedReactiveCompact) {
        log.warn("QUERY_LOOP", "流式阶段检测到 prompt-too-long 错误，触发响应式压缩");
        const compactResult = reactiveCompact(ctxMgr);
        if (compactResult.success) {
          // P0-2：one-shot 标志位，只在此成功路径置真；不得在任何 continue 分支重置为
          // false（见 types.ts LoopState.hasAttemptedReactiveCompact 注释的 CC 教训）。
          state.hasAttemptedReactiveCompact = true;
          setTransition(state, { type: "reactive_compact" }, deps, sessionState.sessionId);
          notifyCompaction("main"); // G1：抑制紧接的 cache break 检测
          state.goalReminderPendingAfterCompact = true;
          state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
          yield { kind: "system", level: "info", text: `响应式压缩: ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条消息` };
          continue;
        }
        log.warn("QUERY_LOOP", "响应式压缩失败，尝试 autoCompact");
      }

      // prompt-too-long 兜底：autoCompact 后重试
      if (isPromptTooLongError(err)) {
        notifyCompaction("main"); // G1：抑制紧接的 cache break 检测
        await deps.autoCompact();
        state.goalReminderPendingAfterCompact = true;
        state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
        setTransition(state, { type: "context_overflow_retry" }, deps, sessionState.sessionId);
        continue;
      }

      // P0-2：未识别的错误一律重新抛出，绝不吞掉后继续走到下面的 response 处理逻辑。
      // 本 catch 块的每条路径要么 continue（重试）、要么 yield done 后 return（重试耗尽，
      // 见上面的超时分支）、要么在此 throw——没有任何路径会"降级"出一个假的 response
      // 对象混进正常流程，这正是下面 isEndTurnLike 白名单判断天然不会被 API 错误触发的
      // 另一半保证。
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
    // 记录本轮成功响应时刻，供下一轮 cached-microcompact 判定缓存冷热（超 5min TTL 视为已冷）。
    state.lastResponseAt = Date.now();

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
          const cancelResults = pendingToolUses.map(b => ({
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
        yield { kind: "done", turns: state.turnCount };
        return;
      }
    }

    // ─── 更新用量统计 ───
    // config.baseURL 是 resolveCurrentModelConfig 回填的当前模型端点，传入使计费按
    // (model, endpoint) 复合键精确匹配——同名不同渠道（如 ali-/tx-/origin- 前缀）各自计价。
    sessionState.updateUsage(config.model, response.usage, apiDuration, config.provider, config.baseURL);
    const thisCost = sessionState.calculateCost(config.model, response.usage, config.provider, config.baseURL);

    // ─── P1-6/P1-7：用真实 usage 校准上下文估算器 ───
    // 把 provider 原始 usage 归一化为完整 prompt（promptTotal，与厂商无关），
    // 喂给 ctxMgr 作校准锚点：收敛估算偏差 + 防止 compact 因启发式低估而触发过晚。
    try {
      const norm = normalizeCacheUsage(response.usage, config.provider);
      ctxMgr.recordActualTokens(norm.promptTotal, toolRegistry.size());
    } catch { /* 校准失败绝不影响主循环 */ }

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
    } catch { /* 中断检测失败绝不影响主循环 */ }

    const cacheSavingsUSD = loopConfig.tokenMeter
      ? loopConfig.tokenMeter.calculateCacheSavings(config.model, response.usage)
      : 0;

    if (loopConfig.quotaManager) {
      loopConfig.quotaManager.recordRequest(
        response.usage.inputTokens + response.usage.outputTokens,
      );
    }

    // ─── 预算追踪器检查 ───
    if (loopConfig.budgetTracker) {
      const budgetAlert = loopConfig.budgetTracker.recordCost(thisCost, {
        model: config.model,
      });
      if (budgetAlert) {
        if (budgetAlert.level === "exceeded" && budgetAlert.action === "block") {
          yield {
            kind: "system",
            level: "warning",
            terminal: true,
            text: `预算规则 "${budgetAlert.ruleName}" 已超限（$${budgetAlert.currentUSD.toFixed(4)} / $${budgetAlert.limitUSD.toFixed(2)}），自动停止`,
          };
          yield { kind: "done", turns: state.turnCount };
          return;
        } else if (budgetAlert.level === "critical" || budgetAlert.level === "warning") {
          const pct = (budgetAlert.percentage * 100).toFixed(0);
          yield {
            kind: "system",
            level: "warning",
            text: `预算规则 "${budgetAlert.ruleName}" 已达 ${pct}%（$${budgetAlert.currentUSD.toFixed(4)} / $${budgetAlert.limitUSD.toFixed(2)}）`,
          };
        }
      }
    }

    // ─── 成本配额检查 ───
    if (loopConfig.quotaManager) {
      // 纳入辅助调用花费（标题/记忆/分类/摘要/预热等），避免影子调用烧钱不受限。
      const quotaResult = loopConfig.quotaManager.check(sessionState.getEffectiveTotalCostUSD());
      if (quotaResult) {
        if (quotaResult.level === "exceeded") {
          yield { kind: "system", level: "warning", terminal: true, text: quotaResult.message };
          yield { kind: "done", turns: state.turnCount };
          return;
        } else if (quotaResult.level === "critical" || quotaResult.level === "warning") {
          yield { kind: "system", level: "warning", text: quotaResult.message };
        }
      }
    }

    log.llmResponse(response.stopReason || "unknown", response.usage, apiDuration, sessionState.totalCostUSD);

    // ─── P2（9bc92c2c）：processStream 成功返回后立即记录原始 AfterModel 事件 ───
    // 确保即使后续 content 解析/hook 触发崩溃，events.jsonl 中也有 AfterModel 痕迹，
    // 消除"有 BeforeModel 无 AfterModel"的诊断盲区。
    try {
      getSessionMetrics()?.incrementCounter("after_model_raw", 1);
      log.info("QUERY_LOOP", `AfterModelRaw: stop=${response.stopReason}, in=${response.usage.inputTokens} out=${response.usage.outputTokens}, blocks=${response.content.length}`);
    } catch { /* 纯观测，不影响主循环 */ }

    // ─── 提取响应文本 ───
    const responseText = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");
    if (responseText) {
      log.llmResponseText(responseText);
    }

    // ─── AfterModel hook ───
    if (hookSystem) {
      const afterModelResult = await hookSystem.fireAfterModelEvent(
        {
          model: sendParams.model,
          messages: sendParams.messages.map(m => ({
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
          ttft_ms: ttftMs,
          provider: config.provider,  // T12.3：Provider 维度标记
          base_url: config.baseURL,   // 端点维度：区分同模型不同渠道，便于排查 + 重算精确计费
        },
      );
      if (afterModelResult.finalOutput?.isBlockingDecision()) {
        log.info("HOOK", `AfterModel hook 阻止响应: ${afterModelResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "done", turns: state.turnCount };
        return;
      }
      if (afterModelResult.finalOutput?.shouldStopExecution()) {
        log.info("HOOK", `AfterModel hook 停止执行: ${afterModelResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "done", turns: state.turnCount };
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
    //      ③最多重试 MAX_EMPTY_PARAM_RETRIES 次，耗尽后放行（替换后的 content 已无 tool_use，
    //        会正常走 end_turn 结束，并如实呈现退化，不假装完成）。
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
        yield { kind: "assistant_message", message: { role: "assistant", content: sanitizedContent } };

        // 重试前压缩上下文，打击大上下文根因（消息足够多才有意义）
        const compactResult = reactiveCompact(ctxMgr);
        if (compactResult.success) {
          log.info(
            "QUERY_LOOP",
            `F1：空参数重试前压缩上下文 ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条`,
          );
          state.goalReminderPendingAfterCompact = true;
          state.todoReminderPendingAfterCompact = true;
        yield { kind: "compact" };
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
        setTransition(state, { type: "empty_param_retry" }, deps, sessionState.sessionId);
        continue;
      }

      // 重试耗尽：替换后入历史并放行（sanitizedContent 已无 tool_use，会正常走 end_turn 结束）
      log.error(
        "QUERY_LOOP",
        `F1：空参数重试已达上限 ${MAX_EMPTY_PARAM_RETRIES}，工具「${names}」仍参数为空，放行并如实呈现退化`,
      );
      ctxMgr.addMessage({
        role: "assistant",
        content: sanitizedContent,
        ...(response._meta ? { _meta: response._meta } : {}),
      });
      yield { kind: "assistant_message", message: { role: "assistant", content: sanitizedContent } };
      yield {
        kind: "system",
        level: "warning",
        text: `工具调用参数持续为空（已重试 ${MAX_EMPTY_PARAM_RETRIES} 次），模型在当前上下文下无法正常生成工具参数，停止重试。`,
      };
      yield { kind: "done", turns: state.turnCount };
      return;
    }

    // ─── 添加助手消息到历史 ───
    ctxMgr.addMessage({
      role: "assistant",
      content: response.content,
      ...(response._meta ? { _meta: response._meta } : {}),
    });

    yield { kind: "assistant_message", message: { role: "assistant", content: response.content } };

    // ─── 内容循环检测 ───
    if (responseText && loopDetector.recordContent(responseText)) {
      const recovered = await recoverFromLoop(loopDetector, ctxMgr, "内容重复模式");
      if (!recovered) {
        yield { kind: "done", turns: state.turnCount };
        return;
      }
      yield { kind: "loop_detected", detail: "内容重复模式" };
      yield { kind: "loop_recovery", attempt: loopDetector.getRecoveryAttempts(), maxAttempts: loopDetector.getMaxRecoveryAttempts() };
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
    // F2 fall-through 标记：仅 end_turn/stop 且含（非空）tool_use 时为真。
    // 限定 stopReason 避免影响 max_tokens 续写 / content_filter 等其他分支的既有语义。
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
    const isEndTurnLike =
      response.stopReason === "end_turn" ||
      response.stopReason === "stop" ||
      response.stopReason === "stop_sequence";
    const f2FallThrough = isEndTurnLike && hasPendingToolUse;
    if (f2FallThrough) {
      // §2.4：stop_reason 与 content 不一致——声称 end_turn/stop 却仍含 tool_use。
      // 功能上 F2 fall-through 已能正确执行工具（不漏调），这里只补一条结构化 warn
      // 遥测（不改控制流），把"被动兜住"升级为"主动暴露"：便于按 model 聚合发现
      // 哪家第三方代理有此协议偏差（maximhq/bifrost #3638）。
      log.warn(
        "QUERY_LOOP",
        "stop_reason 与 content 不一致：声称 end_turn/stop 但含 tool_use（疑似代理协议偏差，已自动兜底执行工具）",
        {
          stopReason: response.stopReason,
          toolUseCount: response.content.filter((b) => b.type === "tool_use").length,
          model: sendParams.model,
        },
      );
    }
    if (isEndTurnLike && !hasPendingToolUse) {
      // AfterAgent hook
      if (hookSystem) {
        const userInput = extractLastUserInput(ctxMgr);
        const afterResult = await hookSystem.fireAfterAgentEvent(userInput, responseText);
        if (afterResult.finalOutput?.shouldClearContext()) {
          log.info("HOOK", "AfterAgent hook 请求清除上下文");
          ctxMgr.clear();
        }
      }

      // ─── Stop Hooks 自动修复循环 ───
      if (hookSystem) {
        const { handleStopHooks } = await import("./stop-hooks.ts");
        const stopHookGen = handleStopHooks(hookSystem, ctxMgr, responseText, state.stopHookRetryCount ?? 0);
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

        if (stopResult?.forceStop) {
          log.info("QUERY_LOOP", "Stop Hook preventContinuation，强制结束");
        }
      }

      // ─── 方案②：「未答复的 end_turn」兜底（不依赖 todo，deepseek-reasoning-leak 修复）───
      // stream-processor 判定本轮思考漂移进正文 / 只思考不答复（response._unansweredEndTurn）时，
      // 无论有没有 todo，都回注一次收敛提示并软续命——这是例③"重试无反应"的机制级破局点：
      // 完成度校验/重试链原本全以 todo 存在为前提，模型不建 todo 就彻底失效。
      // 放在 todo gate 之前，因为它不依赖 todo，且要在"假性完成"最早处拦下、驱动模型换策略。
      if ((response as any)._unansweredEndTurn === true) {
        const retries = state.unansweredRetryCount ?? 0;
        if (retries < MAX_UNANSWERED_RETRIES) {
          state.unansweredRetryCount = retries + 1;
          ctxMgr.addMessage({
            role: "user",
            content: [{ type: "text", text: buildUnansweredEndTurnMessage() }],
          });
          log.warn(
            "QUERY_LOOP",
            `方案②：检测到未答复的 end_turn（思考漂移/只思考不答复），回注收敛提示并软续命 ${state.unansweredRetryCount}/${MAX_UNANSWERED_RETRIES}`,
          );
          yield {
            kind: "system",
            level: "warning",
            text: `上一轮未产出有效答复（疑似思考泄漏到正文），自动引导重新推进 (${state.unansweredRetryCount}/${MAX_UNANSWERED_RETRIES})`,
          };
          setTransition(state, { type: "unanswered_retry" }, deps, sessionState.sessionId);
          continue;
        }
        // 续命耗尽：放行，但如实告知用户模型未能正常答复（不假装完成）
        log.warn(
          "QUERY_LOOP",
          `方案②：未答复续命已达上限 ${MAX_UNANSWERED_RETRIES}，放行但如实呈现`,
        );
        yield {
          kind: "system",
          level: "warning",
          text: `模型连续 ${MAX_UNANSWERED_RETRIES} 次未产出有效答复（可能陷入思考发散）。建议换个更具体的提问方式，或切换模型重试。`,
        };
      }

      // ─── P0-3：end_turn 完成度硬校验（对标 claude-code stopHooks.ts）───
      // 根因 1、2 修复——模型常"做了一半就 end_turn"。这里在收尾前查 todo：
      // 仍有 pending/in_progress 项 → 注入提醒并软续命（最多 MAX_TODO_GATE_RETRIES 次），
      // 把"人肉完成度校验器"内置进 harness。续命耗尽后放行，但如实列出未完成项，不假装完成。
      if (deps.getTodoState) {
        const todoState = deps.getTodoState();
        const unfinished = todoState ? countUnfinished(todoState.todos) : 0;
        if (todoState && unfinished > 0) {
          const retries = state.todoGateRetryCount ?? 0;
          if (retries < MAX_TODO_GATE_RETRIES) {
            state.todoGateRetryCount = retries + 1;
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: buildTodoGateMessage(todoState.todos) }],
            });
            log.info(
              "QUERY_LOOP",
              `P0-3：end_turn 拦截——仍有 ${unfinished} 项未完成，软续命 ${state.todoGateRetryCount}/${MAX_TODO_GATE_RETRIES}`,
            );
            yield {
              kind: "system",
              level: "info",
              // P2-1：中性措辞，避免"检测到…未完成"的报错感——这是正常的完成度兜底推进，非错误。
              text: `清单还有 ${unfinished} 项待完成，继续推进 (${state.todoGateRetryCount}/${MAX_TODO_GATE_RETRIES})`,
            };
            setTransition(state, { type: "todo_gate_retry" }, deps, sessionState.sessionId);
            continue;
          }
          // 续命耗尽：放行但如实呈现未完成项
          log.warn(
            "QUERY_LOOP",
            `P0-3：完成度续命已达上限 ${MAX_TODO_GATE_RETRIES}，放行但仍有 ${unfinished} 项未完成`,
          );
          yield {
            kind: "system",
            level: "warning",
            text: buildTodoGateExhaustedMessage(todoState.todos),
          };
        }
      }

      // 环节③ 机制3（交付门禁）：模型试图收尾，但假设登记表里仍有未确认（open）假设时，
      // 注入门禁提醒并软续命——逼它先把假设结清（去验证→confirm，或 refute/降级），
      // 而不是把未证实的假设当结论交付。这是 fdb47f30 那类"把猜测写成根因"的最后一道闸。
      // 续命有限次：模型确实无法定论时放行，但门禁提醒已要求它在交付物里如实降级。
      if (deps.getHypothesisLedger) {
        const ledger = deps.getHypothesisLedger();
        if (ledger && ledger.hasOpen()) {
          const retries = state.hypothesisGateRetryCount ?? 0;
          const MAX_HYPOTHESIS_GATE_RETRIES = 2;
          if (retries < MAX_HYPOTHESIS_GATE_RETRIES) {
            state.hypothesisGateRetryCount = retries + 1;
            const unsettled = ledger.unsettled();
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: buildDeliveryGateReminder(unsettled) }],
            });
            log.info(
              "QUERY_LOOP",
              `环节③ 交付门禁拦截——仍有 ${unsettled.length} 条假设未确认，软续命 ${state.hypothesisGateRetryCount}/${MAX_HYPOTHESIS_GATE_RETRIES}`,
            );
            yield {
              kind: "system",
              level: "info",
              text: `检测到 ${unsettled.length} 条假设未结清，请先裁决再收尾 (${state.hypothesisGateRetryCount}/${MAX_HYPOTHESIS_GATE_RETRIES})`,
            };
            setTransition(state, { type: "hypothesis_gate_retry" }, deps, sessionState.sessionId);
            continue;
          }
          log.warn(
            "QUERY_LOOP",
            `环节③ 交付门禁续命已达上限 ${MAX_HYPOTHESIS_GATE_RETRIES}，放行（模型应已在交付物中如实降级未确认假设）`,
          );
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
          const consumed =
            currentUsage.inputTokens + currentUsage.outputTokens + (currentUsage.cacheCreationInputTokens ?? 0) -
            (state.tokenBudgetBaselineUsage ?? 0);
          const remaining = state.tokenBudgetTarget - consumed;

          if (remaining <= 0) {
            log.info("QUERY_LOOP", `P0-3：预算已用完（目标 ${state.tokenBudgetTarget}），正常收尾`);
            yield { kind: "system", level: "info", text: buildBudgetExhaustedNotice(state.tokenBudgetTarget) };
            // 落入下方正常收尾
          } else {
            budgetDiminishingDetector.record(response.usage.outputTokens);
            if (budgetDiminishingDetector.shouldStop()) {
              log.info("QUERY_LOOP", `P0-3：产出递减收益，提前收尾（预算剩余约 ${remaining}）`);
              yield { kind: "system", level: "info", text: buildBudgetDiminishingNotice(remaining) };
              // 落入下方正常收尾
            } else {
              state.tokenBudgetContinuationCount = (state.tokenBudgetContinuationCount ?? 0) + 1;
              ctxMgr.addMessage({
                role: "user",
                content: [{ type: "text", text: buildBudgetContinuationMessage(consumed, remaining) }],
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
              setTransition(state, { type: "token_budget_continuation" }, deps, sessionState.sessionId);
              continue;
            }
          }
        }
      }

      // ─── /goal：Goal Gate（独立评估者判定目标是否满足）───
      // 位于 Gate 链最末——只有前三道 Gate 全部放行，才轮到 Goal Gate 做最终判定。
      // Plan Mode 中暂停 Goal Gate（计划模式不执行操作，不应评估完成度）。
      if (deps.getGoalState) {
        const goal = deps.getGoalState();
        const inPlanMode = deps.getCurrentPermissionMode?.() === "plan";
        if (goal && goal.status === "active" && !inPlanMode) {
          try {
            // 评估者模型优先级：config.goal.evaluatorModel > subAgentModels.default > 主模型
            // 注意：刻意跳过 subAgentModels.verify —— verify 语义是"对抗验证子代理"（需强模型、慢），
            // 而 goal 评估是"快速判是否完成"（需快模型、512 token JSON）。复用 verify 会让强慢模型
            // 撞上短超时必然失败（见 20260707 排查 P0-1/P1-4）。两者解耦。
            const evaluatorModel =
              effectiveGoalConfig.evaluatorModel ||
              config.subAgentModels?.default ||
              config.model;
            const evalConfig = {
              model: evaluatorModel,
              provider: (() => {
                // 尝试获取评估者对应的 provider（简化：直接用主 provider）
                // 完整实现应通过 ProviderRegistry.getProviderForSubAgent("verify")
                // 这里的 deps.sendWithRetry 内部已封装了 provider，我们直接构造一个轻量 provider 接口
                const { AnthropicProvider } = require("../llm/anthropic.ts");
                const { OpenAIProvider } = require("../llm/openai.ts");
                if (config.provider === "anthropic") {
                  return new AnthropicProvider(config.anthropicKey, evaluatorModel, config.baseURL);
                }
                return new OpenAIProvider(config.openaiKey, evaluatorModel, config.baseURL);
              })(),
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
              deps.updateGoalState?.(g => { g.status = "complete"; });
              log.info("GOAL_GATE", "目标已达成，正常收尾");
              // 落入下方正常收尾
            } else if (result.impossible) {
              deps.updateGoalState?.(g => { g.status = "impossible"; });
              log.info("GOAL_GATE", "目标不可能达成，正常收尾");
              // 落入下方正常收尾
            } else if (result.shouldContinue) {
              deps.updateGoalState?.(g => { g.lastEvalReason = result.evalResult?.reason; });
              setTransition(state, { type: "goal_gate_retry" }, deps, sessionState.sessionId);
              continue;
            } else {
              // shouldContinue=false && !completed && !impossible
              //   → 轮次超限 / 预算耗尽 / blocked：handleGoalGate 已直接改了 goal.status
              //     （同一对象引用），但必须显式触发 updateGoalState 才能落盘持久化 + 刷新 TUI 状态栏。
              //     缺这一步会导致终态不写 JSONL（resume 时仍显示 active）、状态栏不更新。
              const terminalStatus = goal.status;
              deps.updateGoalState?.(g => {
                g.status = terminalStatus;
                if (result.evalResult?.reason) g.lastEvalReason = result.evalResult.reason;
              });
              log.info("GOAL_GATE", `目标终止（${terminalStatus}），正常收尾`);
              // 落入下方正常收尾
            }
          } catch (e: any) {
            // Goal Gate 不得阻断主循环
            log.warn("GOAL_GATE", `Goal Gate 异常（已忽略，正常收尾）：${e?.message ?? String(e)}`);
          }
        }
      }

      const totalUsage = sessionState.getTotalUsage();
      log.info("QUERY_LOOP", `对话结束 (${response.stopReason})，共 ${state.turnCount} 轮，in=${totalUsage.inputTokens} out=${totalUsage.outputTokens}，累计费用 $${sessionState.totalCostUSD.toFixed(4)}`);
      // F1：正常收尾，清零连续退化计数
      state.emptyParamRetryCount = 0;
      // 方案②：正常收尾（含续命耗尽放行），清零未答复连续计数
      state.unansweredRetryCount = 0;
      // Step 0：end_turn 是自然断点——触发 Session Memory 提取（fire-and-forget），
      // 把本轮终态沉淀进笔记，下次压缩可优先用它而非从头 LLM 摘要。
      deps.updateSessionMemory?.().catch(() => { /* 提取失败不阻断收尾 */ });
      // 后台记忆提取：end_turn 后扫描本轮对话，提取值得长期记住的信息写入 MEMORY.md
      // （fire-and-forget，内部互斥判断本轮主代理是否已写记忆，未写才跑 forked agent）。
      deps.extractMemories?.().catch(() => { /* 提取失败不阻断收尾 */ });
      yield { kind: "done", turns: state.turnCount };
      return;
    }

    // ─── 处理工具调用 ───
    // 进入条件：stop_reason=tool_use（正常路径），或 F2 fall-through——
    // stop_reason=end_turn/stop 但 content 仍有（非空参数）tool_use 未执行。
    if (response.stopReason === "tool_use" || f2FallThrough) {
      const toolBlocks = response.content.filter(b => b.type === "tool_use");
      const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "").filter(Boolean);
      if (response.stopReason !== "tool_use") {
        log.info("QUERY_LOOP", `F2：end_turn(${response.stopReason}) 含未执行 tool_use，兜底执行: ${toolNames.join(", ")}`);
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
          yield { kind: "done", turns: state.turnCount };
          return;
        }
        yield { kind: "loop_detected", detail: "工具调用重复" };
        yield { kind: "loop_recovery", attempt: loopDetector.getRecoveryAttempts(), maxAttempts: loopDetector.getMaxRecoveryAttempts() };
        setTransition(state, { type: "loop_recovery" }, deps, sessionState.sessionId);
        continue;
      }

      // LLM 认知循环检测
      if (loopDetector.shouldRunLLMCheck()) {
        const llmLoopDetected = await runLLMLoopCheck(loopDetector, loopConfig, ctxMgr);
        if (llmLoopDetected) {
          const recovered = await recoverFromLoop(loopDetector, ctxMgr, "LLM 认知检测到循环模式");
          if (!recovered) {
            yield { kind: "done", turns: state.turnCount };
            return;
          }
          yield { kind: "loop_detected", detail: "LLM 认知检测到循环模式" };
          yield { kind: "loop_recovery", attempt: loopDetector.getRecoveryAttempts(), maxAttempts: loopDetector.getMaxRecoveryAttempts() };
          setTransition(state, { type: "loop_recovery" }, deps, sessionState.sessionId);
          continue;
        }
      }

      // yield 工具开始事件
      for (const b of toolBlocks) {
        if (b.type === "tool_use") {
          yield { kind: "tool_start", toolName: b.name, toolInput: b.input };
          // 可观测性：把 hypothesis_register / hypothesis_challenge 的实际调用落成 trace 事件
          // （events.jsonl），与 HypothesisGuideInjected 配对——前者记"注入命中"、后者记"模型采纳"，
          // 两者相除即「防线采纳率」，可被 trace-digest 自动统计，无需离线 grep。
          if (deps.traceAppendEvent && (b.name === "hypothesis_register" || b.name === "hypothesis_challenge")) {
            try {
              deps.traceAppendEvent({
                event: "HypothesisToolUsed",
                session_id: sessionState.sessionId,
                timestamp: new Date().toISOString(),
                data: {
                  tool: b.name,
                  turn: state.turnCount,
                  guideInjected: state.hypothesisGuideInjected === true,
                },
              });
            } catch { /* trace 写入失败不阻断 */ }
          }
        }
      }

      // 执行工具
      const toolPerfHandle = getPerfTimer().start(`tool_batch_${state.turnCount}`);
      let toolResults: import("../llm/types.ts").ContentBlock[];
      let toolFollowup: import("../llm/types.ts").ContentBlock[] | undefined;
      try {
        const ret = await deps.executeTools(response.content);
        toolResults = ret.results;
        toolFollowup = ret.followup;
      } catch (err: any) {
        toolPerfHandle.end();
        if (isAbortError(err)) {
          // A2：用户取消工具执行 → 补上取消的 tool_result（保持 tool_use/tool_result 协议配对），
          // 然后优雅收尾（yield done + return），而非 throw err 让异常穿透。
          // 对标 claude-code：abort 是正常的"用户中断"而非错误路径。
          const cancelResults = toolBlocks
            .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
            .map(b => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: "用户取消了此工具调用",
              is_error: true,
            }));
          ctxMgr.addMessage({ role: "user", content: cancelResults });
          // B2：assistant（含 tool_use）已在上方 yield assistant_message 时由 engine 持久化，此处仅补 cancel result，保持配对。
          try { deps.sessionStore?.appendMessage({ role: "user", content: cancelResults }); } catch { /* 持久化失败不阻断 */ }
          log.info("QUERY_LOOP", "工具执行被用户取消，已补 cancel result，优雅收尾（reason=aborted_tools）");
          yield { kind: "done", turns: state.turnCount };
          return;
        }
        // AGENT-2 双重防护：非 abort 异常会 throw 穿透，但此时 assistant(含 tool_use) 已入历史，
        // 工具结果缺失 → 孤儿 tool_use。发送前的 backfillOrphanToolResults 关卡是主防护，
        // 这里在 throw 前先就地补齐本轮 tool_use 的 error 占位 result，让 ctxMgr 历史与
        // sessionStore 落盘当场即满足协议配对，避免异常路径毒化后续 / 恢复时的会话历史。
        const errorResults = toolBlocks
          .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
          .map(b => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: `工具执行异常中断：${err?.message ?? String(err)}`,
            is_error: true,
          }));
        if (errorResults.length > 0) {
          ctxMgr.addMessage({ role: "user", content: errorResults });
          try { deps.sessionStore?.appendMessage({ role: "user", content: errorResults }); } catch { /* 持久化失败不阻断 */ }
          log.warn("QUERY_LOOP", `工具执行抛出非 abort 异常，已为 ${errorResults.length} 个 tool_use 补 error result 后再抛出`);
        }
        throw err;
      }
      const toolBatchElapsed = toolPerfHandle.end();
      ctxMgr.addMessage({ role: "user", content: toolResults });
      // B2 方案 a：tool_result 与入历史同步持久化（appendMessage 按 role=user 自动分派为 tool_result 记录）。
      try { deps.sessionStore?.appendMessage({ role: "user", content: toolResults }); } catch { /* 持久化失败不阻断 */ }

      // 环节③ 机制2（矛盾中断·触发端）：把本轮所有 tool_result 文本拼起来，扫描是否与
      // 任何 open 假设的证伪条件线索矛盾。命中则暂存到 state，下一轮循环开头经 reminder
      // 通道注入"矛盾中断"，强制模型来 hypothesis_challenge 裁决——这正是 fdb47f30 缺的
      // 那一下：拿到推翻早期叙事的证据时，主动停下来裁决，而非视而不见继续推进。
      if (deps.getHypothesisLedger) {
        try {
          const ledger = deps.getHypothesisLedger();
          if (ledger && !ledger.isEmpty()) {
            const evidenceText = toolResults
              .filter((r): r is typeof r & { type: "tool_result" } => r.type === "tool_result")
              .map((r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content)))
              .join("\n");
            const hits = ledger.detectContradictions(evidenceText);
            if (hits.length > 0) {
              state.pendingContradictions = [...(state.pendingContradictions ?? []), ...hits];
              log.info(
                "QUERY_LOOP",
                `假设登记表矛盾检测命中 ${hits.length} 条（${hits.map((h) => h.hypothesisId).join(",")}），下一轮注入矛盾中断`,
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
                const toolName = toolUseBlock && toolUseBlock.type === "tool_use" ? toolUseBlock.name : "unknown";
                return { toolName, result: typeof r.content === "string" ? r.content : JSON.stringify(r.content) };
              });
            const newEvidence = collectEvidenceFromTurn(toolResultTexts, goal.turnsUsed);
            if (newEvidence.length > 0) {
              goal.evidenceLog.push(...newEvidence);
              // 幂等同步：赋数组引用而非再 push（getGoalState/updateGoalState 在生产中
              // 操作同一对象，若此处再 push 会导致证据被重复记录两次）。
              deps.updateGoalState?.(g => { g.evidenceLog = goal.evidenceLog; });
              log.debug("GOAL_EVIDENCE", `收集 ${newEvidence.length} 条证据（第 ${goal.turnsUsed} 轮）`);
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
        try { deps.sessionStore?.appendMessage({ role: "user", content: toolFollowup }); } catch { /* 持久化失败不阻断 */ }
      }

      // yield 工具结束事件
      const resultMap = new Map<string, import("../llm/types.ts").ContentBlock>();
      for (const r of toolResults) {
        if (r.type === "tool_result") resultMap.set(r.tool_use_id, r);
      }
      const perToolDuration = Math.round(
        toolBlocks.length > 0
          ? toolBatchElapsed / toolBlocks.length
          : toolBatchElapsed,
      );

      for (const b of toolBlocks) {
        if (b.type !== "tool_use") continue;
        const result = resultMap.get(b.id);
        const isError = result && result.type === "tool_result" ? !!result.is_error : false;
        yield { kind: "tool_end", toolName: b.name, result: { isError, elapsedMs: perToolDuration } };
      }

      // F1：工具成功执行 → 模型已恢复正常生成参数的能力，清零连续退化计数
      state.emptyParamRetryCount = 0;
      // 方案②：工具成功执行 → 模型已在正常推进（非"只思考不答复"），清零未答复计数
      state.unansweredRetryCount = 0;

      // Step 0：本轮工具结果已入历史，触发 Session Memory 提取（fire-and-forget，
      // 内部按双阈值决定是否真正提取，未达阈值/进行中则直接跳过，不阻塞主循环）。
      deps.updateSessionMemory?.().catch(() => { /* 提取失败不阻断主循环 */ });

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
        let hadOtherActivity = responseText.trim().length > 0;
        for (const b of toolBlocks) {
          if (b.type !== "tool_use") continue;
          const readOutput = () => {
            const r = resultMap.get(b.id);
            return r && r.type === "tool_result"
              ? (typeof r.content === "string" ? r.content : JSON.stringify(r.content))
              : "";
          };
          const cmd = b.name === "bash" ? (b.input as any)?.command : undefined;
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
        }
        if (!state.repeatedReadonly) state.repeatedReadonly = createRepeatedReadonlyState();
        const decision = observeRepeatedReadonly(state.repeatedReadonly, probes, hadOtherActivity);
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
          } catch { /* 抓取失败不阻断，提醒仍带命令实时输出 */ }
          // 与 pendingContradictions 同机制：不在此直接 addMessage（那会永久落历史、长任务膨胀），
          // 而是置 pending，下一轮循环开头经 reminderParts → injectReminders 注入（仅本轮、缓存友好）。
          state.pendingStuckReminder = buildStuckReminder(decision.command, decision.output ?? "", freshGitStatus);
          log.warn(
            "QUERY_LOOP",
            `无进展止损：连续 ${state.repeatedReadonly.repeatCount} 轮空跑只读命令 \`${decision.command.trim()}\`，` +
              `下一轮经 reminder 通道注入实时 git 状态收敛提醒（第 ${state.repeatedReadonly.reminderCount}/${2} 次）`,
          );
          yield { kind: "system", level: "warning", text: `检测到反复执行同一只读命令且结果不变，已注入实时状态并提示收敛` };
          setTransition(state, { type: "tool_use" }, deps, sessionState.sessionId);
          continue;
        }
        if (decision.stuck && decision.action === "terminate" && decision.command !== undefined) {
          // 已注满提醒上限仍空转 → 强制收尾，避免无限循环到用户 ESC。
          const notice = buildTerminateNotice(decision.command);
          ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: notice }] });
          try {
            deps.sessionStore?.appendMessage({ role: "user", content: [{ type: "text", text: notice }] });
          } catch { /* 持久化失败不阻断 */ }
          log.warn(
            "QUERY_LOOP",
            `无进展止损：连续空跑只读命令 \`${decision.command.trim()}\` 且提醒无效，强制收尾（避免无限循环）`,
          );
          yield { kind: "system", level: "warning", text: `连续空转于同一只读命令，已强制结束以避免无限循环` };
          yield { kind: "done", turns: state.turnCount };
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
          log.info("QUERY_LOOP", `mid-turn 抢占：注入 ${injected} 条 now 级用户输入，本轮工具结果已配对无孤儿`);
          yield { kind: "system", level: "info", text: `已插入 ${injected} 条新输入，将在下一轮优先处理` };
        }
      }

      setTransition(state, { type: "tool_use" }, deps, sessionState.sessionId);
      continue;
    }

    // ─── max_tokens 续写（含递减收益检测 + 分级恢复）───
    if (response.stopReason === "max_tokens" || response.stopReason === "length") {
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
          log.warn("QUERY_LOOP", `max_tokens 续写递减收益命中（已续写 ${diminishingDetector.count} 次），停止自动续写并让手给模型自行决定`);
          yield { kind: "system", level: "info", text: `连续续写产出递减，已停止自动续写，交由模型决定下一步` };
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
            deps.sessionStore?.appendMessage({ role: "user", content: [{ type: "text", text: handoffNotice }] });
          } catch { /* 持久化失败不阻断让手 */ }
          setTransition(state, { type: "max_tokens_continuation" }, deps, sessionState.sessionId);
          continue;
        }
        // 让手后仍收敛不了 → 终止，避免无限续写
        log.warn("QUERY_LOOP", `max_tokens 续写递减收益二次命中（让手后仍未收敛，已续写 ${diminishingDetector.count} 次），停止续写`);
        yield { kind: "system", level: "info", text: `输出续写已达上限（${diminishingDetector.count} 次），自动停止` };
        yield { kind: "done", turns: state.turnCount };
        return;
      }

      // Stage 1：首次截断且当前上限低于模型硬上限 → 提升上限重试，不注入续写提示
      // 当用户显式设了较低 maxTokens 或 effort 模式压低输出时，直接提升上限通常一步解决
      const modelMax = lookupRegistry(config.model)?.maxOutputTokens;
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
      log.info("QUERY_LOOP", `输出达到 token 上限 (maxTokens=${state.maxOutputTokensOverride ?? config.maxTokens})，自动续写 #${state.maxOutputTokensRecoveryCount} (轮次 ${state.turnCount})`);

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
          deps.sessionStore?.appendMessage({ role: "user", content: [{ type: "text", text: clipNotice }] });
        } catch { /* 持久化失败不阻断续写 */ }
      }

      setTransition(state, { type: "max_tokens_continuation" }, deps, sessionState.sessionId);
      continue;
    }

    // ─── refusal（模型安全策略拒答，Opus 4.7+ 新增）───
    // [来源: anthropic-api.md:556,752]
    if (response.stopReason === "refusal") {
      const refusalText = response.content
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("")
        .trim() || "模型基于安全策略拒绝回答";
      log.warn("QUERY_LOOP", `模型安全拒答: ${refusalText.slice(0, 200)}`);
      yield { kind: "system", level: "warning", terminal: true, text: `[安全策略拒答] ${refusalText}` };
      yield { kind: "done", turns: state.turnCount };
      return;
    }

    // ─── model_context_window_exceeded（撞模型 context window 上限，Claude 4.5+ 新增）───
    // 区别于 max_tokens（主动设的输出上限），这是输入+输出总和撞到模型硬上限。
    // 处理策略：压缩上下文后续写。[来源: anthropic-api.md:553,559]
    if (response.stopReason === "model_context_window_exceeded") {
      log.warn("QUERY_LOOP", "撞到模型 context window 上限，触发上下文压缩后续写");
      yield { kind: "system", level: "info", text: "输出因撞到模型上下文窗口上限被中断，正在压缩上下文后续写" };

      // 尝试压缩上下文释放空间
      const compactResult = reactiveCompact(ctxMgr);
      if (compactResult.success) {
        log.info("QUERY_LOOP", `context_window_exceeded 压缩成功: ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条`);
      }

      state.maxOutputTokensRecoveryCount++;
      setTransition(state, { type: "max_tokens_continuation" }, deps, sessionState.sessionId);
      continue;
    }

    // ─── pause_turn（server tool 暂停，需续接）───
    // [来源: anthropic-api.md:557]
    if (response.stopReason === "pause_turn") {
      log.info("QUERY_LOOP", "收到 pause_turn（server tool 暂停），作为 tool_use 续接");
      setTransition(state, { type: "tool_use" }, deps, sessionState.sessionId);
      continue;
    }

    // ─── 其他停止原因（含 null）───
    // 背景（事故复盘 session 20260708-102143）：当上游返回"伪装成功的空流"
    // （如网关对不可用模型回 HTTP 200 + text/html 错误页，被 SSE 解析成 0 事件），
    // stopReason 会是 null 且 content 为空，一路穿透上面所有停止原因分支落到这里。
    // 此前本分支只写 warn.log + 静默 yield done——用户界面毫无提示，表现为"任务
    // 一闪而过就没了"。现在必须把这类静默失败暴露给用户（yield system error），
    // 且区分"空响应"（真故障）与"非空但停止原因未识别"（罕见，可能是新协议字段）。
    const hasAnyContent = response.content.length > 0;
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
    yield { kind: "done", turns: state.turnCount };
    return;
  }
  } finally {
    // Fix 1：queryLoop 结束时批量清理本次 loopId 下所有快照残留
    clearAllSnapshots(loopId);

    // 主循环终止时的收尾驱逐（尊重缓冲期，force=false）。
    // 根因：evictTerminalTasks() 只在 while 循环每轮开头调用（上方 line ~336），是
    // "下一轮驱动"的清除——主循环 end_turn 结束后再无下一轮循环开头触发驱逐。这里在
    // generator 终止时（正常 end_turn / 异常 / 外部 .return() 中止都会经过 finally）
    // 补一次收尾驱逐：把"缓冲期已过"的终止态任务立即清掉，不必等到下次用户输入才清。
    //
    // 为何 force=false（不忽略缓冲期）：缓冲期（EVICT_GRACE_MS=60s）的意义是"任务刚完成
    // 后留一个窗口，让用户还能在面板翻看刚完成的任务"。真正根治"尾部窗口永久残留"的是
    // TUI 侧独立于主循环的 1s 定时器（App.tsx，对标 cc CoordinatorAgentStatus），它会在
    // 缓冲期到点后（≤1s 延迟）清掉——不依赖主循环转没转。因此这里无需 force 越过缓冲期
    //（那会牺牲"刚完成可翻看"语义、比 cc 更激进）；缓冲期内的任务交给那个定时器即可。
    // 安全性：只驱逐 notified=true 的终止态任务，其完成通知已原子入队 pendingQueue
    //（独立于任务注册表），驱逐不丢任何完成信息。
    try {
      evictTerminalTasks();
    } catch { /* 收尾清理不应影响主循环退出 */ }
  }

  // ─── P1-1：主循环达到 maxTurns——强制请求总结（额外一轮，不计入 maxTurns）───
  // 对齐 src/agent/agentic-loop.ts:344-393 子代理版的同一做法：硬停在 maxTurns 时，
  // 最后一条 assistant 消息很可能是工具调用中途、或"让我先看看…"这类未收尾文本，直接
  // 把它当结果丢给用户体验很差。这里追加一轮不带工具的调用，逼模型输出结构化总结。
  // 用 deps.sendWithRetry/processStream（而非直连 provider）保持与 loop.ts 其余部分
  // 一致的可测试性；调用失败不阻断收尾（降级为下面按 turnCount 正常提示 max_turns）。
  if (state.turnCount >= state.maxTurns && !deps.getAbortSignal?.()?.aborted) {
    log.info("QUERY_LOOP", `P1-1：达到最大轮次 ${state.maxTurns}，请求强制总结`);
    ctxMgr.addMessage({
      role: "user",
      content: [{
        type: "text",
        text: "你已达到最大轮次限制，无法继续调用工具。请立即总结你目前为止的所有发现和已完成的工作，以及尚未完成的部分，用结构化格式（列表/表格）呈现。不要再调用任何工具。",
      }],
    });
    try {
      const summaryStream = deps.sendWithRetry(
        {
          model: config.model,
          messages: ctxMgr.getMessages(),
          system: ctxMgr.getSystemPrompt(),
          maxTokens: config.maxTokens,
          // 不传 tools，禁止模型继续调工具（对齐 agentic-loop.ts 强制总结轮的做法）。
        },
        deps.getAbortSignal?.(),
      );
      const summaryResponse = await deps.processStream(summaryStream);
      if (summaryResponse.content.length > 0) {
        // P1-1 是"禁止调工具的总结轮"（sendWithRetry 未传 tools），但响应仍可能含
        // tool_use（mock 忽略 tools 参数 / 模型异常）。tool_use 在此轮无法执行（既不走
        // executeTools，也不在 while 循环内的发送前 finalizeMessagesForSend 兜底范围内），
        // 入历史会形成孤儿 → 下次发送 OpenAI 400。剥离 tool_use，只保留 text/reasoning
        // 等非工具块。这是产生端修复（对齐"孤儿来源应在产生端排查"原则）。
        const summaryContent = summaryResponse.content.filter(
          (b) => b.type !== "tool_use",
        );
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
    }
  }

  // 达到最大轮次
  if (state.turnCount >= state.maxTurns) {
    log.warn("QUERY_LOOP", `达到最大轮次限制: ${state.maxTurns}`);
    yield { kind: "max_turns", maxTurns: state.maxTurns };
  }
  yield { kind: "done", turns: state.turnCount };
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
      log.warn("QUERY_LOOP", `放弃恢复前补齐 ${pending.length} 个未应答 tool_use 的占位 tool_result（防孤儿 → 400）`);
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

  ctxMgr.addMessage({
    role: "user",
    content: [...orphanResults, { type: "text", text: LOOP_RECOVERY_PROMPT }],
  });

  return true;
}

/**
 * 为消息历史中"末尾 assistant 的未应答 tool_use"构造 error 占位 tool_result。
 *
 * 只看历史末尾这一组孤儿（即最近一条 assistant 的 tool_use 里尚无 tool_result 的），
 * 因为循环恢复/中断发生在"刚产生 assistant tool_use、还没执行工具"的时刻。
 * 用全局完整性检查锁定孤儿 id，避免误补历史更早处已正常配对的调用。
 */
function buildPendingToolResults(
  messages: import("../llm/types.ts").Message[],
  content: string,
): import("../llm/types.ts").ContentBlock[] {
  const integrity = checkMessageHistoryIntegrity(messages);
  if (integrity.orphans.length === 0) return [];
  return integrity.orphans.map(o => ({
    type: "tool_result" as const,
    tool_use_id: o.id,
    content,
    is_error: true,
  }));
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
    .filter(c => c.kind === "user-input" && typeof c.payload === "string" && c.payload.trim())
    .map(c => (c.payload as string));
  if (texts.length === 0) return 0;

  const content = texts.map(t => ({ type: "text" as const, text: t }));
  ctxMgr.addMessage({ role: "user", content });
  try {
    deps.sessionStore?.appendMessage({ role: "user", content });
  } catch { /* 持久化失败不阻断主循环 */ }
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
      const textBlocks = msg.content.filter(b => b.type === "text");
      if (textBlocks.length > 0) {
        return textBlocks.map(b => b.type === "text" ? b.text : "").join("\n");
      }
    }
  }
  return "";
}
