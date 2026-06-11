/**
 * 会话指标聚合
 * 实时统计当前会话的关键指标，供 UI 展示和会话结束时汇总
 */

import type { HookSystem } from "../hook/system.ts";
import { HookEventName } from "../hook/types.ts";
import type { HookInput, AfterModelInput, PostToolUseInput } from "../hook/types.ts";

export interface SessionMetrics {
  /** 会话开始时间 */
  startTime: number;

  /** LLM 调用统计 */
  llm: {
    totalRequests: number;
    totalErrors: number;
    totalLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUSD: number;
    /** 累计缓存命中（读）token 数 */
    totalCacheReadTokens: number;
    /** 累计缓存写入 token 数（DeepSeek 恒 0） */
    totalCacheCreationTokens: number;
    byModel: Record<string, {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      costUSD: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }>;
  };

  /** 工具调用统计 */
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    totalDurationMs: number;
    byName: Record<string, {
      calls: number;
      success: number;
      fail: number;
      totalDurationMs: number;
      avgDurationMs: number;
    }>;
  };

  /** 上下文统计 */
  context: {
    compactCount: number;
    totalTruncated: number;
    peakTokens: number;
  };

  /** 用户交互统计 */
  interaction: {
    promptCount: number;
    turnCount: number;        // agent loop 轮次
    subAgentCount: number;
  };
}

export class SessionMetricsCollector {
  private metrics: SessionMetrics;
  private sessionId: string = "";

  // ── Harness 扩展：通用计数器/仪表 ──
  private customCounters = new Map<string, number>();
  private customGauges = new Map<string, number>();

  constructor() {
    this.metrics = this.createInitial();
  }

  /** 设置当前会话 ID（供会话摘要展示） */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  private createInitial(): SessionMetrics {
    return {
      startTime: Date.now(),
      llm: {
        totalRequests: 0, totalErrors: 0, totalLatencyMs: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0,
        totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
        byModel: {},
      },
      tools: {
        totalCalls: 0, totalSuccess: 0, totalFail: 0, totalDurationMs: 0,
        byName: {},
      },
      context: { compactCount: 0, totalTruncated: 0, peakTokens: 0 },
      interaction: { promptCount: 0, turnCount: 0, subAgentCount: 0 },
    };
  }

  /** 记录 LLM 请求完成
   * @param cacheReadTokens 本次命中（读缓存）token 数
   * @param cacheCreationTokens 本次写入缓存 token 数（DeepSeek 恒 0）
   */
  recordLlmResponse(
    model: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    costUSD: number,
    isError: boolean,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): void {
    const llm = this.metrics.llm;
    llm.totalRequests++;
    if (isError) llm.totalErrors++;
    llm.totalLatencyMs += latencyMs;
    // ⚠️ usage.inputTokens 是"本次 API 调用时的 prompt 总长度"（含全部历史），
    // 累加会把系统提示词重复计数、历史消息 N² 过计数。input 取最后一次（已含全部历史），
    // output/cost 累加。与 SessionState.updateUsage 的去重口径保持一致。
    llm.totalInputTokens = inputTokens;
    llm.totalOutputTokens += outputTokens;
    llm.totalCostUSD += costUSD;
    // 缓存：read 取末次（与 input 同口径，含全部稳定前缀的命中），write 累加
    llm.totalCacheReadTokens = cacheReadTokens;
    llm.totalCacheCreationTokens += cacheCreationTokens;

    if (!llm.byModel[model]) {
      llm.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUSD: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    }
    const m = llm.byModel[model];
    m.requests++;
    m.inputTokens = inputTokens;       // 同上：覆盖而非累加
    m.outputTokens += outputTokens;
    m.latencyMs += latencyMs;
    m.costUSD += costUSD;
    m.cacheReadTokens = cacheReadTokens; // 覆盖（末次含全部命中）
    m.cacheCreationTokens += cacheCreationTokens;
  }

  /** 记录工具调用完成 */
  recordToolCall(toolName: string, durationMs: number, success: boolean): void {
    const tools = this.metrics.tools;
    tools.totalCalls++;
    if (success) tools.totalSuccess++; else tools.totalFail++;
    tools.totalDurationMs += durationMs;

    if (!tools.byName[toolName]) {
      tools.byName[toolName] = { calls: 0, success: 0, fail: 0, totalDurationMs: 0, avgDurationMs: 0 };
    }
    const t = tools.byName[toolName];
    t.calls++;
    if (success) t.success++; else t.fail++;
    t.totalDurationMs += durationMs;
    t.avgDurationMs = Math.round(t.totalDurationMs / t.calls);
  }

  /** 记录上下文压缩 */
  recordCompact(): void {
    this.metrics.context.compactCount++;
  }

  /** 记录上下文截断（Bug #3 修复） */
  recordTruncation(): void {
    this.metrics.context.totalTruncated++;
  }

  /** 更新峰值 token 数 */
  updatePeakTokens(tokens: number): void {
    if (tokens > this.metrics.context.peakTokens) {
      this.metrics.context.peakTokens = tokens;
    }
  }

  /** 记录用户提示 */
  recordPrompt(): void {
    this.metrics.interaction.promptCount++;
  }

  /** 记录 agent loop 轮次 */
  recordTurn(): void {
    this.metrics.interaction.turnCount++;
  }

  /** 记录子代理调用 */
  recordSubAgent(): void {
    this.metrics.interaction.subAgentCount++;
  }

