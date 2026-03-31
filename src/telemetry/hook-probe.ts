/**
 * TelemetryHookProbe —— 通过 Hook 事件驱动的遥测探针
 *
 * 替代 loop.ts 中硬编码的 telemetry span 创建逻辑，
 * 统一从 Hook 载荷中获取数据，同时提供 SpanEnricher 扩展机制供 Harness 注入自定义属性。
 */

import type { HookSystem } from "../hook/system.ts";
import type { TelemetryBus } from "./bus.ts";
import type { SpanHandle } from "./bus.ts";
import type { TokenMeter } from "./metrics/token-meter.ts";
import type { Attributes } from "./types.ts";
import { ATTR } from "./types.ts";
import { HookEventName } from "../hook/types.ts";
import type {
  HookInput,
  BeforeModelInput,
  AfterModelInput,
  PostToolUseInput,
  SessionStartInput,
  SessionEndInput,
} from "../hook/types.ts";

/**
 * Span 属性扩展器：从 Hook 载荷中提取额外属性注入到 Span
 * Harness 模块通过 registerSpanEnricher() 注册，probe 在创建/结束 span 时自动调用
 */
export type SpanEnricher = (
  spanKind: "invoke_agent" | "chat" | "execute_tool",
  input: HookInput,
) => Record<string, unknown>;

export class TelemetryHookProbe {
  private agentSpan: SpanHandle | undefined;
  private llmSpan: SpanHandle | undefined;
  private turns = 0;

  /** Harness 扩展点：Span 属性注入器列表 */
  private spanEnrichers: SpanEnricher[] = [];

  constructor(
    private bus: TelemetryBus,
    private tokenMeter: TokenMeter | null,
    private config: { model: string; provider: string; sessionId: string },
  ) {}

  /** 注册 Span 属性扩展器（Harness 模块调用） */
  registerSpanEnricher(fn: SpanEnricher): void {
    this.spanEnrichers.push(fn);
  }

