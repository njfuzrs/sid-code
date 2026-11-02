import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /telemetry 命令 — 展示当前会话的 Span 树和 Metric 汇总 */
export class TelemetryCommand implements LocalCommandModule {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const { getTelemetryBus } = await import("@sid-code/core/telemetry/index.ts");
    const { ATTR } = await import("@sid-code/core/telemetry/types.ts");
    const bus = getTelemetryBus();

    if (!bus.isEnabled()) {
      return {
        type: "text",
        value: "遥测未启用。在 ~/.sid-code/settings.json 中设置 telemetry.enabled: true",
      };
    }

    const spans = bus.getCompletedSpans();
    const metrics = bus.getCompletedMetrics();

    if (spans.length === 0 && metrics.length === 0) {
      return { type: "text", value: "当前会话暂无遥测数据" };
    }

    const lines: string[] = ["遥测摘要", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];

    const chatSpans = spans.filter((s) => s.kind === "chat");
    const toolSpans = spans.filter((s) => s.kind === "execute_tool");

    // === 总览（最重要的信息放最前面）===
    if (chatSpans.length > 0) {
      // 缺陷 10：chat span 的 INPUT_TOKENS 是**单轮 prompt 总长**（stock，含全部历史），
      // 逐 span 相加是 N² 过计数（collector.ts 同名注释：29 次调用 3.65M vs 实际 167k）。
      // 这里展示的是「上下文多大」= 末次（按 endTime 取最后一个），不是累加。
      // output / cost / cache_savings 是每轮独立的 flow，累加正确。
      let lastIn = 0,
        lastEnd = -Infinity,
        totalOut = 0,
        totalCost = 0,
        totalCacheSavings = 0;
      // 缺陷 9：TTFT 按 model 分组 —— 同一会话 fallback 换模型时，跨 model 汇总是假数
      // （CLAUDE.md TTFB/TTFT 铁律，latency-by-model.ts 同一理由）。
      const ttftByModel = new Map<string, number[]>();
      for (const s of chatSpans) {
        const inTok = (s.attributes[ATTR.INPUT_TOKENS] as number) || 0;
        if (s.endTime >= lastEnd) {
          lastEnd = s.endTime;
          lastIn = inTok;
        }
        totalOut += (s.attributes[ATTR.OUTPUT_TOKENS] as number) || 0;
        totalCost += (s.attributes[ATTR.COST_USD] as number) || 0;
        totalCacheSavings += (s.attributes[ATTR.CACHE_SAVINGS_USD] as number) || 0;
        // 缺陷 8：原先读 "sidcode.ttft_ms" 但 probe 只写 span event，属性零生产者。
        const ttft = s.attributes[ATTR.TTFT_MS];
        if (typeof ttft === "number" && ttft > 0) {
          const model = (s.attributes[ATTR.REQUEST_MODEL] as string) || "?";
          const arr = ttftByModel.get(model) ?? [];
          arr.push(ttft);
          ttftByModel.set(model, arr);
        }
      }
      const { percentile } = await import("@sid-code/core/trace/digest.ts");

      // 按工具名统计
      const toolCounts = new Map<string, number>();
      for (const s of toolSpans) {
        const name = (s.attributes[ATTR.TOOL_NAME] as string) || "unknown";
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }

      lines.push("");
      lines.push(`  LLM 调用: ${chatSpans.length} 轮`);
      lines.push(
        `  Token: 当前上下文 ${fmtNum(lastIn)}（末轮输入，不累加） / 累计输出 ${fmtNum(totalOut)}`,
      );
      if (totalCost > 0) {
        lines.push(`  费用: $${totalCost.toFixed(4)}`);
      }
      if (totalCacheSavings > 0) {
        lines.push(`  缓存节省: $${totalCacheSavings.toFixed(4)}`);
      }
      // 缺陷 9：报 p50/p95 不报均值（慢尾巴才是用户流失点），并标 n —— 单会话样本少，
      // 不标 n 会让人误判置信度。没有样本时明说，不静默省掉整行（缺陷 8 的失败姿态）。
      if (ttftByModel.size === 0) {
        lines.push(`  首内容延迟 (TTFT): 无样本`);
      } else {
        lines.push(`  首内容延迟 (TTFT，按 model):`);
        for (const [model, arr] of ttftByModel) {
          const sorted = [...arr].sort((a, b) => a - b);
          const p50 = percentile(sorted, 0.5)!;
          const p95 = percentile(sorted, 0.95)!;
          const short = model.split("/").pop() || model;
          lines.push(
            `    ${short}: P50 ${Math.round(p50)}ms / P95 ${Math.round(p95)}ms (n=${sorted.length})`,
          );
        }
      }
      if (toolSpans.length > 0) {
        const toolSummary = Array.from(toolCounts.entries())
          .map(([n, c]) => `${n}×${c}`)
          .join(", ");
        lines.push(`  工具调用: ${toolSpans.length} 次 (${toolSummary})`);
      }
    }

