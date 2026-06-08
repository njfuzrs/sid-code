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
import type { HookSystem } from "../hook/system.ts";
import type { QuotaManager } from "../llm/quota.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import type { BudgetTracker } from "../telemetry/metrics/budget-tracker.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { ModelFallback } from "../llm/fallback.ts";
import { SessionState } from "../session/state.ts";
import { getLogger, getSessionMetrics, getPerfTimer } from "../debug/index.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "../agent/loop-detection.ts";
import type { LLMLoopCheckResult } from "../agent/loop-detection.ts";
import {
  checkMessageHistoryIntegrity,
  backfillOrphanToolResults,
} from "../agent/message-invariants.ts";
import { isAbortError } from "../llm/errors.ts";
import { isPromptTooLongError, reactiveCompact, DiminishingReturnsDetector } from "./reactive-compact.ts";
import { runCompactPipeline } from "./compact/index.ts";
import type {
  QueryLoopYield,
  QueryDeps,
  LoopState,
} from "./types.ts";
import { createInitialLoopState } from "./types.ts";

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
    deps,
  } = loopConfig;

  const loopDetector = new LoopDetector();
  const state: LoopState = createInitialLoopState(config.maxTurns || Infinity);
  const diminishingDetector = new DiminishingReturnsDetector();

  while (state.turnCount < state.maxTurns) {
    state.turnCount++;
    loopDetector.recordTurn();

    // ─── 上下文使用率监控 ───
    const toolCount = toolRegistry.size();
    const currentTokens = ctxMgr.estimateTokens(toolCount);
    const contextMax = ctxMgr.getMaxTokens();
    const usagePercent = (currentTokens / contextMax) * 100;
    const remaining = 100 - usagePercent;

    getSessionMetrics().updatePeakTokens(currentTokens);

    log.info("QUERY_LOOP", `轮次 ${state.turnCount}/${state.maxTurns}，消息数 ${ctxMgr.getMessages().length}，上下文 ${usagePercent.toFixed(0)}%`);

    // ─── 分级压缩策略 ───
    const compactionLevel = ctxMgr.getCompactionLevel(toolCount);
    switch (compactionLevel) {
      case "emergency":
        log.warn("QUERY_LOOP", `上下文紧急 (${usagePercent.toFixed(0)}%)，强制截断`);
        ctxMgr.emergencyTruncate();
        yield { kind: "compact" };
        break;
      case "hard": {
        log.warn("QUERY_LOOP", `上下文接近上限 (${usagePercent.toFixed(0)}%)，启动渐进式压缩管道`);
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
          log.warn("QUERY_LOOP", "轻量压缩不足，触发 LLM 摘要压缩");
          await deps.autoCompact();
        }

        yield { kind: "compact" };
        break;
      }
      case "soft":
        log.info("QUERY_LOOP", `上下文 ${usagePercent.toFixed(0)}%，启用工具输出遮罩`);
        break;
      case "none":
        break;
    }

    if (remaining <= 6) {
      yield { kind: "context_warning", remaining };
    }

    // ─── 构建请求参数 ───
    // 生产端发送前孤儿兜底 backstop（系统级查漏补缺方案 防线 1，根因终结关卡）：
    // 无论孤儿从哪条路径进入历史（循环恢复 / 中断时序 / followup 排序 / plan-mode 转换 / 未来新增），
    // 发送前统一在 ctxMgr 历史层补 error 占位 tool_result，使其满足 tool_use/tool_result 协议配对。
    // 这是 ADR-039「不变量在出口强制」哲学的终点——executeTools 守生产单点，这里守"所有路径的总出口"。
    // 与消费端只读哨兵（protocol-sentinel）互补：哨兵负责发现+告警+落盘，本关卡负责真正修复，不让 400 发生。
    {
      const backfill = backfillOrphanToolResults(ctxMgr.getMessages());
      if (backfill.changed) {
        ctxMgr.setMessages(backfill.messages);
        const detail = backfill.backfilled
          .map(o => `${o.name}(id=${o.id} @msg#${o.messageIndex})`)
          .join(", ");
        log.error(
          "QUERY_LOOP",
          `发送前孤儿兜底关卡触发：补齐 ${backfill.backfilled.length} 个孤儿 tool_use 的占位 tool_result（已修复，避免 OpenAI 400）：${detail}。` +
            `孤儿来源应在产生端排查（循环恢复/中断/followup/plan-mode）。`,
        );
      }
    }

    const cleanedMessages = ctxMgr.getCleanedMessages();
    const toolDefs = toolCount > 0 ? toolRegistry.definitions() : undefined;
    log.llmRequest(config.provider, config.model, cleanedMessages.length, toolDefs?.length ?? 0, config.maxTokens);

    const sendParams: SendParams = {
      model: config.model,
      messages: cleanedMessages,
      system: ctxMgr.getSystemPrompt(),
      maxTokens: config.maxTokens,
      tools: toolDefs,
    };

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
    const signal = deps.getAbortSignal();
    try {
      stream = deps.sendWithRetry(sendParams, signal);
    } catch (err: any) {
      // prompt-too-long 错误扣留：自动触发响应式压缩重试
      if (isPromptTooLongError(err) && !state.hasAttemptedReactiveCompact) {
        log.warn("QUERY_LOOP", "检测到 prompt-too-long 错误，触发响应式压缩");
        const compactResult = reactiveCompact(ctxMgr);
        if (compactResult.success) {
          state.hasAttemptedReactiveCompact = true;
          state.transition = { type: "reactive_compact" };
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
        stream = deps.sendWithRetry(sendParams, signal);
      } else {
        log.warn("QUERY_LOOP", "上下文溢出且无法调整 maxTokens，触发自动压缩");
        await deps.autoCompact();
        yield { kind: "compact" };
        state.transition = { type: "context_overflow_retry" };
        continue;
      }
    }

    // ─── 处理流式响应 ───
    const perfHandle = getPerfTimer().start(`llm_request_${state.turnCount}`);
    let ttftMs: number | undefined;
    const ttftStart = performance.now();

    let response: import("../llm/types.ts").AccumulatedResponse;
    try {
      response = await deps.processStream(stream, (_text) => {
        if (ttftMs === undefined) {
          ttftMs = performance.now() - ttftStart;
        }
        // 流式文本通过 QueryEngine 层的 onStreamText 回调桥接
      });
    } catch (err: any) {
      perfHandle.end({ model: config.model });

      // 流式阶段的 prompt-too-long 错误恢复（与连接阶段逻辑一致）
      if (isPromptTooLongError(err) && !state.hasAttemptedReactiveCompact) {
        log.warn("QUERY_LOOP", "流式阶段检测到 prompt-too-long 错误，触发响应式压缩");
        const compactResult = reactiveCompact(ctxMgr);
        if (compactResult.success) {
          state.hasAttemptedReactiveCompact = true;
          state.transition = { type: "reactive_compact" };
          yield { kind: "compact" };
          yield { kind: "system", level: "info", text: `响应式压缩: ${compactResult.messageCountBefore} → ${compactResult.messageCountAfter} 条消息` };
          continue;
        }
        log.warn("QUERY_LOOP", "响应式压缩失败，尝试 autoCompact");
      }

      // prompt-too-long 兜底：autoCompact 后重试
      if (isPromptTooLongError(err)) {
        await deps.autoCompact();
        yield { kind: "compact" };
        state.transition = { type: "context_overflow_retry" };
        continue;
      }

      throw err;
    }
    const apiDuration = perfHandle.end({ model: config.model });

    // ─── 更新用量统计 ───
    sessionState.updateUsage(config.model, response.usage, apiDuration);
    const thisCost = sessionState.calculateCost(config.model, response.usage);

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
      const quotaResult = loopConfig.quotaManager.check(sessionState.totalCostUSD);
      if (quotaResult) {
        if (quotaResult.level === "exceeded") {
          yield { kind: "system", level: "warning", text: quotaResult.message };
          yield { kind: "done", turns: state.turnCount };
          return;
        } else if (quotaResult.level === "critical" || quotaResult.level === "warning") {
          yield { kind: "system", level: "warning", text: quotaResult.message };
        }
      }
    }

    log.llmResponse(response.stopReason || "unknown", response.usage, apiDuration, sessionState.totalCostUSD);

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
          },
          cost_usd: thisCost,
          api_duration_ms: apiDuration,
          cache_savings_usd: cacheSavingsUSD,
          ttft_ms: ttftMs,
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
      state.transition = { type: "loop_recovery" };
      continue;
    }

    // ─── 检查停止原因 ───
    if (response.stopReason === "end_turn" || response.stopReason === "stop") {
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
          state.transition = { type: "stop_hook_retry" };
          continue;
        }

        if (stopResult?.forceStop) {
          log.info("QUERY_LOOP", "Stop Hook preventContinuation，强制结束");
        }
      }

      const totalUsage = sessionState.getTotalUsage();
      log.info("QUERY_LOOP", `对话结束 (${response.stopReason})，共 ${state.turnCount} 轮，in=${totalUsage.inputTokens} out=${totalUsage.outputTokens}，累计费用 $${sessionState.totalCostUSD.toFixed(4)}`);
      yield { kind: "done", turns: state.turnCount };
      return;
    }

    // ─── 处理工具调用 ───
    if (response.stopReason === "tool_use") {
      const toolBlocks = response.content.filter(b => b.type === "tool_use");
      const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "").filter(Boolean);
      log.info("QUERY_LOOP", `工具调用: ${toolNames.join(", ")}`);

      // 工具调用循环检测
      let loopDetected = false;
      for (const b of toolBlocks) {
        if (b.type === "tool_use") {
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
        state.transition = { type: "loop_recovery" };
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
          state.transition = { type: "loop_recovery" };
          continue;
        }
      }

      // yield 工具开始事件
      for (const b of toolBlocks) {
        if (b.type === "tool_use") {
          yield { kind: "tool_start", toolName: b.name, toolInput: b.input };
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
          // 用户取消：补上取消的 tool_result
          const cancelResults = toolBlocks
            .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
            .map(b => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: "用户取消了此工具调用",
              is_error: true,
            }));
          ctxMgr.addMessage({ role: "user", content: cancelResults });
          log.info("QUERY_LOOP", "工具执行被用户取消，已补充取消的 tool_result");
        }
        throw err;
      }
      const toolBatchElapsed = toolPerfHandle.end();
      ctxMgr.addMessage({ role: "user", content: toolResults });

      // ADR-019：plan-approved 等"工具完成后再追加"的 user 消息，必须在 toolResults 之后 enqueue。
      if (toolFollowup && toolFollowup.length > 0) {
        ctxMgr.addMessage({ role: "user", content: toolFollowup });
      }

      // yield 工具结束事件
      const resultMap = new Map<string, import("../llm/types.ts").ContentBlock>();
      for (const r of toolResults) {
        if (r.type === "tool_result") resultMap.set(r.tool_use_id, r);
      }
      const perToolDuration = toolBlocks.length > 0
        ? toolBatchElapsed / toolBlocks.length
        : toolBatchElapsed;

      for (const b of toolBlocks) {
        if (b.type !== "tool_use") continue;
        const result = resultMap.get(b.id);
        const isError = result && result.type === "tool_result" ? !!result.is_error : false;
        yield { kind: "tool_end", toolName: b.name, result: { isError, elapsedMs: perToolDuration } };
      }

      state.transition = { type: "tool_use" };
      continue;
    }

    // ─── max_tokens 续写（含递减收益检测）───
    if (response.stopReason === "max_tokens" || response.stopReason === "length") {
      diminishingDetector.record(response.usage.outputTokens);

      if (diminishingDetector.shouldStop()) {
        log.warn("QUERY_LOOP", `max_tokens 续写递减收益检测触发（已续写 ${diminishingDetector.count} 次），停止续写`);
        yield { kind: "system", level: "info", text: `输出续写已达上限（${diminishingDetector.count} 次），自动停止` };
        yield { kind: "done", turns: state.turnCount };
        return;
      }

      state.maxOutputTokensRecoveryCount++;
      log.info("QUERY_LOOP", `输出达到 token 上限 (maxTokens=${config.maxTokens})，自动续写 #${state.maxOutputTokensRecoveryCount} (轮次 ${state.turnCount})`);
      state.transition = { type: "max_tokens_continuation" };
      continue;
    }

    // ─── 其他停止原因 ───
    log.warn("QUERY_LOOP", `未知停止原因: ${response.stopReason}`);
    yield { kind: "done", turns: state.turnCount };
    return;
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

/** LLM 认知循环检测 */
async function runLLMLoopCheck(
  loopDetector: LoopDetector,
  loopConfig: QueryLoopConfig,
  ctxMgr: ContextManager,
): Promise<boolean> {
  const log = getLogger();
  log.info("QUERY_LOOP", "启动 LLM 认知循环检测");

  try {
    const messages = ctxMgr.getMessages();
    const recentMessages = messages.slice(-20);
    const prompt = loopDetector.buildLLMCheckPrompt(recentMessages);

    const stream = loopConfig.deps.sendWithRetry(
      {
        model: loopConfig.config.model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        system: "你是一个对话模式分析器。只返回 JSON，不要其他内容。",
        maxTokens: 200,
      },
      loopConfig.deps.getAbortSignal(),
    );

    let resultText = "";
    for await (const event of stream) {
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
