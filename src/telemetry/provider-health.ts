/**
 * T15：Provider 健康度聚合
 *
 * 从 events.jsonl 聚合各 provider 的健康指标：成功率/延迟/超时/重试。
 * 供 CLI 看板和 digest 集成使用。
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { percentile } from "../trace/digest.ts";
// P2-3：TTFT×缓存分桶与 digest.ts 共用同一实现（方案要求"两处刻意同口径"）
import {
  TtftCacheBucketer,
  bucketStats,
  formatTtftBucketLine,
} from "../trace/ttft-cache-buckets.ts";
// P1-8 门控：privacy-level 零依赖、无副作用，同步 import 不引入导入链污染。
import { isEssentialTrafficOnly } from "../analytics/privacy-level.ts";

// ─── 接口定义 ───

export interface ProviderHealthMetrics {
  provider: string;
  period: { start: number; end: number };
  requests: {
    total: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    retried: number;
  };
  latency: {
    ttft_p50?: number;
    ttft_p95?: number;
    ttft_p99?: number;
    total_p50?: number;
    total_p95?: number;
    /**
     * P2-3：按"本次请求是否命中前缀缓存"分桶的 TTFT 分位数。
     *
     * 与 `digest.ts` 的 `ProviderDigestStats.ttftByCache` **同口径同构**（都由
     * `ttft-cache-buckets.ts` 产出）—— 方案 §P2-3 原话"两处必须同步改（刻意同口径）"。
     * 第一版只改了 digest，本字段缺失导致 `/trace --health` 与
     * `scripts/provider-health.ts` 都没有分桶，而验收表与博客写着
     * "`trace-digest --health` 输出 hit/miss 两组分位数" —— 指了个不存在的入口。
     *
     * 两桶都无样本时整个字段不落（老轨迹没有 cache_hit 维度）：落 count 全 0
     * 会让"数据还没采到"读起来像"命中与未命中一样快"。
     */
    ttftByCache?: {
      hit: { count: number; p50?: number; p95?: number };
      miss: { count: number; p50?: number; p95?: number };
    };
    /** P2-3：有维度但配对数量不等而弃用的 TTFT 样本数（不落=无此情况） */
    ttftBucketDropped?: number;
    /**
     * P2-3：因轨迹早于 `cache_hit` 维度上线（2026-08-08）而未进桶的样本数。
     * 与 `ttftBucketDropped` 分开：前者是历史空档（预期），后者才是异常信号。
     */
    ttftNoDimension?: number;
  };
  timeouts: {
    byLayer: Record<string, number>;
  };
  retries: {
    total: number;
    exhausted: number;
    fallbackTriggered: number;
  };
}

export interface HealthReport {
  generatedAt: string;
  periodLabel: string;
  providers: ProviderHealthMetrics[];
  alerts: HealthAlert[];
}

export interface HealthAlert {
  provider: string;
  severity: "warning" | "critical";
  message: string;
}

// ─── 核心聚合逻辑 ───

interface RawEvent {
  event?: string;
  timestamp?: string;
  /**
   * P2-3：分桶配对的分组键需要它。本聚合器**跨多个会话**读 events.jsonl，
   * 不带 session_id 会把 A 会话的 ttft 配到 B 会话的命中状态上
   *（events.jsonl 每行本就带该字段，此前只是类型没声明）。
   */
  session_id?: string;
  data?: Record<string, unknown>;
}

interface ProviderAccumulator {
  totalLatencies: number[];
  ttfts: number[];
  requests: number;
  failed: number;
  timedOut: number;
  retried: number;
  exhausted: number;
  fallbackTriggered: number;
  timeoutsByLayer: Record<string, number>;
  timestamps: number[];
}

/**
 * 从指定时间范围内的 events.jsonl 文件聚合 provider 健康指标。
 */
