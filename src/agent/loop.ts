/**
 * AgentLoopRunner — 统一的 Agentic While-Loop 核心循环
 * 消除 app.ts 中 agentLoop() 和 tuiAgentLoop() 的重复代码
 * 通过回调接口处理 REPL/TUI 的 UI 差异
 */

import type { Provider } from "../llm/provider.ts";
import type {
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "../llm/types.ts";
import type { Config } from "../config/config.ts";
import type { QuotaManager } from "../llm/quota.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import type { BudgetTracker } from "../telemetry/metrics/budget-tracker.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { ModelFallback } from "../llm/fallback.ts";
import { ThinkingManager } from "../llm/thinking.ts";
import { SessionState } from "../session/state.ts";
import { getLogger, getSessionMetrics, getPerfTimer } from "../debug/index.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import type { LLMLoopCheckResult } from "./loop-detection.ts";
import { isAbortError } from "../llm/errors.ts";

/** UI 回调接口，处理 REPL/TUI 的差异 */
export interface AgentLoopCallbacks {
  /** 用户消息已添加到上下文（用于 TUI 即时显示） */
  onUserMessageAdded?(): void;
  /** 流式文本输出 */
  onStreamText(text: string): void;
  /** 工具开始执行 */
  onToolStart(toolName: string, toolInput?: unknown): void;
  /** 工具执行结束 */
  onToolEnd(toolName: string, result?: { isError?: boolean; elapsedMs?: number }): void;
  /** 上下文压缩完成 */
  onCompact(): void;
  /** 循环结束 */
  onComplete(turns: number): void;
  /** 上下文剩余警告 */
  onContextWarning?(remaining: number): void;
  /** 最大轮次警告 */
  onMaxTurns?(maxTurns: number): void;
  /** 检测到循环 */
  onLoopDetected?(detail: string): void;
  /** 循环恢复尝试 */
  onLoopRecovery?(attempt: number, maxAttempts: number): void;
}

/** AgentLoopRunner 依赖 */
export interface AgentLoopDeps {
  config: Config;
  provider: Provider;
  ctxMgr: ContextManager;
  toolRegistry: ToolRegistry;
  sessionState: SessionState;
  fallback: ModelFallback;
  thinkingMgr: ThinkingManager;
  hookSystem?: HookSystem;
  quotaManager?: QuotaManager;
  tokenMeter?: TokenMeter;
  budgetTracker?: BudgetTracker;
  /** 执行工具调用（含权限检查） */
  executeTools: (content: ContentBlock[]) => Promise<ContentBlock[]>;
  /** 处理流式响应 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
  ) => Promise<AccumulatedResponse>;
  /** 自动压缩 */
  autoCompact: () => Promise<void>;
  /** 处理上下文溢出 */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
}

export class AgentLoopRunner {
  private deps: AgentLoopDeps;
  private loopDetector: LoopDetector;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.loopDetector = new LoopDetector();
  }

  /** 更新 Provider（模型切换时调用） */
  updateProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** 发送消息给 LLM（带重试和回退） */
  private sendWithRetry(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.deps.fallback.reset();
    return this.deps.fallback.executeWithFallback(this.deps.provider, params, signal);
  }

  /** 循环恢复机制 */
  private async recoverFromLoop(
    ctxMgr: ContextManager,
    callbacks: AgentLoopCallbacks,
    detail: string,
  ): Promise<boolean> {
    const log = getLogger();

    // 通知用户检测到循环
    callbacks.onLoopDetected?.(detail);

    // 尝试恢复
    const canRecover = this.loopDetector.tryRecover();
    if (!canRecover) {
      log.warn("AGENT", "循环恢复次数耗尽，终止循环");
      return false;
    }

    const attempt = this.loopDetector.getRecoveryAttempts();
    const maxAttempts = this.loopDetector.getMaxRecoveryAttempts();
    log.info("AGENT", `注入循环恢复提示 (${attempt}/${maxAttempts})`);
    callbacks.onLoopRecovery?.(attempt, maxAttempts);

    // 注入恢复提示让 LLM 自我纠正
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: LOOP_RECOVERY_PROMPT }],
    });

    return true;
  }

  /**
   * LLM 认知循环检测
   * 用轻量模型分析最近的工具调用模式，判断是否陷入非生产性循环
   */
  private async runLLMLoopCheck(
    ctxMgr: ContextManager,
    _callbacks: AgentLoopCallbacks,
  ): Promise<boolean> {
    const log = getLogger();
    log.info("AGENT", "启动 LLM 认知循环检测");

    try {
      // 取最近 20 条消息用于分析
      const messages = ctxMgr.getMessages();
      const recentMessages = messages.slice(-20);
      const prompt = this.loopDetector.buildLLMCheckPrompt(recentMessages);

      // 使用当前 provider 发送检测请求（短输出，低开销）
      const stream = this.deps.provider.sendMessageStream(
        {
          model: this.deps.config.model,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          system: "你是一个对话模式分析器。只返回 JSON，不要其他内容。",
          maxTokens: 200,
        },
        this.deps.getAbortSignal(),
      );

      let resultText = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          resultText += event.delta.text;
        }
      }

      // 解析 JSON 结果
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.debug("AGENT", "LLM 认知检测返回非 JSON 格式，跳过");
        return false;
      }

      const result: LLMLoopCheckResult = JSON.parse(jsonMatch[0]);
      return this.loopDetector.processLLMResult(result);
    } catch (err: any) {
      log.warn("AGENT", `LLM 认知检测失败: ${err.message}`);
      return false;
    }
  }

  /** 运行 Agent 循环 */
  async run(userInput: string, callbacks: AgentLoopCallbacks): Promise<void> {
    const log = getLogger();
    const { config, ctxMgr, toolRegistry, sessionState } = this.deps;

    log.info("AGENT", `用户输入: ${userInput.slice(0, 200)}${userInput.length > 200 ? "..." : ""}`);

    // 记录用户提示
    getSessionMetrics().recordPrompt();

    // 新一轮对话开始，重置模型可用性的 retry_once 标记
    if (this.deps.fallback) {
      this.deps.fallback.getAvailability().resetTurn();
    }

    // user_prompt_submit hook：可拦截或修改用户输入
    let finalInput = userInput;
    if (this.deps.hookSystem) {
      const hookResult = await this.deps.hookSystem.fireUserPromptSubmitEvent(userInput);
      // 检查是否被阻止
      if (hookResult.finalOutput?.isBlockingDecision()) {
        log.info("HOOK", `用户输入被 hook 阻止: ${hookResult.finalOutput.getEffectiveReason()}`);
        return;
      }
      // 检查是否应停止执行
      if (hookResult.finalOutput?.shouldStopExecution()) {
        log.info("HOOK", `用户输入被 hook 停止: ${hookResult.finalOutput.getEffectiveReason()}`);
        return;
      }
      // 检查 additionalContext（追加到输入）
      const additionalCtx = hookResult.finalOutput?.getAdditionalContext();
      if (additionalCtx) {
        log.info("HOOK", `用户输入被 hook 追加上下文`);
        finalInput = userInput + "\n\n" + additionalCtx;
      }
    }

    // 解析 thinking hint（如 "think", "think hard", "ultrathink"）
    const { cleaned: cleanedInput, config: thinkingConfig } =
      this.deps.thinkingMgr.parseThinkingHint(finalInput);
    // 如果没有显式 hint，根据输入自动推断
    const thinking = thinkingConfig ?? this.deps.thinkingMgr.getThinkingConfig(cleanedInput);

    // 添加用户消息（使用清理后的输入）
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: cleanedInput }],
    });
    callbacks.onUserMessageAdded?.();

    // 新输入重置循环检测
    this.loopDetector.reset();

    let turns = 0;
    const maxTurns = config.maxTurns || 50;

    while (turns < maxTurns) {
      turns++;
      this.loopDetector.recordTurn();

      // 上下文使用率监控（分级压缩策略）
      const toolCount = toolRegistry.size();
      const currentTokens = ctxMgr.estimateTokens(toolCount);
      const contextMax = ctxMgr.getMaxTokens();
      const usagePercent = (currentTokens / contextMax) * 100;
      const remaining = 100 - usagePercent;

      // 更新峰值 token 数
      getSessionMetrics().updatePeakTokens(currentTokens);

      log.info("AGENT", `轮次 ${turns}/${maxTurns}，消息数 ${ctxMgr.getMessages().length}，上下文 ${usagePercent.toFixed(0)}%`);

      const compactionLevel = ctxMgr.getCompactionLevel(toolCount);
      switch (compactionLevel) {
        case "emergency":
          log.warn("AGENT", `上下文紧急 (${usagePercent.toFixed(0)}%)，强制截断`);
          ctxMgr.emergencyTruncate();
          callbacks.onCompact();
          break;
        case "hard":
          log.warn("AGENT", `上下文接近上限 (${usagePercent.toFixed(0)}%)，触发摘要压缩`);
          await this.deps.autoCompact();
          callbacks.onCompact();
          break;
        case "soft":
          // soft 级别：工具输出遮罩在 getCleanedMessages 中自动处理
          log.info("AGENT", `上下文 ${usagePercent.toFixed(0)}%，启用工具输出遮罩`);
          break;
        case "none":
          break;
      }

      if (remaining <= 6) {
        callbacks.onContextWarning?.(remaining);
      }

      // 构建请求参数
      const cleanedMessages = ctxMgr.getCleanedMessages();
      const toolDefs = toolCount > 0 ? toolRegistry.definitions() : undefined;
      log.llmRequest(config.provider, config.model, cleanedMessages.length, toolDefs?.length ?? 0, config.maxTokens);
      log.info("LLM", `系统提示词 ${ctxMgr.getSystemPrompt().length}字符`);

      const sendParams: SendParams = {
        model: config.model,
        messages: cleanedMessages,
        system: ctxMgr.getSystemPrompt(),
        maxTokens: config.maxTokens,
        tools: toolDefs,
        // Extended Thinking（仅首轮传入，后续工具循环不需要）
        thinking: turns === 1 ? thinking : undefined,
      };

      // BeforeModel hook：可修改请求参数、合成响应、阻止请求
      if (this.deps.hookSystem) {
        const beforeModelResult = await this.deps.hookSystem.fireBeforeModelEvent({
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
          callbacks.onComplete(turns);
          break;
        }
        if (beforeModelResult.finalOutput?.shouldStopExecution()) {
          log.info("HOOK", `BeforeModel hook 停止执行: ${beforeModelResult.finalOutput.getEffectiveReason()}`);
          callbacks.onComplete(turns);
          break;
        }
      }

      // 发送请求（含上下文溢出自动调整）
      let stream: AsyncIterable<StreamEvent>;
      const signal = this.deps.getAbortSignal();
      try {
        stream = this.sendWithRetry(sendParams, signal);
      } catch (err: any) {
        const adjusted = this.deps.handleContextOverflow(err, sendParams.maxTokens);
        if (adjusted !== null) {
          log.info("AGENT", `上下文溢出，自动调整 maxTokens: ${sendParams.maxTokens} → ${adjusted}`);
          sendParams.maxTokens = adjusted;
          stream = this.sendWithRetry(sendParams, signal);
        } else {
          log.warn("AGENT", "上下文溢出且无法调整 maxTokens，触发自动压缩");
          await this.deps.autoCompact();
          callbacks.onCompact();
          continue;
        }
      }

      // 处理流式响应（记录 API 耗时）
      const perfHandle = getPerfTimer().start(`llm_request_${turns}`);
      // TTFT 计时（传递给 AfterModel hook，由 TelemetryHookProbe 消费）
      let ttftMs: number | undefined;
      const ttftStart = performance.now();

      let response: AccumulatedResponse;
      try {
        response = await this.deps.processStream(stream, (text) => {
          if (ttftMs === undefined) {
            ttftMs = performance.now() - ttftStart;
          }
          callbacks.onStreamText(text);
        });
      } catch (err: any) {
        perfHandle.end({ model: config.model });
        throw err;
      }
      const apiDuration = perfHandle.end({ model: config.model });

      // 更新 SessionState（成本权威源）
      sessionState.updateUsage(config.model, response.usage, apiDuration);
      const thisCost = sessionState.calculateCost(config.model, response.usage);

      // 计算缓存节省金额（供 AfterModel Hook 载荷传递）
      const cacheSavingsUSD = this.deps.tokenMeter
        ? this.deps.tokenMeter.calculateCacheSavings(config.model, response.usage)
        : 0;

      // Bug #4 修复：调用 quotaManager.recordRequest() 使 RPM/TPM 限速生效
      if (this.deps.quotaManager) {
        this.deps.quotaManager.recordRequest(
          response.usage.inputTokens + response.usage.outputTokens
        );
      }

      // 预算追踪器检查（需要同步返回 block 决策，不迁移到 Hook）
      if (this.deps.budgetTracker) {
        const budgetAlert = this.deps.budgetTracker.recordCost(thisCost, {
          model: config.model,
        });
        if (budgetAlert) {
          if (budgetAlert.level === "exceeded" && budgetAlert.action === "block") {
            callbacks.onStreamText(`\n⚠️ 预算规则 "${budgetAlert.ruleName}" 已超限（$${budgetAlert.currentUSD.toFixed(4)} / $${budgetAlert.limitUSD.toFixed(2)}），自动停止\n`);
            callbacks.onComplete(turns);
            return;
          } else if (budgetAlert.level === "critical" || budgetAlert.level === "warning") {
            const pct = (budgetAlert.percentage * 100).toFixed(0);
            callbacks.onStreamText(`\n⚠️ 预算规则 "${budgetAlert.ruleName}" 已达 ${pct}%（$${budgetAlert.currentUSD.toFixed(4)} / $${budgetAlert.limitUSD.toFixed(2)}）\n`);
          }
        }
      }

      // 成本配额检查
      if (this.deps.quotaManager) {
        const quotaResult = this.deps.quotaManager.check(sessionState.totalCostUSD);
        if (quotaResult) {
          if (quotaResult.level === "exceeded") {
            callbacks.onStreamText(`\n⚠️ ${quotaResult.message}\n`);
            callbacks.onComplete(turns);
            break;
          } else if (quotaResult.level === "critical" || quotaResult.level === "warning") {
            callbacks.onStreamText(`\n⚠️ ${quotaResult.message}\n`);
          }
        }
      }

      log.llmResponse(response.stopReason || "unknown", response.usage, apiDuration, sessionState.totalCostUSD);
      const totalUsage = sessionState.getTotalUsage();
      log.debug("AGENT", `累计用量: input=${totalUsage.inputTokens}, output=${totalUsage.outputTokens}, 费用=$${sessionState.totalCostUSD.toFixed(4)}`);

      // 记录 LLM 回复文本内容
      const responseText = response.content
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("");
      if (responseText) {
        log.llmResponseText(responseText);
      }

      // AfterModel hook：可修改响应、阻止响应
      if (this.deps.hookSystem) {
        const afterModelResult = await this.deps.hookSystem.fireAfterModelEvent(
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
            // 整合新增：成本与耗时（供 Hook 消费者使用）
            cost_usd: thisCost,
            api_duration_ms: apiDuration,
            cache_savings_usd: cacheSavingsUSD,
            ttft_ms: ttftMs,
          },
        );
        if (afterModelResult.finalOutput?.isBlockingDecision()) {
          log.info("HOOK", `AfterModel hook 阻止响应: ${afterModelResult.finalOutput.getEffectiveReason()}`);
          callbacks.onComplete(turns);
          break;
        }
        if (afterModelResult.finalOutput?.shouldStopExecution()) {
          log.info("HOOK", `AfterModel hook 停止执行: ${afterModelResult.finalOutput.getEffectiveReason()}`);
          callbacks.onComplete(turns);
          break;
        }
      }

      // 添加助手消息到历史
      ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
      });

      // 内容循环检测
      if (responseText && this.loopDetector.recordContent(responseText)) {
        const recovered = await this.recoverFromLoop(ctxMgr, callbacks, "内容重复模式");
        if (!recovered) break;
        continue;
      }

      // 检查停止原因
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        // AfterAgent hook：响应验证、上下文清除
        if (this.deps.hookSystem) {
          const afterResult = await this.deps.hookSystem.fireAfterAgentEvent(cleanedInput, responseText);
          // 检查是否需要清除上下文
          if (afterResult.finalOutput?.shouldClearContext()) {
            log.info("HOOK", "AfterAgent hook 请求清除上下文");
            ctxMgr.clear();
          }
          // 检查是否应停止执行
          if (afterResult.finalOutput?.shouldStopExecution()) {
            log.info("HOOK", `AfterAgent hook 停止执行: ${afterResult.finalOutput.getEffectiveReason()}`);
          }
        }

        const totalUsage = sessionState.getTotalUsage();
        log.info("AGENT", `对话结束 (${response.stopReason})，共 ${turns} 轮，in=${totalUsage.inputTokens} out=${totalUsage.outputTokens}，累计费用 $${sessionState.totalCostUSD.toFixed(4)}`);
        callbacks.onComplete(turns);
        break;
      }

      // 处理工具调用
      if (response.stopReason === "tool_use") {
        const toolBlocks = response.content.filter(b => b.type === "tool_use");
        const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "").filter(Boolean);
        log.info("AGENT", `工具调用: ${toolNames.join(", ")}`);

        // 工具调用循环检测
        let loopDetected = false;
        for (const b of toolBlocks) {
          if (b.type === "tool_use") {
            if (this.loopDetector.recordToolCall(b.name, b.input)) {
              loopDetected = true;
              break;
            }
          }
        }
        if (loopDetected) {
          const recovered = await this.recoverFromLoop(ctxMgr, callbacks, "工具调用重复");
          if (!recovered) {
            break;
          }
          continue;
        }

        // LLM 认知循环检测（30 轮后每 10 轮检测一次）
        if (this.loopDetector.shouldRunLLMCheck()) {
          const llmLoopDetected = await this.runLLMLoopCheck(ctxMgr, callbacks);
          if (llmLoopDetected) {
            const recovered = await this.recoverFromLoop(ctxMgr, callbacks, "LLM 认知检测到循环模式");
            if (!recovered) {
              break;
            }
            continue;
          }
        }

        for (const b of toolBlocks) {
          if (b.type === "tool_use") {
            callbacks.onToolStart(b.name, b.input);
          }
        }

        // Bug #6 修复：PerfTimer 使用带序号的名称，避免同名覆盖
        const toolPerfHandle = getPerfTimer().start(`tool_batch_${turns}`);
        let toolResults: ContentBlock[];
        try {
          toolResults = await this.deps.executeTools(response.content);
        } catch (err: any) {
          toolPerfHandle.end();
          // 用户取消：为悬空的 tool_use 补上取消的 tool_result，保持上下文一致性
          if (isAbortError(err)) {
            const cancelResults: ContentBlock[] = toolBlocks
              .filter((b): b is typeof b & { type: "tool_use" } => b.type === "tool_use")
              .map(b => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content: "用户取消了此工具调用",
                is_error: true,
              }));
            ctxMgr.addMessage({ role: "user", content: cancelResults });
            log.info("AGENT", "工具执行被用户取消，已补充取消的 tool_result");
          }
          throw err;
        }
        const toolBatchElapsed = toolPerfHandle.end();
        ctxMgr.addMessage({ role: "user", content: toolResults });

        // 注意：addToolDuration 已在 app.ts executeSingleTool 中逐工具调用，此处不再重复

        // Bug #1 修复：循环记录每个工具的指标（而非只记录最后一个）
        // 将 toolResults 按 tool_use_id 与 toolBlocks 配对
        const resultMap = new Map<string, ContentBlock>();
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

          callbacks.onToolEnd(b.name, { isError, elapsedMs: perToolDuration });
        }
        continue;
      }

      // max_tokens 续写
      if (response.stopReason === "max_tokens" || response.stopReason === "length") {
        log.info("AGENT", `输出达到 token 上限 (maxTokens=${config.maxTokens})，自动续写 (轮次 ${turns}，本次 out=${response.usage.outputTokens})`);
        continue;
      }

      // 其他停止原因
      log.warn("AGENT", `未知停止原因: ${response.stopReason}，in=${response.usage.inputTokens} out=${response.usage.outputTokens}`);
      callbacks.onComplete(turns);
      break;
    }

    if (turns >= maxTurns) {
      log.warn("AGENT", `达到最大轮次限制: ${maxTurns}`);
      callbacks.onMaxTurns?.(maxTurns);
    }
  }
}
