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
  renderHealthLines,
  sendHealthAlerts,
  type HealthColor,
} from "@sid-code/core/telemetry/provider-health.ts";

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
//
// P2-7：渲染实现已收口到 core 的 `renderHealthLines`，本文件只提供 ANSI 上色钩子。
// 此前这里有一份手写的彩色渲染，与 `renderHealthText`（供 /trace --health）列宽、
// 标题、缩进全都不同 —— "同一份数据在两个入口逐行一致"这个验收标准结构上不可能成立。
// 现在两边同源，唯一差别就是有没有传 colorize。

const ANSI: Record<HealthColor | "reset", string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function c(color: HealthColor, text: string): string {
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

if (!alertOnly) console.log(renderHealthLines(report, { colorize: c }).join("\n"));

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