export function aggregateProviderHealth(options: {
  periodMs?: number;
  provider?: string;
  sessionsDir?: string;
}): HealthReport {
  const {
    periodMs = 3600_000, // 默认 1h
    provider: filterProvider,
    sessionsDir,
  } = options;

  const trajDir = sessionsDir || join(sidPaths.trajectories(), "sessions");
  const cutoffTs = Date.now() - periodMs;

  // 收集所有符合时间范围的 session 目录
  const events = collectEvents(trajDir, cutoffTs);

  // P2-3：TTFT×缓存分桶。与 digest.aggregateProviderStats 共用 TtftCacheBucketer ——
  // 同一份 events.jsonl 在两个入口必须得出同一个结论，抄第二遍必然漂移。
  const bucketer = new TtftCacheBucketer();

  // 按 provider 聚合
  const accumulators = new Map<string, ProviderAccumulator>();
  const ensure = (p: string): ProviderAccumulator => {
    if (!accumulators.has(p)) {
      accumulators.set(p, {
        totalLatencies: [],
        ttfts: [],
        requests: 0,
        failed: 0,
        timedOut: 0,
        retried: 0,
        exhausted: 0,
        fallbackTriggered: 0,
        timeoutsByLayer: {},
        timestamps: [],
      });
    }
    return accumulators.get(p)!;
  };

  // P0-1（排查报告 Bug A）：first_content 只带 model 不带 provider，先扫一遍 AfterModelRaw
  // 建立 model→provider 映射，供 TTFT 归因。与 digest.aggregateProviderStats 同口径。
  const modelToProvider = new Map<string, string>();
  for (const e of events) {
    if (e.event === "AfterModelRaw" && e.data) {
      const prov = (e.data.provider as string) || "";
      const model = (e.data.model as string) || "";
      if (prov && model && !modelToProvider.has(model)) modelToProvider.set(model, prov);
    }
  }
  const resolveProvider = (model: string): string =>
    modelToProvider.get(model) || (model.includes("claude") ? "anthropic" : model ? "openai" : "unknown");

  for (const e of events) {
    if (e.event === "AfterModelRaw" && e.data) {
      const prov = (e.data.provider as string) || "unknown";
      if (filterProvider && prov !== filterProvider) continue;
      const acc = ensure(prov);
      acc.requests++;
      const elapsed = (e.data.elapsed_ms as number) || 0;
      if (elapsed > 0) acc.totalLatencies.push(elapsed);
      // P0-1：TTFT 不再从 AfterModelRaw.ttft_ms 取（被"可视文本延迟+重试"双重污染，见排查报告 Bug A），
      // 改由下方 StreamPhase("first_content") 分支收集纯净值。
      const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
      if (ts > 0) acc.timestamps.push(ts);
    }

    // P0-1：TTFT 改从 StreamPhase("first_content") 收集——lifecycle 层每次 fetch 独立计算的首内容延迟
    if (e.event === "StreamPhase" && e.data && e.data.phase === "first_content") {
      const model = (e.data.model as string) || "";
      const prov = resolveProvider(model);
      if (filterProvider && prov !== filterProvider) continue;
      const ttft = e.data.ttft_ms as number | undefined;
      if (ttft && ttft > 0) {
        ensure(prov).ttfts.push(ttft);
        // P2-3：Anthropic 事件自带 cache_hit 直接分桶；OpenAI 族暂存待与 completed 配对
        bucketer.observeFirstContent(e, prov, ttft);
      }
    }

    // P2-3：completed 携带的缓存维度（OpenAI 族 usage 在流尾部才到，配对用）。
    // 刻意不做 filterProvider 过滤：这里只是喂配对表，provider 归属在
    // observeFirstContent 时已定；按 provider 过滤 completed 会让被过滤掉的组
    // 数量对不上，整组进 dropped —— 明明有数据却报"无法判定"。
    if (e.event === "StreamPhase" && e.data && e.data.phase === "completed") {
      bucketer.observeCompleted(e);
    }

    if (e.event === "RetryTelemetry" && e.data) {
      const prov = (e.data.provider as string) || (e.data.model as string) || "unknown";
      if (filterProvider && prov !== filterProvider) continue;
      const acc = ensure(prov);
      const type = e.data.type as string;
      if (type === "retry") acc.retried++;
      else if (type === "529_dropped") acc.failed++;
      else if (type === "fallback") acc.fallbackTriggered++;
      else if (type === "persistent_failure") acc.exhausted++;
      else if (type?.includes("timeout")) acc.timedOut++;
    }

    if (e.event === "TimeoutFired" && e.data) {
      const layer = (e.data.layer as string) || "unknown";
      const model = (e.data.model as string) || "";
      const prov = model.includes("deepseek") ? "openai" : model.includes("claude") ? "anthropic" : "unknown";
      if (filterProvider && prov !== filterProvider) continue;
      const acc = ensure(prov);
      acc.timeoutsByLayer[layer] = (acc.timeoutsByLayer[layer] || 0) + 1;
      acc.timedOut++;
    }
  }

  // P2-3：遍历完再配对（completed 可能后到，边遍历边配会漏掉一半）
  const buckets = bucketer.finalize();

  // 生成报告
  const providers: ProviderHealthMetrics[] = [];
  const alerts: HealthAlert[] = [];

  for (const [prov, acc] of accumulators) {
    const sortedLatencies = acc.totalLatencies.sort((a, b) => a - b);
    const sortedTtfts = acc.ttfts.sort((a, b) => a - b);
    const succeeded = acc.requests - acc.failed - acc.timedOut;
    const minTs = acc.timestamps.length > 0 ? Math.min(...acc.timestamps) : cutoffTs;
    const maxTs = acc.timestamps.length > 0 ? Math.max(...acc.timestamps) : Date.now();

    const metrics: ProviderHealthMetrics = {
      provider: prov,
      period: { start: minTs, end: maxTs },
      requests: {
        total: acc.requests,
        succeeded: Math.max(0, succeeded),
        failed: acc.failed,
        timedOut: acc.timedOut,
        retried: acc.retried,
      },
      latency: {
        ttft_p50: percentile(sortedTtfts, 0.5),
        ttft_p95: percentile(sortedTtfts, 0.95),
        ttft_p99: percentile(sortedTtfts, 0.99),
        total_p50: percentile(sortedLatencies, 0.5),
        total_p95: percentile(sortedLatencies, 0.95),
        // P2-3：分桶字段与 digest 同构。两桶皆空 / dropped=0 时不落该键
        // （见 ttft-cache-buckets.ts：落 count 全 0 会把"未采到"读成"一样快"）。
        ...(() => {
          const b = buckets.get(prov);
          if (!b) return {};
          const out: {
            ttftByCache?: { hit: ReturnType<typeof bucketStats>; miss: ReturnType<typeof bucketStats> };
            ttftBucketDropped?: number;
            ttftNoDimension?: number;
          } = {};
          if (b.hit.length + b.miss.length > 0) {
            out.ttftByCache = {
              hit: bucketStats(b.hit, percentile),
              miss: bucketStats(b.miss, percentile),
            };
          }
          if (b.dropped > 0) out.ttftBucketDropped = b.dropped;
          if (b.noDimension > 0) out.ttftNoDimension = b.noDimension;
          return out;
        })(),
      },
      timeouts: { byLayer: acc.timeoutsByLayer },
      retries: {
        total: acc.retried,
        exhausted: acc.exhausted,
        fallbackTriggered: acc.fallbackTriggered,
      },
    };
    providers.push(metrics);

    // 生成告警
    const successRate = acc.requests > 0 ? (Math.max(0, succeeded) / acc.requests) : 1;
    const timeoutRate = acc.requests > 0 ? acc.timedOut / acc.requests : 0;
    const ttftP95 = metrics.latency.ttft_p95;

    if (successRate < 0.9) {
      alerts.push({ provider: prov, severity: "critical", message: `成功率 ${(successRate * 100).toFixed(1)}% < 90%` });
    } else if (successRate < 0.95) {
      alerts.push({ provider: prov, severity: "warning", message: `成功率 ${(successRate * 100).toFixed(1)}% < 95%` });
    }
    if (timeoutRate > 0.1) {
      alerts.push({ provider: prov, severity: "critical", message: `超时率 ${(timeoutRate * 100).toFixed(1)}% > 10%` });
    } else if (timeoutRate > 0.05) {
      alerts.push({ provider: prov, severity: "warning", message: `超时率 ${(timeoutRate * 100).toFixed(1)}% > 5%` });
    }
    if (ttftP95 && ttftP95 > 60000) {
      alerts.push({ provider: prov, severity: "critical", message: `TTFT P95 ${(ttftP95 / 1000).toFixed(1)}s > 60s` });
    } else if (ttftP95 && ttftP95 > 30000) {
      alerts.push({ provider: prov, severity: "warning", message: `TTFT P95 ${(ttftP95 / 1000).toFixed(1)}s > 30s` });
    }
  }

  const periodLabel = periodMs >= 86400_000 * 7 ? "7d"
    : periodMs >= 86400_000 ? "24h"
    : periodMs >= 3600_000 ? "1h"
    : `${Math.round(periodMs / 60_000)}min`;

  return {
    generatedAt: new Date().toISOString(),
    periodLabel,
    providers,
    alerts,
  };
}

