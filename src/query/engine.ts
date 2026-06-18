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
import { isAbortError } from "../llm/errors.ts";
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
  /** B2：会话持久化写入端（增量写入 user/assistant/tool_result 消息）。可选——未注入则不持久化 */
  sessionStore?: import("../session/store.ts").SessionStore;
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
  /** 主动中断当前 LLM 请求（abort 当前 AbortController）。L1 单轮硬超时配合使用。可选。 */
  abortCurrentRequest?: (reason?: string) => void;
  /** Plan Mode 系统提醒（对标 Claude Code 每轮 system-reminder 注入） */
  getPlanModeReminder?: () => Promise<string | null>;
  /** P0-2 / P0-3：读取 todo 状态快照（回注 + 完成度校验用） */
  getTodoState?: () => { todos: import("../tool/todo-write.ts").TodoItem[]; writeVersion: number } | null;
}

export class QueryEngine {
  private deps: QueryEngineDeps;
  /** 流式文本回调（由 submitMessage 的消费者设置） */
  private streamTextCallback: ((text: string) => void) | null = null;
  /** v2：流式思考回调（对标 Claude Code 的独立思考流通道） */
  private streamThinkingCallback: ((text: string) => void) | null = null;
  /**
   * Step 0：Session Memory 句柄（由 App 在 doInit 接线后注入）。
   * queryLoop 每轮收尾触发提取（updateSessionMemory）+ 工具调用计数（recordToolCall）。
   */
  private sessionMemory: import("../session-memory/session-memory.ts").SessionMemoryHandle | null = null;

  constructor(deps: QueryEngineDeps) {
    this.deps = deps;
  }

  /** 更新 Provider（模型切换时调用） */
  updateProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** Step 0：注入 Session Memory 句柄（App 接线后调用，可传 null 关闭）。 */
  setSessionMemory(
    handle: import("../session-memory/session-memory.ts").SessionMemoryHandle | null,
  ): void {
    this.sessionMemory = handle;
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
    const { config, ctxMgr, toolRegistry, sessionState, hookSystem, sessionStore } = this.deps;

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
    // 修复 §2.2：旧实现解析出 _thinking 后从未传递到 sendParams——
    // think hard / ultrathink 完全失效，DeepSeek reasoning_effort 永不下发。
    // 现经 queryDeps.getThinkingConfig 注入 queryLoop。
    const { cleaned: cleanedInput, config: thinkingConfig } =
      this.deps.thinkingMgr.parseThinkingHint(finalInput);
    const thinking = options?.thinking ?? thinkingConfig ?? this.deps.thinkingMgr.getThinkingConfig(cleanedInput);

    // ─── 添加用户消息 ───
    // B2：API 调用前先持久化 user 消息（对标 claude-code：进程中途被 kill 也可 resume）。
    // 持久化失败绝不能阻断主流程，故 try/catch 吞掉异常。
    const userMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: cleanedInput }],
    };
    try {
      sessionStore?.appendMessage(userMessage);
    } catch (e) {
      log.warn("ENGINE", `用户消息持久化失败（不阻断）: ${(e as Error)?.message}`);
    }
    ctxMgr.addMessage(userMessage);
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
      abortCurrentRequest: this.deps.abortCurrentRequest,
      uuid: () => crypto.randomUUID(),
      checkFallbackOccurred: () => this.deps.fallback.checkFallbackOccurred(),
      resetFallbackFlag: () => this.deps.fallback.reset(),
      getPlanModeReminder: this.deps.getPlanModeReminder,
      getTodoState: this.deps.getTodoState,
      sessionStore: this.deps.sessionStore,
      // Step 0：Session Memory 每轮收尾钩子（fire-and-forget，内部按双阈值决定是否提取）。
      updateSessionMemory: this.sessionMemory
        ? () => this.sessionMemory!.updateSessionMemory()
        : undefined,
      recordSessionMemoryToolCall: this.sessionMemory
        ? () => this.sessionMemory!.recordToolCall()
        : undefined,
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
      // 把解析出的 thinking 配置下传给 queryLoop → SendParams（修复 _thinking 历史断链）。
      thinking,
      deps: queryDeps,
    });

    // ─── 消费 queryLoop 的 yield，桥接到外部 ───
    // §3.2（fdb47f30）：外层 try-catch 隔离 queryLoop 内部异常（如 processStream throw）。
    // 原先无外层 catch，异常会穿透 for-await，跳过下方 done 收尾逻辑——上层 app 只能靠
    // 模糊的 finally "任务异常中断" 提示，拿不到具体错误。现把底层异常统一封装为
    // fatal_error 事件走 yield 通道，让 app 层能持久化展示具体原因（联动 §3.3），
    // 且 abort（用户 ESC）仍原样向上抛出（由 app 的 onUserInput catch 按"已取消"处理）。
    try {
      for await (const event of loop) {
        // B2：持久化 assistant 消息。queryLoop 每次 ctxMgr.addMessage(assistant) 后都紧跟
        // yield assistant_message，故此处写入与内存历史一一对应（含空参数 sanitized、降级前等
        // 已入历史的中间态——持久化与内存保持一致，恢复时状态对齐）。tool_result 由 queryLoop
        // 内部经注入的 sessionStore 直接写入（方案 a），不在此处理。
        // ⚠️ 修正 bug①：endSession 绝不放在此循环/finally——它每轮用户输入调用一次，
        // 会写 session_end 并置 currentFile=null，导致第 2 轮起所有消息静默丢失。
        // endSession 只在 App 退出时调用一次（B3）。
        if (event.kind === "assistant_message") {
          try {
            sessionStore?.appendMessage(event.message);
          } catch (e) {
            log.warn("ENGINE", `assistant 消息持久化失败（不阻断）: ${(e as Error)?.message}`);
          }
        }
        yield event;
        if (event.kind === "done") {
          return;
        }
      }
    } catch (err) {
      // 用户主动中断（ESC）：原样向上抛，由 app 的 onUserInput catch 按"已取消"处理，
      // 不转 fatal_error（中断不是故障）。
      if (isAbortError(err)) {
        throw err;
      }
      // 真异常：封装为 fatal_error 事件 yield（而非穿透），让上层收尾可达 + 展示具体原因。
      const e = err as Error;
      log.error("ENGINE", `queryLoop 异常，封装为 fatal_error: ${e?.message}`, { stack: e?.stack });
      yield {
        kind: "fatal_error",
        message: e?.message ?? String(err),
        stack: e?.stack,
        recoverable: false,
      };
      return;
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
