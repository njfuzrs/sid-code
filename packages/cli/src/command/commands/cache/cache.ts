import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** 把 0~1 的比率序列渲染成 ▁▃▅▆▇█ sparkline */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return values
    .map((v) => {
      const clamped = Math.max(0, Math.min(1, v));
      const idx = Math.min(chars.length - 1, Math.round(clamped * (chars.length - 1)));
      return chars[idx];
    })
    .join("");
}

/** /cache 命令 — 缓存命中长期统计与退化监测（模块 C3 + D3） */
export class CacheCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const { aggregateUsage, aggregateOverall } =
      await import("@sid-code/core/telemetry/usage-aggregator.ts");
    const { pruneUsageLedger } = await import("@sid-code/core/telemetry/usage-ledger.ts");
    const { getRecentCacheBreaks, getCacheHealthAdvice, formatCacheBreakReport } =
      await import("@sid-code/core/api/cache-detection.ts");

    const tokens = args.trim().split(/\s+/).filter(Boolean);

    // ── 参数解析 ──
    let granularity: "day" | "week" | "month" = "day";
    let model: string | undefined;
    let showBreaks = false;
    let showHistory = false;
    let pruneN: number | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--period" && tokens[i + 1]) {
        const p = tokens[++i];
        if (p === "day" || p === "week" || p === "month") granularity = p;
      } else if (t === "--model" && tokens[i + 1]) {
        model = tokens[++i];
      } else if (t === "--breaks") {
        showBreaks = true;
      } else if (t === "--history") {
        showHistory = true;
      } else if (t === "--prune" && tokens[i + 1]) {
        pruneN = parseInt(tokens[++i], 10);
      }
    }

    // ── --prune：滚动裁剪账本 ──
    if (pruneN !== undefined) {
      if (!Number.isFinite(pruneN) || pruneN < 0) {
        return errorText("--prune 需要一个非负整数");
      }
      const kept = pruneUsageLedger(pruneN);
      return {
        type: "text",
        value: kept >= 0 ? `账本已裁剪，保留最近 ${kept} 行` : "账本裁剪失败（文件不可写）",
      };
    }

    // ── --breaks：最近缓存中断记录 + 健康度建议（D3） ──
    if (showBreaks) {
      const breaks = getRecentCacheBreaks(20);
      const advice = getCacheHealthAdvice();
      const lines: string[] = ["缓存中断记录（最近 20 条）:"];
      if (breaks.length === 0) {
        lines.push("  （本会话暂无检测到缓存中断）");
      } else {
        for (const b of breaks) {
          const time = new Date(b.ts * 1000).toLocaleTimeString();
          lines.push(`  [${time}] ${b.model}: ${formatCacheBreakReport(b)}`);
        }
      }
      if (advice.length > 0) {
        lines.push("", "健康度建议:");
        for (const a of advice) lines.push(`  ⚠ ${a}`);
      }
      return { type: "text", value: lines.join("\n") };
    }

    // ── --history：跨会话缓存中断遥测历史聚合（G13） ──
    if (showHistory) {
      const { queryCacheBreakHistory, summarizeCacheBreakHistory } =
        await import("@sid-code/core/telemetry/cache-telemetry.ts");
      const recent = queryCacheBreakHistory(20);
      const summary = summarizeCacheBreakHistory(500);
      const lines: string[] = ["缓存中断历史（跨会话，最近 20 条）:"];
      if (recent.length === 0) {
        lines.push("  （暂无历史中断记录。中断检测到时落 ~/.sid-code/cache-breaks.jsonl）");
        return { type: "text", value: lines.join("\n") };
      }
      for (const e of recent) {
        const time = new Date(e.ts * 1000).toLocaleString();
        lines.push(
          `  [${time}] ${e.model}: 下降 ${e.dropPercent}% (${e.dropTokens} tok): ${e.changes.join("; ")}`,
        );
      }
      const cats = Object.entries(summary.byCategory).sort(([, a], [, b]) => b - a);
      if (cats.length > 0) {
        const labelOf: Record<string, string> = {
          model: "模型切换",
          system_prompt: "System prompt 变化",
          tool_order: "工具顺序变化",
          tools: "工具增删改",
          cache_policy: "缓存策略变化",
          beta_headers: "Beta headers 变化",
          compact: "压缩(消息骤减)",
          ttl_expiry: "TTL 过期",
          unknown: "未知",
        };
        lines.push("", `归因分布（最近 ${summary.total} 条中断）:`);
        for (const [cat, n] of cats) {
          lines.push(`  ${labelOf[cat] ?? cat}: ${n} 次`);
        }
      }
      return { type: "text", value: lines.join("\n") };
    }

    // ── 默认：长期命中率/省钱统计 ──
    const overall = aggregateOverall({ granularity, model });
    if (overall.totalSessions === 0) {
      return {
        type: "text",
        value:
          "暂无用量账本数据。账本在每次会话结束时落一行到 ~/.sid-code/usage-ledger.jsonl，\n" +
          "跑完至少一个会话后再查。（当前会话的实时命中率见状态栏 ⚡ 列与 /stats）",
      };
    }

    const periods = aggregateUsage({ granularity, model });
    const lines: string[] = [];
    const periodLabel = granularity === "day" ? "按天" : granularity === "week" ? "按周" : "按月";
    lines.push(`缓存统计 (${periodLabel}${model ? `, 模型=${model}` : ""})`);

    // 总览
    const fmtTok = (n: number) =>
      n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
    const totalHit = Object.values(overall.byModel).reduce((s, m) => s + m.cacheHit, 0);
    const totalPrompt = Object.values(overall.byModel).reduce((s, m) => s + m.promptTotal, 0);
    const hitPct = (overall.totalHitRate * 100).toFixed(1);
    lines.push(`  总命中率:   ${hitPct}%   (${fmtTok(totalHit)} / ${fmtTok(totalPrompt)} tokens)`);
    lines.push(`  累计省钱:   $${overall.totalSavingsUSD.toFixed(4)}`);
    lines.push(
      `  累计成本:   $${overall.totalCostUSD.toFixed(4)}   (${overall.totalSessions} 会话)`,
    );

    // P0-4：排除了多少行必须显式写出来 —— 静默排除读起来像"全部数据都在这儿"。
    // 不打印被排除的数字本身：把假数字印出来，迟早有人当真数字抄走。
    if (overall.excludedUntrustedRows > 0) {
      lines.push(
        `  ⚠ 已排除 ${overall.excludedUntrustedRows} 个会话（渠道 usage 不可信，未计入以上数字）:`,
      );
      for (const h of overall.untrustedHosts) {
        lines.push(`      ${h.host}${h.reason ? `：${h.reason}` : ""}`);
      }
      lines.push(`      判定来自 cache-trust-probe 实测，见 ~/.sid-code/channel-trust.json`);
    }
    // P0-4 覆盖盲区：**排除数为 0 时也要说**。否则"没排除"读起来像"总计干净"，
    // 而实际是这些行没带 endpointHost、根本没进可信度判定（机制上线 ≠ 数据被治理）。
    if (overall.sessionsWithoutHost > 0) {
      lines.push(
        `  ⚠ ${overall.sessionsWithoutHost} 个会话无渠道标记（账本 2026-08-08 前不记 endpointHost），`,
      );
      lines.push(`      未参与可信度判定 —— 以上总计里可能仍混有不可信渠道的数字`);
    }

    // Usage by model（按命中 token 降序）
    const models = Object.entries(overall.byModel);
    if (models.length > 0) {
      lines.push("  Usage by model:");
      models.sort(([, a], [, b]) => b.cacheHit - a.cacheHit);
      for (const [name, m] of models) {
        const rate = m.promptTotal > 0 ? Math.round((m.cacheHit / m.promptTotal) * 100) : 0;
        // P0-4：渠道与数字同行出现 —— 同一模型经不同网关可信度不同，
        // 数字与"这个数的前提"分开放会让人只抄走数字。
        // 多渠道时全列出来：合并成一个百分比恰恰掩盖了渠道差异。
        const host =
          m.hosts.length === 0
            ? ""
            : m.hosts.length === 1
              ? `  @${m.hosts[0]}`
              : `  @${m.hosts.join(",")}`;
        lines.push(
          `    ${name}:  命中 ${rate}%  省 $${m.savingsUSD.toFixed(4)}  (${m.sessions} 会话)${host}`,
        );
      }
      // hosts 为空不是"没有渠道"，是"这些行早于渠道字段上线"——不点破会被读成前者
      if (models.some(([, m]) => m.hosts.length === 0)) {
        lines.push(`    （无 @渠道 标注的行来自 2026-08-08 之前的账本，那时还没记端点）`);
      }
    }

    // 趋势 sparkline（各周期命中率）
    if (periods.length >= 2) {
      const rates = periods.map((p) => p.totalHitRate);
      const unit = granularity === "day" ? "日" : granularity === "week" ? "周" : "月";
      lines.push(
        `  趋势(${periods.length}${unit}命中率): ${sparkline(rates)}   ← 上升=前缀越来越稳定`,
      );
    }

    return { type: "text", value: lines.join("\n") };
  }
}