// ─── 辅助函数 ───

function collectEvents(sessionsDir: string, cutoffTs: number): RawEvent[] {
  if (!existsSync(sessionsDir)) return [];
  const events: RawEvent[] = [];

  try {
    const entries = readdirSync(sessionsDir);
    for (const entry of entries) {
      const sessionDir = join(sessionsDir, entry);
      try {
        const stat = statSync(sessionDir);
        if (!stat.isDirectory()) continue;
        // 按目录修改时间过滤
        if (stat.mtimeMs < cutoffTs) continue;
      } catch { continue; }

      const eventsPath = join(sessionDir, "events.jsonl");
      if (!existsSync(eventsPath)) continue;

      try {
        const content = readFileSync(eventsPath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as RawEvent;
            // 时间过滤
            if (parsed.timestamp) {
              const ts = new Date(parsed.timestamp).getTime();
              if (ts < cutoffTs) continue;
            }
            events.push(parsed);
          } catch { /* 跳过格式错误行 */ }
        }
      } catch { /* 读取失败跳过 */ }
    }
  } catch { /* 目录不存在或无权限 */ }

  return events;
}

// percentile 函数已收敛到 src/trace/digest.ts 统一导出，此处通过 import 复用

// ─── 退化告警通知（T9.3）───

/**
 * 将健康报告中的告警推送到 webhook（飞书/钉钉/Slack 兼容的 text 消息体）。
 *
 * webhook URL 来源（优先级）：
 *   1. 显式传入的 opts.webhookUrl
 *   2. 环境变量 SID_CODE_ALERT_WEBHOOK_URL
 *
 * 无 URL 或无告警时静默跳过（返回 { sent: false }）。
 * 网络失败不抛异常（返回 { sent: false, error }），避免告警本身成为故障源。
 */
