/**
 * 控制台导出器——开发调试用
 * 将 Span 树以可读格式输出到控制台
 */

import type { SpanData, MetricPoint, TelemetryExporter } from "../types.ts";

export interface ConsoleExporterOptions {
  /** 输出详细程度 */
  verbosity: "summary" | "detailed" | "off";
}

export class ConsoleExporter implements TelemetryExporter {
  readonly name = "console";
  private verbosity: ConsoleExporterOptions["verbosity"];

  constructor(options?: Partial<ConsoleExporterOptions>) {
    this.verbosity = options?.verbosity ?? "summary";
  }

  async exportSpans(spans: SpanData[]): Promise<void> {
    if (this.verbosity === "off") return;

    // 按 traceId 分组，构建树
    const byTrace = new Map<string, SpanData[]>();
    for (const span of spans) {
      const list = byTrace.get(span.traceId) ?? [];
      list.push(span);
      byTrace.set(span.traceId, list);
    }

    for (const [, traceSpans] of byTrace) {
      // 找到根 Span
      const root = traceSpans.find(s => !s.parentSpanId);
      if (root) {
        console.error(this.formatSpanTree(root, traceSpans, 0));
      } else {
        // 没有根 Span，逐个输出
        for (const span of traceSpans) {
          console.error(this.formatSpan(span, 0));
        }
      }
    }
  }

  async exportMetrics(metrics: MetricPoint[]): Promise<void> {
    if (this.verbosity !== "detailed") return;
    for (const m of metrics) {
      console.error(`[METRIC] ${m.name}=${m.value} ${JSON.stringify(m.attributes)}`);
    }
  }

  async shutdown(): Promise<void> {}

  private formatSpanTree(span: SpanData, allSpans: SpanData[], depth: number): string {
    const lines: string[] = [this.formatSpan(span, depth)];
    // 找子 Span
    const children = allSpans
      .filter(s => s.parentSpanId === span.spanId)
      .sort((a, b) => a.startTime - b.startTime);
    for (const child of children) {
      lines.push(this.formatSpanTree(child, allSpans, depth + 1));
    }
    return lines.join("\n");
  }

  private formatSpan(span: SpanData, depth: number): string {
    const indent = depth === 0 ? "[TRACE] " : "  " + "│ ".repeat(depth - 1) + "├─ ";
    const status = span.status === "error" ? "ERR" : "OK";
    const dur = span.durationMs < 1000
      ? `${span.durationMs}ms`
      : `${(span.durationMs / 1000).toFixed(1)}s`;

    let extra = "";
    if (span.kind === "chat") {
      const inTok = span.attributes["gen_ai.usage.input_tokens"] ?? "?";
      const outTok = span.attributes["gen_ai.usage.output_tokens"] ?? "?";
      extra = ` | in:${inTok} out:${outTok}`;
      // TTFT
      const ttftEvent = span.events.find(e => e.name === "gen_ai.first_token");
      if (ttftEvent?.attributes?.ttft_ms) {
        extra += ` | TTFT:${ttftEvent.attributes.ttft_ms}ms`;
      }
      const finish = span.attributes["gen_ai.response.finish_reasons"];
      if (finish) extra += ` | finish:${finish}`;
    } else if (span.kind === "execute_tool") {
      const summary = span.attributes["sidcode.tool.args_summary"] ?? "";
      if (summary) extra = ` | ${summary}`;
    }

    if (this.verbosity === "detailed" && span.error) {
      extra += ` | error:${span.error.message}`;
    }

    return `${indent}[SPAN] ${span.name} (${dur}) ${status}${extra}`;
  }
}
