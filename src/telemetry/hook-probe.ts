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
  PermissionCheckInput,
  HookExecutionInput,
  SubagentStartInput,
  SubagentStopInput,
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

  /** blocked_on_user span 暂存：key = tool_use_id || tool_name */
  private permissionSpans = new Map<string, SpanHandle>();
  /** hook_execution span 暂存：key = hook_name */
  private hookSpans = new Map<string, SpanHandle>();

  /** invoke_agent 子 span 暂存：key = agent_id（子代理 start/stop 配对） */
  private subagentSpans = new Map<string, SpanHandle>();

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
      // spec 17 §6.1.3 增强追踪树：权限等待 + Hook 执行 span
      HookEventName.BeforePermissionCheck,
      HookEventName.AfterPermissionCheck,
      HookEventName.BeforeHookExecution,
      HookEventName.AfterHookExecution,
      // 子代理生命周期：按 model 单独计费 + invoke_agent 子 span
      HookEventName.SubagentStart,
      HookEventName.SubagentStop,
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
      case HookEventName.BeforePermissionCheck:
        this.handleBeforePermissionCheck(input as PermissionCheckInput);
        break;
      case HookEventName.AfterPermissionCheck:
        this.handleAfterPermissionCheck(input as PermissionCheckInput);
        break;
      case HookEventName.BeforeHookExecution:
        this.handleBeforeHookExecution(input as HookExecutionInput);
        break;
      case HookEventName.AfterHookExecution:
        this.handleAfterHookExecution(input as HookExecutionInput);
        break;
      case HookEventName.SubagentStart:
        this.handleSubagentStart(input as SubagentStartInput);
        break;
      case HookEventName.SubagentStop:
        this.handleSubagentStop(input as SubagentStopInput);
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

  // ---- spec 17 §6.1.3：权限等待 / Hook 执行 span ----

  private permissionKey(input: PermissionCheckInput): string {
    return input.tool_use_id || input.tool_name;
  }

  private handleBeforePermissionCheck(input: PermissionCheckInput): void {
    const span = this.bus.startSpan(
      "blocked_on_user",
      `blocked_on_user ${input.tool_name}`,
      {
        [ATTR.OPERATION_NAME]: "blocked_on_user",
        [ATTR.TOOL_NAME]: input.tool_name,
        ...(input.tool_use_id ? { [ATTR.TOOL_CALL_ID]: input.tool_use_id } : {}),
        ...this.collectEnrichedAttributes("execute_tool", input) as Attributes,
      },
    );
    this.permissionSpans.set(this.permissionKey(input), span);
  }

  private handleAfterPermissionCheck(input: PermissionCheckInput): void {
    const key = this.permissionKey(input);
    const span = this.permissionSpans.get(key);
    if (span) {
      span.end();
      this.permissionSpans.delete(key);
    }
  }

  private handleBeforeHookExecution(input: HookExecutionInput): void {
    const span = this.bus.startSpan(
      "hook_execution",
      `hook_execution ${input.hook_name}`,
      {
        [ATTR.OPERATION_NAME]: "hook_execution",
        "sidcode.hook.name": input.hook_name,
        ...(input.triggering_event
          ? { "sidcode.hook.triggering_event": input.triggering_event }
          : {}),
      },
    );
    this.hookSpans.set(input.hook_name, span);
  }

  private handleAfterHookExecution(input: HookExecutionInput): void {
    const span = this.hookSpans.get(input.hook_name);
    if (span) {
      span.end();
      this.hookSpans.delete(input.hook_name);
    }
  }

  // ---- 子代理生命周期 span（按 model 分类，单独计费） ----

  private handleSubagentStart(input: SubagentStartInput): void {
    const model = input.model ?? this.config.model;
    const span = this.bus.startSpan("invoke_agent", `invoke_agent ${input.agent_type}`, {
      [ATTR.OPERATION_NAME]: "invoke_agent",
      [ATTR.AGENT_NAME]: `subagent:${input.agent_type}`,
      [ATTR.CONVERSATION_ID]: this.config.sessionId,
      [ATTR.REQUEST_MODEL]: model,
      ...(input.provider ? { [ATTR.PROVIDER_NAME]: input.provider } : {}),
      "sidcode.subagent.id": input.agent_id,
      "sidcode.subagent.type": input.agent_type,
      ...this.collectEnrichedAttributes("invoke_agent", input) as Attributes,
    });
    this.subagentSpans.set(input.agent_id, span);
  }

  private handleSubagentStop(input: SubagentStopInput): void {
    const key = input.agent_id;
    const span = key ? this.subagentSpans.get(key) : undefined;
    const usage = input.usage;

    // 子代理用量记入 TokenMeter（按 model 单独计费，与主循环 chat span 同一口径）。
    if (usage && this.tokenMeter) {
      this.tokenMeter.record({
        model: input.model ?? this.config.model,
        provider: input.provider ?? this.config.provider,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        },
        costUSD: 0, // 子代理无独立 cost 字段，TokenMeter 内部按 model 定价回算
        sessionId: this.config.sessionId,
      });
    }

    if (span) {
      span.setAttributes({
        [ATTR.SUCCESS]: input.success ?? true,
        ...(usage ? {
          [ATTR.INPUT_TOKENS]: usage.inputTokens ?? 0,
          [ATTR.OUTPUT_TOKENS]: usage.outputTokens ?? 0,
          [ATTR.CACHE_READ_TOKENS]: usage.cacheReadInputTokens ?? 0,
          [ATTR.CACHE_CREATION_TOKENS]: usage.cacheCreationInputTokens ?? 0,
        } : {}),
        ...(input.turns !== undefined ? { [ATTR.TOTAL_TURNS]: input.turns } : {}),
        ...(input.duration_ms !== undefined ? { "sidcode.subagent.duration_ms": input.duration_ms } : {}),
        ...this.collectEnrichedAttributes("invoke_agent", input) as Attributes,
      });
      span.end();
      if (key) this.subagentSpans.delete(key);
    }
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
