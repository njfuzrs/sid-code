/**
 * QueryEngine — 会话层
 *
 * 职责：
 * - 用户输入预处理（hook 拦截、thinking hint 解析）
 * - 会话状态管理（消息历史、用量统计）
 * - 消费 queryLoop 的 yield，桥接到外部回调
 * - 流式文本的回调桥接（processStream 内部的 onText → 外部回调）
 *
 * 接口：submitMessage() → AsyncGenerator<QueryEngineEvent>
 */

import type { Provider } from "../llm/provider.ts";
import type {
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "../llm/types.ts";
import type { Config } from "../config/config.ts";
import type { HookSystem } from "../hook/system.ts";
import type { QuotaManager } from "../llm/quota.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import type { BudgetTracker } from "../telemetry/metrics/budget-tracker.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { ModelFallback } from "../llm/fallback.ts";
import { ThinkingManager } from "../llm/thinking.ts";
import { SessionState } from "../session/state.ts";
import { getLogger, getSessionMetrics } from "../debug/index.ts";
import { queryLoop } from "./loop.ts";
import type { QueryDeps, QueryEngineEvent } from "./types.ts";

/** QueryEngine 依赖 */
export interface QueryEngineDeps {
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
  /** 执行工具调用（含权限检查）。返回 results + 可选 followup（ADR-019） */
  executeTools: (content: ContentBlock[]) => Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }>;
  /** 处理流式响应。onThinking 对标 Claude Code 的独立思考流通道 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
    onThinking?: (text: string) => void,
  ) => Promise<AccumulatedResponse>;
  /** 自动压缩 */
  autoCompact: () => Promise<void>;
  /** 处理上下文溢出 */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
  /** Plan Mode 系统提醒（对标 Claude Code 每轮 system-reminder 注入） */
  getPlanModeReminder?: () => Promise<string | null>;
}

export class QueryEngine {
  private deps: QueryEngineDeps;
  /** 流式文本回调（由 submitMessage 的消费者设置） */
  private streamTextCallback: ((text: string) => void) | null = null;
  /** v2：流式思考回调（对标 Claude Code 的独立思考流通道） */
  private streamThinkingCallback: ((text: string) => void) | null = null;

  constructor(deps: QueryEngineDeps) {
    this.deps = deps;
  }

  /** 更新 Provider（模型切换时调用） */
  updateProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** 更新 TokenMeter（遥测启用后重建） */
  updateTokenMeter(tokenMeter: TokenMeter): void {
    this.deps.tokenMeter = tokenMeter;
  }

  /**
   * 提交用户消息，返回 async generator 供外部消费
   *
   * 使用方式：
   * ```ts
   * for await (const event of engine.submitMessage(input)) {
   *   switch (event.kind) {
   *     case "stream_text": handleText(event.text); break;
   *     case "tool_start": handleToolStart(event.toolName); break;
   *     // ...
   *   }
   * }
   * ```
   */
  async *submitMessage(
    userInput: string,
    options?: { thinking?: { enabled: boolean; budgetTokens: number } },
  ): AsyncGenerator<QueryEngineEvent> {
    const log = getLogger();
    const { config, ctxMgr, toolRegistry, sessionState, hookSystem } = this.deps;

    log.info("ENGINE", `用户输入: ${userInput.slice(0, 200)}${userInput.length > 200 ? "..." : ""}`);

    // 记录用户提示
    getSessionMetrics().recordPrompt();

    // 新一轮对话开始，重置模型可用性的 retry_once 标记
    this.deps.fallback.getAvailability().resetTurn();

    // ─── user_prompt_submit hook ───
    let finalInput = userInput;
    if (hookSystem) {
      const hookResult = await hookSystem.fireUserPromptSubmitEvent(userInput);
      if (hookResult.finalOutput?.isBlockingDecision()) {
        log.info("HOOK", `用户输入被 hook 阻止: ${hookResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "hook_blocked", reason: hookResult.finalOutput.getEffectiveReason() };
        return;
      }
      if (hookResult.finalOutput?.shouldStopExecution()) {
        log.info("HOOK", `用户输入被 hook 停止: ${hookResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "hook_blocked", reason: hookResult.finalOutput.getEffectiveReason() };
        return;
      }
      const additionalCtx = hookResult.finalOutput?.getAdditionalContext();
      if (additionalCtx) {
        log.info("HOOK", `用户输入被 hook 追加上下文`);
        finalInput = userInput + "\n\n" + additionalCtx;
      }
    }

    // ─── 解析 thinking hint ───
    const { cleaned: cleanedInput, config: thinkingConfig } =
      this.deps.thinkingMgr.parseThinkingHint(finalInput);
    const _thinking = options?.thinking ?? thinkingConfig ?? this.deps.thinkingMgr.getThinkingConfig(cleanedInput);

    // ─── 添加用户消息 ───
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: cleanedInput }],
    });
    yield { kind: "user_message_added" };

    // ─── 构建 queryLoop 依赖 ───
    const queryDeps: QueryDeps = {
      sendWithRetry: (params: SendParams, signal?: AbortSignal) => {
        this.deps.fallback.reset();
        return this.deps.fallback.executeWithFallback(this.deps.provider, params, signal);
      },
      processStream: (stream, onText, onThinking) => {
        // 桥接：将 processStream 内部的 onText/onThinking 回调转发给外部
        return this.deps.processStream(
          stream,
          (text) => {
            this.streamTextCallback?.(text);
            onText?.(text);
          },
          (thinking) => {
            this.streamThinkingCallback?.(thinking);
            onThinking?.(thinking);
          },
        );
      },
      executeTools: this.deps.executeTools,
      autoCompact: this.deps.autoCompact,
      handleContextOverflow: this.deps.handleContextOverflow,
      getAbortSignal: this.deps.getAbortSignal,
      uuid: () => crypto.randomUUID(),
      checkFallbackOccurred: () => this.deps.fallback.checkFallbackOccurred(),
      resetFallbackFlag: () => this.deps.fallback.reset(),
      getPlanModeReminder: this.deps.getPlanModeReminder,
    };

    // ─── 启动 queryLoop ───
    const loop = queryLoop({
      config,
      ctxMgr,
      toolRegistry,
      sessionState,
      fallback: this.deps.fallback,
      hookSystem,
      quotaManager: this.deps.quotaManager,
      tokenMeter: this.deps.tokenMeter,
      budgetTracker: this.deps.budgetTracker,
      deps: queryDeps,
    });

    // ─── 消费 queryLoop 的 yield，桥接到外部 ───
    for await (const event of loop) {
      yield event;
      if (event.kind === "done") {
        return;
      }
    }
  }

  /**
   * 设置流式文本回调
   * 由于 processStream 是 Promise（非 generator），无法直接 yield 流式文本。
   * 通过此回调桥接：processStream 内部 onText → 此回调 → 外部消费者
   */
  setStreamTextCallback(cb: ((text: string) => void) | null): void {
    this.streamTextCallback = cb;
  }

  /**
   * 设置流式思考回调（v2：对标 Claude Code 的独立思考流通道）
   * 通过此回调桥接：processStream 内部 onThinking → 此回调 → 外部消费者（TUI）
   */
  setStreamThinkingCallback(cb: ((text: string) => void) | null): void {
    this.streamThinkingCallback = cb;
  }
}