  /** 收集所有 enricher 产出的属性，enricher 出错不影响主流程 */
  private collectEnrichedAttributes(
    spanKind: "invoke_agent" | "chat" | "execute_tool",
    input: HookInput,
  ): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    for (const fn of this.spanEnrichers) {
      try {
        Object.assign(attrs, fn(spanKind, input));
      } catch {
        // enricher 出错静默忽略
      }
    }
    return attrs;
  }

  /** 注册为 runtime hook，监听 5 种事件 */
  registerHooks(hookSystem: HookSystem): void {
    const events = [
      HookEventName.SessionStart,
      HookEventName.BeforeModel,
      HookEventName.AfterModel,
      HookEventName.PostToolUse,
      HookEventName.SessionEnd,
    ];
    for (const eventName of events) {
      hookSystem.registerHook(
        {
          type: "runtime",
          name: `telemetry-probe-${eventName}`,
          action: async (input: HookInput) => {
            await this.handleEvent(input);
          },
        },
        eventName,
        { source: "runtime" as any },
      );
    }
  }

  private async handleEvent(input: HookInput): Promise<void> {
    if (!this.bus.isEnabled()) return;
    switch (input.hook_event_name) {
      case HookEventName.SessionStart:
        this.handleSessionStart(input as SessionStartInput);
        break;
      case HookEventName.BeforeModel:
        this.handleBeforeModel(input as BeforeModelInput);
        break;
      case HookEventName.AfterModel:
        this.handleAfterModel(input as AfterModelInput);
        break;
      case HookEventName.PostToolUse:
        this.handlePostToolUse(input as PostToolUseInput);
        break;
      case HookEventName.SessionEnd:
        this.handleSessionEnd(input as SessionEndInput);
        break;
    }
  }

  private handleSessionStart(input: SessionStartInput): void {
    // 创建顶层 invoke_agent span
    this.bus.startTrace();
    this.agentSpan = this.bus.startSpan("invoke_agent", `invoke_agent ${this.config.model}`, {
      [ATTR.OPERATION_NAME]: "invoke_agent",
      [ATTR.AGENT_NAME]: "sid-code",
      [ATTR.CONVERSATION_ID]: this.config.sessionId,
      [ATTR.REQUEST_MODEL]: this.config.model,
      [ATTR.CWD]: input.cwd,
      ...this.collectEnrichedAttributes("invoke_agent", input) as Attributes,
    });
  }

  private handleBeforeModel(input: BeforeModelInput): void {
    this.turns++;
    this.llmSpan = this.bus.startSpan("chat", `chat ${input.llm_request.model}`, {
      [ATTR.OPERATION_NAME]: "chat",
      [ATTR.PROVIDER_NAME]: this.config.provider,
      [ATTR.REQUEST_MODEL]: input.llm_request.model,
      [ATTR.TURN_NUMBER]: this.turns,
      ...this.collectEnrichedAttributes("chat", input) as Attributes,
    });
  }

  private handleAfterModel(input: AfterModelInput): void {
    const usage = input.llm_response.usage;
    if (!usage) return;

    // TTFT：如果载荷中有 ttft_ms，记录为 span event
    if (input.llm_response.ttft_ms !== undefined && this.llmSpan) {
      this.llmSpan.addEvent("gen_ai.first_token", {
        ttft_ms: input.llm_response.ttft_ms,
      });
    }

    // 记录到 TokenMeter
    if (this.tokenMeter) {
      this.tokenMeter.record({
        model: input.llm_request.model,
        provider: this.config.provider,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        },
        costUSD: input.llm_response.cost_usd ?? 0,
        sessionId: this.config.sessionId,
      });
    }

    // 结束 chat span，附加属性
    const enriched = this.collectEnrichedAttributes("chat", input);
    this.llmSpan?.setAttributes({
      [ATTR.INPUT_TOKENS]: usage.inputTokens ?? 0,
      [ATTR.OUTPUT_TOKENS]: usage.outputTokens ?? 0,
      [ATTR.CACHE_READ_TOKENS]: usage.cacheReadInputTokens ?? 0,
      [ATTR.CACHE_CREATION_TOKENS]: usage.cacheCreationInputTokens ?? 0,
      [ATTR.FINISH_REASONS]: input.llm_response.stop_reason ?? "unknown",
      [ATTR.COST_USD]: input.llm_response.cost_usd ?? 0,
      [ATTR.CACHE_SAVINGS_USD]: input.llm_response.cache_savings_usd ?? 0,
      ...enriched as Attributes,
    });
    this.llmSpan?.end();
    this.llmSpan = undefined;
  }

  private handlePostToolUse(input: PostToolUseInput): void {
    // 注意：此 span 在 PostToolUse 事件中创建并立即结束，span.durationMs ≈ 0，
    // 不反映工具的真实执行耗时。真实耗时通过 sidcode.tool.duration_ms 属性记录。
    const enriched = this.collectEnrichedAttributes("execute_tool", input);
    const toolSpan = this.bus.startSpan("execute_tool", `execute_tool ${input.tool_name}`, {
      [ATTR.OPERATION_NAME]: "execute_tool",
      [ATTR.TOOL_NAME]: input.tool_name,
      [ATTR.TOOL_CALL_ID]: input.tool_use_id ?? "",
      [ATTR.SUCCESS]: !input.is_error,
      ...enriched as Attributes,
    });
    // 如果有真实耗时，记录为属性
    if (input.duration_ms !== undefined) {
      toolSpan.setAttribute("sidcode.tool.duration_ms", input.duration_ms);
    }
    if (input.is_error) {
      toolSpan.recordError(new Error(JSON.stringify(input.tool_response).slice(0, 200)));
    }
    toolSpan.end();
  }

  private handleSessionEnd(input: SessionEndInput): void {
    const stats = input.stats;
    if (this.agentSpan && stats) {
      this.agentSpan.setAttributes({
        [ATTR.TOTAL_TURNS]: this.turns,
        [ATTR.TOTAL_COST_USD]: stats.total_cost_usd ?? 0,
        [ATTR.INPUT_TOKENS]: stats.total_tokens_sent ?? 0,
        [ATTR.OUTPUT_TOKENS]: stats.total_tokens_received ?? 0,
        ...this.collectEnrichedAttributes("invoke_agent", input) as Attributes,
      });
    }
    this.agentSpan?.end();
    this.agentSpan = undefined;
  }
}