    // === 调用时间线 ===
    // 缺陷 17：根 span 只在 SessionEnd 才 end，只读 history 时它必然缺席 ⇒ 补上进行中的快照
    const active = bus.getActiveSpans();
    if (spans.length > 0 || active.length > 0) {
      lines.push("", "调用时间线:");
      const { roots, orphanCount } = buildSpanTree(
        [...spans, ...active],
        new Set(active.map((x) => x.spanId)),
      );
      for (let i = 0; i < roots.length; i++) {
        renderSpanNode(roots[i], lines, "  ", ATTR, i + 1);
      }
      // 缺陷 18 / 19：孤儿与截断必须明说，否则用户看到的是一份「看起来完整」的时间线
      const evicted = bus.getEvictedSpanCount();
      if (evicted > 0) {
        lines.push(
          `  ⚠ 历史已截断 ${fmtNum(evicted)} 条最旧 span（上限 500），其子节点可能显示为孤儿`,
        );
      }
      if (orphanCount > 0) {
        lines.push(`  ⚠ ${orphanCount} 个孤儿节点（父 span 不在本批数据中，标 ⊘）`);
      }
    }

    // === Metric 明细（仅在有非 token/cost 的额外指标时展示）===
    if (metrics.length > 0) {
      const agg = aggregateMetrics(metrics);
      // 过滤掉已在总览中展示的指标
      const extraMetrics = Object.entries(agg).filter(
        ([name]) =>
          !name.startsWith("gen_ai.client.inference.usage.") && name !== "sidcode.cost.usd",
      );
      if (extraMetrics.length > 0) {
        lines.push("", "其他指标:");
        for (const [name, info] of extraMetrics) {
          const label = METRIC_LABELS[name] || name;
          if (info.type === "counter") {
            lines.push(`  ${label}: ${fmtNum(info.sum)}`);
          } else if (info.type === "gauge") {
            lines.push(`  ${label}: ${fmtNum(info.last)}`);
          } else {
            lines.push(
              `  ${label}: ${info.count} 次, 平均 ${fmtNum(info.sum / info.count)}, 最大 ${fmtNum(info.max)}`,
            );
          }
        }
      }
    }

    return { type: "text", value: lines.join("\n") };
  }
}

// --- TelemetryCommand 辅助函数 ---

/** Metric 名称 → 中文标签映射 */
const METRIC_LABELS: Record<string, string> = {
  "gen_ai.client.operation.time_to_first_chunk": "首内容延迟 TTFT (s)",
  "sidcode.cost.usd": "费用 (USD)",
  "sidcode.cost.cache_savings_usd": "缓存节省 (USD)",
  "sidcode.budget.remaining_usd": "预算剩余 (USD)",
  "sidcode.budget.usage_percent": "预算使用率 (%)",
};

interface SpanTreeNode {
  span: import("@sid-code/core/telemetry/types.ts").SpanData;
  children: SpanTreeNode[];
  /** 缺陷 18：有 parentSpanId 但父不在本批 —— 与真根（parentSpanId 为空）区分 */
  orphan: boolean;
  /** 缺陷 17：尚未 end 的快照节点 */
  inProgress: boolean;
}

/**
 * 将扁平 span 列表构建为树。
 *
 * 「父不在本批」与「本就是根」曾合并进同一个 else 分支，渲染上不可区分（缺陷 18）。
 * 现在两者都进 roots，但孤儿打 `orphan` 标记并单独计数。
 */
function buildSpanTree(
  spans: readonly import("@sid-code/core/telemetry/types.ts").SpanData[],
  activeIds?: ReadonlySet<string>,
): { roots: SpanTreeNode[]; orphanCount: number } {
  const nodeMap = new Map<string, SpanTreeNode>();
  const roots: SpanTreeNode[] = [];
  let orphanCount = 0;

  // 创建所有节点（同 id 后者覆盖前者：活跃快照与已完成 span 不会同时存在，防御性去重）
  for (const span of spans) {
    nodeMap.set(span.spanId, {
      span,
      children: [],
      orphan: false,
      inProgress: activeIds?.has(span.spanId) ?? false,
    });
  }

  // 建立父子关系
  for (const node of nodeMap.values()) {
    const { parentSpanId } = node.span;
    if (parentSpanId && nodeMap.has(parentSpanId)) {
      nodeMap.get(parentSpanId)!.children.push(node);
    } else {
      if (parentSpanId) {
        node.orphan = true;
        orphanCount++;
      }
      roots.push(node);
    }
  }

  // 按起点排序（快照追加在末尾，不排序时根会被画到最后）
  const byStart = (a: SpanTreeNode, b: SpanTreeNode) => a.span.startTime - b.span.startTime;
  roots.sort(byStart);
  for (const n of nodeMap.values()) n.children.sort(byStart);

  return { roots, orphanCount };
}

