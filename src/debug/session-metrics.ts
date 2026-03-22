/**
 * 会话指标聚合
 * 实时统计当前会话的关键指标，供 UI 展示和会话结束时汇总
 */

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
    byModel: Record<string, {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      costUSD: number;
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

  constructor() {
    this.metrics = this.createInitial();
  }

  private createInitial(): SessionMetrics {
    return {
      startTime: Date.now(),
      llm: {
        totalRequests: 0, totalErrors: 0, totalLatencyMs: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0,
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

  /** 记录 LLM 请求完成 */
  recordLlmResponse(model: string, inputTokens: number, outputTokens: number, latencyMs: number, costUSD: number, isError: boolean): void {
    const llm = this.metrics.llm;
    llm.totalRequests++;
    if (isError) llm.totalErrors++;
    llm.totalLatencyMs += latencyMs;
    llm.totalInputTokens += inputTokens;
    llm.totalOutputTokens += outputTokens;
    llm.totalCostUSD += costUSD;

    if (!llm.byModel[model]) {
      llm.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUSD: 0 };
    }
    const m = llm.byModel[model];
    m.requests++;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
    m.latencyMs += latencyMs;
    m.costUSD += costUSD;
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

    const lines = [
      `会话时长: ${elapsed} 分钟`,
      `LLM: ${m.llm.totalRequests} 次请求, ${m.llm.totalInputTokens + m.llm.totalOutputTokens} tokens, 平均 ${avgLatency}s, $${m.llm.totalCostUSD.toFixed(4)}`,
      `工具: ${m.tools.totalCalls} 次调用 (${m.tools.totalSuccess}成功/${m.tools.totalFail}失败)`,
      `交互: ${m.interaction.promptCount} 次提示, ${m.interaction.turnCount} 轮循环`,
    ];

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

    return lines.join('\n');
  }

  /** 重置指标 */
  reset(): void {
    this.metrics = this.createInitial();
  }
}

// 全局单例
let globalCollector: SessionMetricsCollector | null = null;

export function getSessionMetrics(): SessionMetricsCollector {
  if (!globalCollector) globalCollector = new SessionMetricsCollector();
  return globalCollector;
}