  /** 注册为 Hook 消费者，通过 Hook 事件驱动指标采集 */
  registerHooks(hookSystem: HookSystem): void {
    // AfterModel → 记录 LLM 响应
    hookSystem.registerHook(
      {
        type: "runtime",
        name: "session-metrics-after-model",
        action: async (input: HookInput) => {
          const afterModel = input as AfterModelInput;
          const usage = afterModel.llm_response.usage;
          if (!usage) return;
          this.recordLlmResponse(
            afterModel.llm_request.model,
            usage.inputTokens ?? 0,
            usage.outputTokens ?? 0,
            afterModel.llm_response.api_duration_ms ?? 0,
            afterModel.llm_response.cost_usd ?? 0,
            false,
            usage.cacheReadInputTokens ?? 0,
            usage.cacheCreationInputTokens ?? 0,
          );
        },
      },
      HookEventName.AfterModel,
      { source: "runtime" as any },
    );

    // PostToolUse → 记录工具调用
    hookSystem.registerHook(
      {
        type: "runtime",
        name: "session-metrics-post-tool",
        action: async (input: HookInput) => {
          const postTool = input as PostToolUseInput;
          this.recordToolCall(
            postTool.tool_name,
            postTool.duration_ms ?? 0,
            !postTool.is_error,
          );
        },
      },
      HookEventName.PostToolUse,
      { source: "runtime" as any },
    );

    // BeforeModel → 记录轮次
    hookSystem.registerHook(
      {
        type: "runtime",
        name: "session-metrics-before-model",
        action: async (_input: HookInput) => {
          this.recordTurn();
        },
      },
      HookEventName.BeforeModel,
      { source: "runtime" as any },
    );
  }

  /** 递增计数器（Harness 模块调用） */
  incrementCounter(name: string, delta = 1): void {
    this.customCounters.set(name, (this.customCounters.get(name) ?? 0) + delta);
  }

  /** 设置仪表值（Harness 模块调用） */
  setGauge(name: string, value: number): void {
    this.customGauges.set(name, value);
  }

  /** 获取计数器值 */
  getCounter(name: string): number {
    return this.customCounters.get(name) ?? 0;
  }

  /** 获取仪表值 */
  getGauge(name: string): number | undefined {
    return this.customGauges.get(name);
  }

  /** 获取所有自定义指标（用于会话摘要输出） */
  getCustomMetrics(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.customCounters),
      gauges: Object.fromEntries(this.customGauges),
    };
  }

  /** 获取当前指标快照 */
  getMetrics(): SessionMetrics {
    return { ...this.metrics };
  }

  /** 生成会话摘要（用于会话结束时展示） */
  getSummary(): string {
    const m = this.metrics;
    const elapsed = ((Date.now() - m.startTime) / 1000 / 60).toFixed(1);
    const avgLatency = m.llm.totalRequests > 0
      ? (m.llm.totalLatencyMs / m.llm.totalRequests / 1000).toFixed(1)
      : '0';

    const lines: string[] = [];
    if (this.sessionId) {
      lines.push(`Session ID: ${this.sessionId}`);
    }
    lines.push(
      `会话时长: ${elapsed} 分钟`,
      `LLM: ${m.llm.totalRequests} 次请求, ${m.llm.totalInputTokens + m.llm.totalOutputTokens} tokens, 平均 ${avgLatency}s, $${m.llm.totalCostUSD.toFixed(4)}`,
      `工具: ${m.tools.totalCalls} 次调用 (${m.tools.totalSuccess}成功/${m.tools.totalFail}失败)`,
      `交互: ${m.interaction.promptCount} 次提示, ${m.interaction.turnCount} 轮循环`
    );

    // 缓存命中率（命中 / (命中 + 末次未命中输入)）——仅在有命中时展示，避免无缓存模型误导
    const cacheHit = m.llm.totalCacheReadTokens;
    if (cacheHit > 0) {
      // 命中率分母用 input（末次 prompt，含历史）+ 命中：对两家口径都给出近似可读比例
      const denom = Math.max(1, m.llm.totalInputTokens + cacheHit);
      const rate = Math.round((cacheHit / denom) * 100);
      const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
      lines.push(`缓存: 命中 ${rate}% (${fmtK(cacheHit)}/${fmtK(denom)})`);
    }

    if (m.context.compactCount > 0) {
      lines.push(`压缩: ${m.context.compactCount} 次, 峰值 ${m.context.peakTokens} tokens`);
    }

    // 按调用次数排序的工具明细
    const toolEntries = Object.entries(m.tools.byName)
      .sort(([, a], [, b]) => b.calls - a.calls);
    if (toolEntries.length > 0) {
      lines.push(`工具明细:`);
      for (const [name, stats] of toolEntries) {
        lines.push(`  ${name}: ${stats.calls}次, 平均${stats.avgDurationMs}ms`);
      }
    }

    // 追加 Harness 自定义指标
    if (this.customCounters.size > 0) {
      lines.push(`── Harness 指标 ──`);
      for (const [name, value] of this.customCounters) {
        lines.push(`  ${name}: ${value}`);
      }
    }

    return lines.join('\n');
  }

  /** 重置指标 */
  reset(): void {
    this.metrics = this.createInitial();
    this.customCounters.clear();
    this.customGauges.clear();
  }
}

// 全局单例
let globalCollector: SessionMetricsCollector | null = null;

export function getSessionMetrics(): SessionMetricsCollector {
  if (!globalCollector) globalCollector = new SessionMetricsCollector();
  return globalCollector;
}