/**
 * Span kind → 中文标签。缺陷 18：曾只覆盖 3 类，另 2 类落 fallback 显示英文原名。
 * 类型写成 `Record<SpanKind, string>`：SpanKind 新增成员而这里漏加，typecheck 直接红。
 */
const SPAN_KIND_LABELS: Record<import("@sid-code/core/telemetry/types.ts").SpanKind, string> = {
  invoke_agent: "Agent",
  chat: "LLM 调用",
  execute_tool: "工具",
  blocked_on_user: "等待确认",
  hook_execution: "Hook",
};

/** 递归渲染 span 树节点 */
function renderSpanNode(
  node: SpanTreeNode,
  lines: string[],
  prefix: string,
  ATTR: typeof import("@sid-code/core/telemetry/types.ts").ATTR,
  index?: number,
): void {
  const s = node.span;
  const dur = fmtDuration(s.durationMs);
  const statusMark =
    (s.status === "error" ? " ✗" : "") +
    (node.inProgress ? " ⋯进行中" : "") +
    (node.orphan ? " ⊘孤儿" : "");
  const kindLabel = SPAN_KIND_LABELS[s.kind] || s.kind;
  const indexStr = index !== undefined ? `#${index} ` : "";

  let detail = "";
  if (s.kind === "chat") {
    const model = (s.attributes[ATTR.REQUEST_MODEL] as string) || "?";
    const shortModel = model.split("/").pop() || model;
    const ttft = s.attributes[ATTR.TTFT_MS] as number;
    const inTok = (s.attributes[ATTR.INPUT_TOKENS] as number) || 0;
    const outTok = (s.attributes[ATTR.OUTPUT_TOKENS] as number) || 0;
    const cost = (s.attributes[ATTR.COST_USD] as number) || 0;
    const parts = [dur];
    if (ttft) parts.push(`TTFT ${Math.round(ttft)}ms`);
    parts.push(`输入 ${fmtNum(inTok)} / 输出 ${fmtNum(outTok)}`);
    if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
    detail = ` ${shortModel} — ${parts.join(", ")}`;
  } else if (s.kind === "execute_tool") {
    const toolName = (s.attributes[ATTR.TOOL_NAME] as string) || "?";
    const toolDur = s.attributes["sidcode.tool.duration_ms"] as number;
    detail = ` ${toolName} — ${toolDur ? fmtDuration(toolDur) : dur}`;
  } else {
    detail = ` — ${dur}`;
  }

  lines.push(`${prefix}${indexStr}${kindLabel}${detail}${statusMark}`);

  for (let i = 0; i < node.children.length; i++) {
    const isLast = i === node.children.length - 1;
    const connector = isLast ? "└─ " : "├─ ";
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    const childLines: string[] = [];
    renderSpanNode(node.children[i], childLines, childPrefix, ATTR);
    if (childLines.length > 0) {
      lines.push(`${prefix}${connector}${childLines[0].trimStart()}`);
      for (let j = 1; j < childLines.length; j++) {
        lines.push(childLines[j]);
      }
    }
  }
}

/** 聚合 metric 数据 */
function aggregateMetrics(
  metrics: readonly import("@sid-code/core/telemetry/types.ts").MetricPoint[],
): Record<
  string,
  {
    type: string;
    sum: number;
    count: number;
    max: number;
    last: number;
  }
> {
  const agg: Record<
    string,
    { type: string; sum: number; count: number; max: number; last: number }
  > = {};
  for (const m of metrics) {
    if (!agg[m.name]) {
      agg[m.name] = { type: m.type, sum: 0, count: 0, max: -Infinity, last: 0 };
    }
    const a = agg[m.name];
    a.sum += m.value;
    a.count++;
    if (m.value > a.max) a.max = m.value;
    a.last = m.value;
  }
  return agg;
}

/** 格式化数字（千分位） */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

/** 格式化毫秒为可读时长 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${min}m${sec}s`;
}
