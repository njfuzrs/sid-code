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
import { currentSpanScope } from "./span-scope.ts";
import type { Attributes } from "./types.ts";
import { ATTR } from "./types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import {
  addRequestContent,
  addResponseContent,
  addToolContent,
  maskedErrorSummary,
  sanitizedToolName,
} from "./content-tracing.ts";
import { clearPendingRootSpan, writePendingRootSpan } from "./root-span-recovery.ts";
import { HookEventName } from "../hook/types.ts";
import type {
  HookInput,
  BeforeModelInput,
  AfterModelInput,
  PostToolUseInput,
  PermissionDeniedInput,
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

/** 主循环的 chat span key（子代理用各自的 agentId） */
const MAIN_SCOPE = "__main__";

export class TelemetryHookProbe {
  private agentSpan: SpanHandle | undefined;
  /**
   * 进行中的 chat span：key = 子代理 agentId（主循环为 MAIN_SCOPE）。
   * 曾是单个字段：并发子代理的 BeforeModel 会互相覆盖（缺陷 2），覆盖掉的那个永不 end（缺陷 3）。
   */
  private llmSpans = new Map<string, SpanHandle>();
  private turns = 0;

  /** blocked_on_user span 暂存：key = tool_use_id || tool_name */
  private permissionSpans = new Map<string, SpanHandle>();
  /** hook_execution span 暂存：key = hook_name */
  private hookSpans = new Map<string, SpanHandle>();

  /** invoke_agent 子 span 暂存：key = agent_id（子代理 start/stop 配对） */
  private subagentSpans = new Map<string, SpanHandle>();

  /**
   * §三 P0-2：本会话「欠一次 end 的根 span」标记所用的轨迹会话 id。
   *
   * 与 `config.sessionId` 可能不同（resume 时是 `resumed_from`），所以要单独记住 ——
   * 删标记时必须用与写时**完全相同**的 key，否则正常收尾的会话也会残留标记，
   * 下次启动重建出一个重复的根。
   */
  private pendingRootSessionId: string | undefined;

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

  /** 注册为 runtime hook，监听下列事件（数量以 events 数组为准，勿在注释里写死） */
  registerHooks(hookSystem: HookSystem): void {
    const events = [
      HookEventName.SessionStart,
      HookEventName.BeforeModel,
      HookEventName.AfterModel,
      HookEventName.PostToolUse,
      // 失败工具同样要产 execute_tool span：此前只订阅 PostToolUse，导致
      // ① tool.execute 抛异常、② hook 阻止、③ 权限拒绝、④ 参数校验失败
      // 这四类失败在 trace 树上**完全不存在**（span 是在 handlePostToolUse 里创建的），
      // 失败率统计也不计入。排查时表现为"模型报错了但轨迹里查不到这次工具调用"
      // （会话 20260803-135816-8c8619e7 的 ask_user_question 校验失败即如此）。
      HookEventName.PostToolUseFailure,
      // Q7：权限拒绝不再 fire PostToolUseFailure，execute_tool span 改由 PermissionDenied 产出
      //（status=denied，不计工具失败）
      HookEventName.PermissionDenied,
      HookEventName.SessionEnd,
      // spec 17 §6.1.3 增强追踪树：权限等待 + Hook 执行 span。
      // ⚠️ 预留：这 4 个事件全仓无 fire 点，订阅了也恒不触发，blocked_on_user /
      // hook_execution 两类 span 当前不产生（见 types.ts SpanKind 注释）。保留订阅是为了
      // 接线时不用再改这里；别把「已订阅」读成「已接线」。
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
      // PostToolUseFailure 复用同一 handler：它的 input 也是 PostToolUseInput
      // （event-handler 构造时带 is_error:true + tool_response:{error}），
      // handlePostToolUse 已按 is_error 分流（success 属性 + recordError），无需另写分支。
      case HookEventName.PostToolUseFailure:
        this.handlePostToolUse(input as PostToolUseInput);
        break;
      case HookEventName.PermissionDenied:
        this.handlePermissionDenied(input as PermissionDeniedInput);
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

  /**
   * 当前异步链所在子代理的 span 作为 parent（缺陷 2）。
   *
   * 在子代理作用域里（span-scope.ts）：显式挂到该子代理的 invoke_agent 下且不进共享栈 ——
   * 并发子代理各走各的链，互不可见。主循环里返回 undefined，沿用 TraceContext 栈（串行）。
   */
  private scopedParent(): { parentSpanId: string; detached: true } | undefined {
    const scope = currentSpanScope();
    const span = scope ? this.subagentSpans.get(scope) : undefined;
    return span ? { parentSpanId: span.spanId, detached: true } : undefined;
  }

  private llmKey(): string {
    return currentSpanScope() ?? MAIN_SCOPE;
  }

  private handleSessionStart(input: SessionStartInput): void {
    // 创建顶层 invoke_agent span。
    // 名字按 OTel GenAI 约定取 `invoke_agent {gen_ai.agent.name}`（曾用模型名：
    // 那会让同一个 agent 换个模型就成了另一种操作，后端按 span 名聚合时被拆散）。
    // 模型仍在 gen_ai.request.model 属性上，不丢信息。
    const traceContext = this.bus.startTrace();
    const name = "invoke_agent sid-code";
    const attributes: Attributes = {
      [ATTR.OPERATION_NAME]: "invoke_agent",
      [ATTR.AGENT_NAME]: "sid-code",
      [ATTR.CONVERSATION_ID]: this.config.sessionId,
      [ATTR.REQUEST_MODEL]: this.config.model,
      [ATTR.CWD]: input.cwd,
      ...(this.collectEnrichedAttributes("invoke_agent", input) as Attributes),
    };
    this.agentSpan = this.bus.startSpan("invoke_agent", name, attributes);

    // ── §三 P0-2：落「这个根还欠一次 end」的标记 ──
    //
    // 根 span 只在下面 handleSessionEnd 里 end() 入队，而实测 54% 的会话没有
    // SessionEnd（50 : 23），39% 不是正常收尾。也就是说会话级根节点在最不可靠的
    // 时刻才落盘，而可观测性最需要看的恰好是没正常结束的那些会话。
    //
    // 标记里存的是**身份**（traceId / spanId），不是统计值。理由见
    // root-span-recovery.ts 头部：events.jsonl 里没有 span 身份，而子 span 早已把
    // 运行时这个 spanId 写成自己的 parentSpanId 落盘了（实测 traces.jsonl 有 680 个
    // 解析不到父的 parentSpanId）。只从 events 重建、给根一个新 spanId 的话，
    // 孤儿子 span 照旧悬空、盘上再多一个谁也不挂的根 —— PR2 的判据①②依然全红。
    //
    // 会话正常收尾时标记被删（见 handleSessionEnd），所以正常路径零额外落盘。
    this.pendingRootSessionId = this.resolveTraceSessionId(input);
    try {
      writePendingRootSpan({
        session_id: this.pendingRootSessionId,
        trace_id: traceContext.traceId,
        span_id: this.agentSpan.spanId,
        name,
        start_time: Date.now(),
        attributes,
        pid: process.pid,
      });
    } catch {
      // 标记写不出去只意味着「这个会话崩了就没有根 span」，退化到改动前的行为，
      // 绝不能让采集设施本身成为启动失败的原因。
    }
  }

  /**
   * 标记要用**轨迹会话 id**（`trajectories/sessions/<它>/` 的目录名），因为重建时
   * 要按它去找 events.jsonl。
   *
   * resume 续接时该目录名是 `resumed_from`（被恢复的旧 id）而非本进程 id ——
   * 与 `trace/collector.ts:handleSessionStart` 的 `traceSessionId` 同口径。
   * 用错就会按新 id 去找目录、找不到、静默退化成「无素材重建」。
   */
  private resolveTraceSessionId(input: SessionStartInput): string {
    if (input.source === "resume" && input.resumed_from) return input.resumed_from;
    return this.config.sessionId;
  }

  private handleBeforeModel(input: BeforeModelInput): void {
    // 缺陷 3：上一轮的 chat span 还没 end ⇒ 那一轮的 AfterModel 没 fire（流中途抛异常 / abort）。
    // 不收掉的话它永不入队，且 spanId 永久留在 traceContext 栈里，此后所有 span 都挂在
    // 这个盘上不存在的幽灵 parent 下。
    const key = this.llmKey();
    this.abandonLlmSpan(key, "after_model_not_fired");
    this.turns++;
    const llmSpan = this.bus.startSpan(
      "chat",
      `chat ${input.llm_request.model}`,
      {
        [ATTR.OPERATION_NAME]: "chat",
        [ATTR.PROVIDER_NAME]: this.config.provider,
        [ATTR.REQUEST_MODEL]: input.llm_request.model,
        [ATTR.TURN_NUMBER]: this.turns,
        ...(this.collectEnrichedAttributes("chat", input) as Attributes),
      },
      this.scopedParent(),
    );
    this.llmSpans.set(key, llmSpan);

    // 内容级 tracing（P1-5）：默认关闭，四道闸门见 content-tracing.ts。
    // 挂在这里而不是 loop.ts：BeforeModel 载荷已经带齐 system / tools / raw_messages，
    // 无需为了采内容去改 LLM 调用链——采集器不该侵入被采集的链路。
    addRequestContent(llmSpan, {
      system: input.llm_request.system,
      tools: input.llm_request.tools,
      messages: input.llm_request.raw_messages ?? input.llm_request.messages,
    });
  }

  private handleAfterModel(input: AfterModelInput): void {
    const key = this.llmKey();
    const llmSpan = this.llmSpans.get(key);
    // 内容级 tracing（P1-5）放在 usage 守卫**之前**：下面那句 `if (!usage) return`
    // 会在「响应没带 usage」时提前退出，而那恰恰是最需要看内容的场景之一
    // （截断响应 / provider 异常返回往往就是没 usage）。放在守卫后面等于
    // 「越是出问题的那一轮，越采不到内容」。
    if (llmSpan) {
      addResponseContent(llmSpan, {
        text: input.llm_response.text,
        thinkingBlocks: input.llm_response.thinking_blocks,
      });
    }

    // 缺陷 3（20260927 可观测性审计）：end() 是入队的唯一时机，必须在 finally 里。
    // 曾经 `if (!usage) return` 直接跳过 end()：那一轮 span 永不落盘、spanId 永久留在栈上，
    // 而「响应没带 usage」正是截断 / 异常响应的典型形态 —— 越该看的那一轮越看不到。
    try {
      this.recordAfterModel(input, llmSpan);
    } finally {
      if (llmSpan) {
        if (!input.llm_response.usage) llmSpan.setAttribute("sidcode.usage.missing", true);
        llmSpan.end();
        this.llmSpans.delete(key);
      }
    }
  }

  /** 收掉一个没等到 AfterModel 的 chat span：标 error 后入队，不让它悬空 */
  private abandonLlmSpan(key: string, reason: string): void {
    const span = this.llmSpans.get(key);
    if (!span) return;
    span.setAttribute("sidcode.span.abandoned", reason);
    span.recordError(new Error(`chat span 未收到 AfterModel（${reason}）`));
    span.end();
    this.llmSpans.delete(key);
  }

  private recordAfterModel(input: AfterModelInput, llmSpan: SpanHandle | undefined): void {
    const usage = input.llm_response.usage;
    if (!usage) return;

    // TTFT：event 给瀑布图看时刻，属性给聚合方读数（缺陷 8：原先只有 event，
    // `/telemetry` 读属性 ⇒ 恒 undefined、那一行静默消失）
    if (input.llm_response.ttft_ms !== undefined && llmSpan) {
      llmSpan.addEvent("gen_ai.first_token", {
        ttft_ms: input.llm_response.ttft_ms,
      });
      llmSpan.setAttribute(ATTR.TTFT_MS, input.llm_response.ttft_ms);
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
          reasoningTokens: usage.reasoningTokens,
        },
        // 缺省时由 TokenMeter 按 model 定价算（不再 `?? 0`：0 会被当成真实成本）
        costUSD: input.llm_response.cost_usd,
        // 与下方 span 属性同一个值：metric 与 span 不得各算各的（2026-10-08 实测两数不等）
        cacheSavingsUSD: input.llm_response.cache_savings_usd,
        sessionId: this.config.sessionId,
      });
    }

    // 附加属性；end() 由 handleAfterModel 的 finally 负责
    const enriched = this.collectEnrichedAttributes("chat", input);
    llmSpan?.setAttributes({
      ...usageAttributes(usage, this.config.provider),
      [ATTR.FINISH_REASONS]: input.llm_response.stop_reason ?? "unknown",
      [ATTR.COST_USD]: input.llm_response.cost_usd ?? 0,
      [ATTR.CACHE_SAVINGS_USD]: input.llm_response.cache_savings_usd ?? 0,
      ...(enriched as Attributes),
    });
  }

  private handlePostToolUse(input: PostToolUseInput): void {
    // 此 span 在 PostToolUse（工具已跑完）时才创建，所以起点按 duration_ms **回填**：
    // 曾经是「创建即结束」，durationMs ≈ 0，Jaeger 瀑布图上所有工具都是一根 0µs 的竖线，
    // 整个会话看起来全是模型时间 —— 恰好误导「慢在模型还是慢在工具」这个问题（B42 实测）。
    // sidcode.tool.duration_ms 属性保留，供不看 span 时长的旧消费方继续用。
    const enriched = this.collectEnrichedAttributes("execute_tool", input);
    const toolDuration =
      typeof input.duration_ms === "number" && input.duration_ms > 0 ? input.duration_ms : 0;
    // 缺陷 22：span name 与 TOOL_NAME 一律走 sanitizeToolName（MCP → "mcp_tool"），
    // 与 analytics 通道同一条规则。span 随 OTLP 外发，原名会带出用户私有 MCP 服务名。
    const toolName = sanitizedToolName(input.tool_name);
    const toolSpan = this.bus.startSpan(
      "execute_tool",
      `execute_tool ${toolName}`,
      {
        [ATTR.OPERATION_NAME]: "execute_tool",
        [ATTR.TOOL_NAME]: toolName,
        [ATTR.TOOL_CALL_ID]: input.tool_use_id ?? "",
        [ATTR.SUCCESS]: !input.is_error,
        ...(enriched as Attributes),
      },
      { startTime: Date.now() - toolDuration, ...this.scopedParent() },
    );
    // 如果有真实耗时，记录为属性
    if (input.duration_ms !== undefined) {
      toolSpan.setAttribute("sidcode.tool.duration_ms", input.duration_ms);
    }
    // 内容级 tracing（P1-5）：工具入参 + 返回值。默认关闭。
    // 这两样是「模型这一步为什么做错」最直接的证据：模型给了什么参数、工具回了什么。
    addToolContent(toolSpan, {
      toolInput: input.tool_input,
      toolResponse: input.tool_response,
    });
    if (input.is_error) {
      // 缺陷 23：错误摘要过脱敏 + 按字节截断。recordError 不受内容级 tracing 开关约束，
      // 原样写入等于给第 4 道闸门开了一条只在失败路径上生效的旁路。
      toolSpan.recordError(
        new Error(maskedErrorSummary(JSON.stringify(input.tool_response) ?? "")),
      );
    }
    toolSpan.end();
  }

  /**
   * Q7：权限拒绝的 execute_tool span。工具没跑，耗时为 0，只标 `sidcode.tool.status=denied`。
   *
   * 刻意**不写** `sidcode.success`：原先标 success=false 并寄望「聚合时按 status 排除」，
   * 但仓内没有任何聚合代码读 status——下游按 success 算失败率，拒绝就又混回分子里，
   * Q7 切换语义省掉的那截曲线原样回来。不给 success，按 success 统计的口径天然不含拒绝；
   * 要看拒绝另走权限决策（B11）或按 status 过滤。
   */
  private handlePermissionDenied(input: PermissionDeniedInput): void {
    const toolName = sanitizedToolName(input.tool_name);
    const span = this.bus.startSpan(
      "execute_tool",
      `execute_tool ${toolName}`,
      {
        [ATTR.OPERATION_NAME]: "execute_tool",
        [ATTR.TOOL_NAME]: toolName,
        [ATTR.TOOL_CALL_ID]: input.tool_use_id ?? "",
        "sidcode.tool.status": "denied",
        "sidcode.permission.denial_source": input.denial_source,
      },
      this.scopedParent(),
    );
    span.end();
  }

  // ---- spec 17 §6.1.3：权限等待 / Hook 执行 span（预留：依赖事件无 fire 点，当前恒不执行）----

  private permissionKey(input: PermissionCheckInput): string {
    return input.tool_use_id || input.tool_name;
  }

  private handleBeforePermissionCheck(input: PermissionCheckInput): void {
    const toolName = sanitizedToolName(input.tool_name);
    const span = this.bus.startSpan("blocked_on_user", `blocked_on_user ${toolName}`, {
      [ATTR.OPERATION_NAME]: "blocked_on_user",
      [ATTR.TOOL_NAME]: toolName,
      ...(input.tool_use_id ? { [ATTR.TOOL_CALL_ID]: input.tool_use_id } : {}),
      ...(this.collectEnrichedAttributes("execute_tool", input) as Attributes),
    });
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
    const span = this.bus.startSpan("hook_execution", `hook_execution ${input.hook_name}`, {
      [ATTR.OPERATION_NAME]: "hook_execution",
      "sidcode.hook.name": input.hook_name,
      ...(input.triggering_event
        ? { "sidcode.hook.triggering_event": input.triggering_event }
        : {}),
    });
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
    const span = this.bus.startSpan(
      "invoke_agent",
      `invoke_agent ${input.agent_type}`,
      {
        [ATTR.OPERATION_NAME]: "invoke_agent",
        [ATTR.AGENT_NAME]: `subagent:${input.agent_type}`,
        [ATTR.CONVERSATION_ID]: this.config.sessionId,
        [ATTR.REQUEST_MODEL]: model,
        ...(input.provider ? { [ATTR.PROVIDER_NAME]: input.provider } : {}),
        "sidcode.subagent.id": input.agent_id,
        "sidcode.subagent.type": input.agent_type,
        ...(this.collectEnrichedAttributes("invoke_agent", input) as Attributes),
      },
      {
        // 缺陷 2：子代理可并发（swarm team 的 Promise.all），不能走共享栈取 parent ——
        // 否则并发成员互为父子、先结束的弹掉别人的 id。parent 取「发起方所在作用域」：
        // 主循环发起 → 会话根；子代理里再派 → 那个子代理（SubagentStart 在子代理作用域
        // **之外**、发起方作用域之内 fire，见 sub-agent.ts）。不进共享栈。
        ...(this.scopedParent() ?? { parentSpanId: this.agentSpan?.spanId, detached: true }),
      },
    );
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
        // 缺陷 32（P0）：子代理载荷无 cost 字段，**不传** costUSD，由 TokenMeter 按 model 定价算。
        // 曾传 `costUSD: 0` 并注释「TokenMeter 内部回算」—— 它当时不回算，于是成本 metric 恒 0、
        // cache_savings 等于全价。回算现在由 token-meter.ts 的 costUSD 缺省分支保证（有单测）。
        sessionId: this.config.sessionId,
      });
    }

    if (span) {
      span.setAttributes({
        [ATTR.SUCCESS]: input.success ?? true,
        // 缺陷 11：子代理 usage 是 accumulateUsage 的逐次累加（flow），走 agent 级属性，
        // 不借 gen_ai.usage.*（那是单次 LLM 调用的语义）
        ...(usage ? agentUsageAttributes(usage) : {}),
        ...(input.turns !== undefined ? { [ATTR.TOTAL_TURNS]: input.turns } : {}),
        ...(input.duration_ms !== undefined
          ? { "sidcode.subagent.duration_ms": input.duration_ms }
          : {}),
        ...(this.collectEnrichedAttributes("invoke_agent", input) as Attributes),
      });
      span.end();
      if (key) this.subagentSpans.delete(key);
    }
  }

  private handleSessionEnd(input: SessionEndInput): void {
    // 缺陷 3：最后一轮 AfterModel 没 fire 的话，chat span 在这里收掉，必须早于根 span end
    for (const key of [...this.llmSpans.keys()]) this.abandonLlmSpan(key, "session_end");
    const stats = input.stats;
    if (this.agentSpan && stats) {
      this.agentSpan.setAttributes({
        [ATTR.TOTAL_TURNS]: this.turns,
        [ATTR.TOTAL_COST_USD]: stats.total_cost_usd ?? 0,
        // 缺陷 11：原先写 `INPUT_TOKENS: total_tokens_sent`（末次 stock）—— 同名属性在 chat 上
        // 是单轮值、在这里是会话末次值，消费方无法区分，且两者都不是 flow。
        ...agentUsageAttributes({
          inputTokens: stats.total_cumulative_prompt_tokens,
          outputTokens: stats.total_tokens_received,
          cacheReadInputTokens: stats.total_cache_read_tokens,
          cacheCreationInputTokens: stats.total_cache_creation_tokens,
        }),
        ...(this.collectEnrichedAttributes("invoke_agent", input) as Attributes),
      });
    }
    this.agentSpan?.end();
    this.agentSpan = undefined;

    // §三 P0-2：根 span 已入队 → 删标记，下次启动无需重建。
    //
    // ⚠ 必须在 `end()` **之后**：end() 是入队的唯一时机（bus.ts:101），
    // 先删标记再入队意味着「入队失败」这条路径上根 span 与标记同时消失，
    // 那个会话就永久没有根了。反过来（先入队后删）最坏只是重复落盘一条。
    //
    // 这里刻意不判 `enqueueSpan` 是否真落盘：bus 未启用时 enqueueSpan 直接 return，
    // 但那种情况下重建也不会入队（同一个 bus），留着标记只是让下次启动白扫一遍。
    if (this.pendingRootSessionId) {
      clearPendingRootSpan(this.pendingRootSessionId);
      this.pendingRootSessionId = undefined;
    }
  }
}