export async function sendHealthAlerts(
  report: HealthReport,
  opts?: { webhookUrl?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ sent: boolean; error?: string }> {
  const webhookUrl = opts?.webhookUrl ?? process.env.SID_CODE_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false };
  if (report.alerts.length === 0) return { sent: false };

  // P1-8：essential-traffic 门控。告警 webhook 是**非必要外发**——把本机 provider
  // 健康数据（含模型名、错误分型、延迟分位）推到第三方 IM 机器人，必须受最严格
  // 隐私级别约束。此前它只看 URL 配没配，从不问隐私级别，是两条绕过 sink 的
  // 外发通道之一（另一条是 trace 上传，见 query/init-helpers.ts 同批修复）。
  //
  // 同步 import：本模块已在遥测链路内，且 privacy-level.ts 零依赖、无副作用。
  if (isEssentialTrafficOnly()) {
    return { sent: false, error: "essential-traffic 隐私级别禁止非必要外发" };
  }

  const text = formatAlertText(report);

  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort("alert-webhook-timeout"), timeoutMs);
  if (opts?.signal) {
    opts.signal.addEventListener("abort", () => ctl.abort("external-abort"), { once: true });
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 飞书自定义机器人格式；钉钉/Slack 亦兼容 text 字段结构
      body: JSON.stringify({ msg_type: "text", content: { text } }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      return { sent: false, error: `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把告警渲染成纯文本消息体（webhook 用）。 */
export function formatAlertText(report: HealthReport): string {
  const lines = [`⚠️ [sid-code] Provider 健康告警 · 周期 ${report.periodLabel}`];
  for (const a of report.alerts) {
    const icon = a.severity === "critical" ? "✘" : "⚡";
    lines.push(`${icon} [${a.provider}] ${a.message}`);
  }
  return lines.join("\n");
}

/**
 * T15.5：把健康报告渲染成**无 ANSI 颜色**的纯文本看板，供 `/trace --health`
 * 命令面板复用（与 scripts/provider-health.ts 的彩色版共享同一数据结构，
 * 但命令面板固定纯文本，避免 ANSI 码污染）。
 */
export function renderHealthText(report: HealthReport): string {
  const out: string[] = [];
  out.push(`Provider 健康度 · 周期 ${report.periodLabel} · 生成 ${report.generatedAt.slice(11, 19)}`);

  if (report.providers.length === 0) {
    out.push("  无数据（指定时间范围内无 events.jsonl 事件）");
    return out.join("\n");
  }

  // 告警区
  if (report.alerts.length > 0) {
    out.push("  ⚠ 告警:");
    for (const a of report.alerts) {
      const icon = a.severity === "critical" ? "✘" : "⚡";
      out.push(`    ${icon} [${a.provider}] ${a.message}`);
    }
  }

  // 表格
  out.push(
    `  ${"Provider".padEnd(14)} ${"请求".padStart(5)} ${"成功率".padStart(7)} ` +
    `${"超时".padStart(4)} ${"重试".padStart(4)} ${"TTFT P50".padStart(9)} ${"TTFT P95".padStart(9)} ${"P95延迟".padStart(9)}`,
  );
  out.push("  " + "─".repeat(70));

  for (const p of report.providers) {
    const successRate = p.requests.total > 0
      ? (p.requests.succeeded / p.requests.total * 100).toFixed(1) + "%"
      : "N/A";
    const s = (ms?: number) => (ms ? `${(ms / 1000).toFixed(1)}s` : "-");
    out.push(
      `  ${p.provider.padEnd(14)} ` +
      `${String(p.requests.total).padStart(5)} ` +
      `${successRate.padStart(7)} ` +
      `${String(p.requests.timedOut).padStart(4)} ` +
      `${String(p.requests.retried).padStart(4)} ` +
      `${s(p.latency.ttft_p50).padStart(9)} ` +
      `${s(p.latency.ttft_p95).padStart(9)} ` +
      `${s(p.latency.total_p95).padStart(9)}`,
    );
    // P2-3：命中/未命中分桶 TTFT —— "缓存让首字快了多少"的唯一对照口径。
    // 文案走 formatTtftBucketLine，与 /trace 单会话视图逐字一致（同一函数）。
    if (p.latency.ttftByCache) {
      const line = formatTtftBucketLine(p.latency.ttftByCache, p.latency.ttftBucketDropped, {
        noDimension: p.latency.ttftNoDimension,
      });
      if (line) out.push(`    └ ${line}`);
    }
    if (Object.keys(p.timeouts.byLayer).length > 0) {
      const layers = Object.entries(p.timeouts.byLayer).map(([k, v]) => `${k}:${v}`).join(" ");
      out.push(`    超时分布: ${layers}`);
    }
  }

  // 重试/降级汇总
  const totalRetries = report.providers.reduce((s, p) => s + p.retries.total, 0);
  const totalFallbacks = report.providers.reduce((s, p) => s + p.retries.fallbackTriggered, 0);
  const totalExhausted = report.providers.reduce((s, p) => s + p.retries.exhausted, 0);
  if (totalRetries > 0 || totalFallbacks > 0) {
    out.push(`  重试: ${totalRetries}  降级: ${totalFallbacks}  重试耗尽: ${totalExhausted}`);
  }

  return out.join("\n");
}
