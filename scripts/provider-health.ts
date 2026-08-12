#!/usr/bin/env bun
/**
 * T15.3：Provider 健康度 CLI 看板
 *
 * 用法：
 *   bun run scripts/provider-health.ts [--period 1h|24h|7d] [--provider deepseek]
 *
 * 从最近 N 个会话的 events.jsonl 聚合各 provider 的健康指标并输出格式化看板。
 */

import {
  aggregateProviderHealth,
  sendHealthAlerts,
  type HealthReport,
} from "@sid-code/core/telemetry/provider-health.ts";
// P2-3：分桶行文案与命令面板共用（避免同一份数据在三个入口有三种说法）
import { formatTtftBucketLine } from "@sid-code/core/trace/ttft-cache-buckets.ts";

// ─── 参数解析 ───

const args = process.argv.slice(2);
let periodMs = 3600_000; // 默认 1h
let filterProvider: string | undefined;
let doAlert = false;
let alertOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--period" && args[i + 1]) {
    const v = args[++i];
    if (v === "1h") periodMs = 3600_000;
    else if (v === "24h") periodMs = 86400_000;
    else if (v === "7d") periodMs = 86400_000 * 7;
    else {
      console.error(`未知周期: ${v}，支持 1h/24h/7d`);
      process.exit(1);
    }
  } else if (args[i] === "--provider" && args[i + 1]) {
    filterProvider = args[++i];
  } else if (args[i] === "--alert") {
    // 检测到退化告警时推送到 webhook（SID_CODE_ALERT_WEBHOOK_URL）
    doAlert = true;
  } else if (args[i] === "--alert-only") {
    // 仅推送告警，不渲染看板（供 cron 静默运行）
    doAlert = true;
    alertOnly = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(
      "用法: bun run scripts/provider-health.ts [--period 1h|24h|7d] [--provider NAME] [--alert] [--alert-only]",
    );
    process.exit(0);
  }
}

// ─── 运行聚合 ───

const report = aggregateProviderHealth({ periodMs, provider: filterProvider });

// ─── 渲染看板 ───

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function c(color: keyof typeof ANSI, text: string): string {
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function renderReport(report: HealthReport): void {
  console.log("");
  console.log(
    c(
      "bold",
      `  ═══ Provider 健康度看板 ═══  周期: ${report.periodLabel}  生成: ${report.generatedAt.slice(11, 19)}`,
    ),
  );
  console.log("");

  if (report.providers.length === 0) {
    console.log(c("gray", "  无数据（指定时间范围内无 events.jsonl 事件）"));
    return;
  }

  // 告警区
  if (report.alerts.length > 0) {
    console.log(c("bold", "  ⚠ 告警:"));
    for (const alert of report.alerts) {
      const icon = alert.severity === "critical" ? c("red", "✘") : c("yellow", "⚡");
      console.log(`    ${icon} [${alert.provider}] ${alert.message}`);
    }
    console.log("");
  }

  // 表格
  const header = `  ${"Provider".padEnd(15)} ${"请求".padStart(6)} ${"成功率".padStart(7)} ${"超时".padStart(5)} ${"重试".padStart(5)} ${"TTFT P50".padStart(10)} ${"TTFT P95".padStart(10)} ${"P95 延迟".padStart(10)}`;
  console.log(c("gray", header));
  console.log(c("gray", "  " + "─".repeat(75)));

  for (const p of report.providers) {
    const successRate =
      p.requests.total > 0
        ? ((p.requests.succeeded / p.requests.total) * 100).toFixed(1) + "%"
        : "N/A";
    const rateColor =
      p.requests.total > 0 && p.requests.succeeded / p.requests.total < 0.95 ? "red" : "green";

    const ttftP50 = p.latency.ttft_p50 ? `${(p.latency.ttft_p50 / 1000).toFixed(1)}s` : "-";
    const ttftP95 = p.latency.ttft_p95 ? `${(p.latency.ttft_p95 / 1000).toFixed(1)}s` : "-";
    const totalP95 = p.latency.total_p95 ? `${(p.latency.total_p95 / 1000).toFixed(1)}s` : "-";

    const timeoutStr = String(p.requests.timedOut);
    const retryStr = String(p.requests.retried);

    console.log(
      `  ${c("cyan", p.provider.padEnd(15))} ` +
        `${String(p.requests.total).padStart(6)} ` +
        `${c(rateColor, successRate.padStart(7))} ` +
        `${(p.requests.timedOut > 0 ? c("yellow", timeoutStr) : timeoutStr).padStart(5 + (p.requests.timedOut > 0 ? 9 : 0))} ` +
        `${retryStr.padStart(5)} ` +
        `${ttftP50.padStart(10)} ` +
        `${ttftP95.padStart(10)} ` +
        `${totalP95.padStart(10)}`,
    );

    // P2-3：命中/未命中分桶 TTFT。文案与 /trace、/trace --health 共用同一函数
    // （formatTtftBucketLine），三个入口逐字一致 —— 同一份数据不该有三种说法。
    if (p.latency.ttftByCache) {
      const line = formatTtftBucketLine(p.latency.ttftByCache, p.latency.ttftBucketDropped, {
        colorize: (kind, text) => c(kind, text),
        noDimension: p.latency.ttftNoDimension,
      });
      if (line) console.log(`${"".padStart(18)}└ ${line}`);
    }

    // 超时分布详情
    if (Object.keys(p.timeouts.byLayer).length > 0) {
      const layers = Object.entries(p.timeouts.byLayer)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      console.log(c("gray", `${"".padStart(18)}超时分布: ${layers}`));
    }
  }

  console.log("");

  // 重试/降级汇总
  const totalRetries = report.providers.reduce((s, p) => s + p.retries.total, 0);
  const totalFallbacks = report.providers.reduce((s, p) => s + p.retries.fallbackTriggered, 0);
  const totalExhausted = report.providers.reduce((s, p) => s + p.retries.exhausted, 0);
  if (totalRetries > 0 || totalFallbacks > 0) {
    console.log(
      c("gray", `  重试: ${totalRetries}  降级: ${totalFallbacks}  重试耗尽: ${totalExhausted}`),
    );
    console.log("");
  }
}

if (!alertOnly) renderReport(report);

// ─── 退化告警推送（T9.3）───

if (doAlert || process.env.SID_CODE_ALERT_WEBHOOK_URL) {
  if (report.alerts.length > 0) {
    const result = await sendHealthAlerts(report);
    if (result.sent) {
      console.error("[provider-health] ✔ 告警已推送到 webhook");
    } else if (result.error) {
      console.error(`[provider-health] ⚠ 告警推送失败: ${result.error}`);
    } else if (doAlert && !process.env.SID_CODE_ALERT_WEBHOOK_URL) {
      console.error("[provider-health] ⚠ 未设置 SID_CODE_ALERT_WEBHOOK_URL，告警无法推送");
    }
  }
}

// 有 critical 告警时退出码非零（供 CI 判断）
const hasCritical = report.alerts.some((a) => a.severity === "critical");
if (hasCritical) process.exit(1);