/**
 * 缺陷 11：invoke_agent 的累计用量 → `sidcode.agent.*`（flow）。
 * 缺字段就不落，**不兜 0**：0 会被读成「这个 agent 没花 token」。
 */
export function agentUsageAttributes(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): Attributes {
  const out: Attributes = {};
  if (usage.inputTokens !== undefined) out[ATTR.AGENT_CUMULATIVE_INPUT_TOKENS] = usage.inputTokens;
  if (usage.outputTokens !== undefined) out[ATTR.AGENT_OUTPUT_TOKENS] = usage.outputTokens;
  if (usage.cacheReadInputTokens !== undefined)
    out[ATTR.AGENT_CUMULATIVE_CACHE_READ_TOKENS] = usage.cacheReadInputTokens;
  if (usage.cacheCreationInputTokens !== undefined)
    out[ATTR.AGENT_CUMULATIVE_CACHE_WRITE_TOKENS] = usage.cacheCreationInputTokens;
  return out;
}

/**
 * 把一次调用的 usage 映射成 OTel GenAI span 属性。
 *
 * 规范要求 `gen_ai.usage.input_tokens` **含**缓存命中与写入（cache_read / cache_write
 * 都 SHOULD be included in input_tokens）。两族 provider 原始口径不同：Anthropic 的
 * input_tokens 是未命中余量，OpenAI 族的 prompt_tokens 已含命中 —— 直接透传会让同一个
 * 属性在两族下语义不同，跨 provider 看板上的 input 就不可比。统一走 normalizeCacheUsage。
 */
function usageAttributes(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
  },
  provider: string,
): Attributes {
  const norm = normalizeCacheUsage(
    {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    },
    provider,
  );
  return {
    [ATTR.INPUT_TOKENS]: norm.promptTotal,
    [ATTR.OUTPUT_TOKENS]: norm.outputTokens,
    [ATTR.CACHE_READ_TOKENS]: norm.cacheHitTokens,
    [ATTR.CACHE_WRITE_TOKENS]: norm.cacheWriteTokens,
    // 推理 token 只在有值时落：0 会把「非思考模型」与「网关未透传」混成一个数
    ...(usage.reasoningTokens ? { [ATTR.REASONING_TOKENS]: usage.reasoningTokens } : {}),
  };
}
