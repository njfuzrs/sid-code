#!/usr/bin/env bun
/**
 * classify-severity.ts — incident-rca Skill 严重级别分类
 *
 * 输入: incident 描述 + 可选 metrics（stdin 或 --file <path>）
 * 输出: 结构化 JSON
 *   {
 *     severity: "P0" | "P1" | "P2" | "P3",
 *     confidence: number (0-1),
 *     signals: [{ signal, weight, matched }],
 *     recommendation: string
 *   }
 *
 * 分类逻辑（确定性规则 + 信号加权）:
 *   P0: 全站不可用 / 数据丢失 / 安全事件
 *   P1: 核心功能降级 / 部分用户受影响 / SLA 违约
 *   P2: 非核心功能异常 / 性能下降 > 50%
 *   P3: 告警但无用户影响 / 日志异常
 *
 * RFC-004 §2.2 / SKILL.md §3.2 / S8-T11 Step 4 实施.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export type IncidentSeverity = "P0" | "P1" | "P2" | "P3";

export interface SeveritySignal {
  signal: string;
  weight: number;
  matched: boolean;
}

export interface SeverityClassification {
  severity: IncidentSeverity;
  confidence: number;
  signals: SeveritySignal[];
  recommendation: string;
}

interface SignalDef {
  signal: string;
  weight: number;
  pattern: RegExp;
  severity_hint: IncidentSeverity;
}

const SIGNAL_DEFS: SignalDef[] = [
  // P0 signals
  {
    signal: "全站不可用",
    weight: 1.0,
    pattern: /全站|全量|100%.*不可用|complete.*outage|total.*failure/i,
    severity_hint: "P0",
  },
  {
    signal: "数据丢失",
    weight: 1.0,
    pattern: /数据丢失|data.*loss|数据损坏|corruption/i,
    severity_hint: "P0",
  },
  {
    signal: "安全事件",
    weight: 1.0,
    pattern: /安全事件|security.*breach|unauthorized.*access|数据泄露/i,
    severity_hint: "P0",
  },
  {
    signal: "支付中断",
    weight: 0.9,
    pattern: /支付.*中断|payment.*fail|交易.*失败|资金/i,
    severity_hint: "P0",
  },
  // P1 signals
  {
    signal: "核心功能降级",
    weight: 0.7,
    pattern: /核心.*降级|core.*degraded|主流程.*异常|登录.*失败/i,
    severity_hint: "P1",
  },
  {
    signal: "部分用户受影响",
    weight: 0.6,
    pattern: /部分用户|partial.*users|部分.*受影响|某些.*无法/i,
    severity_hint: "P1",
  },
  {
    signal: "SLA 违约",
    weight: 0.7,
    pattern: /SLA.*违约|SLA.*breach|超时.*严重|latency.*spike/i,
    severity_hint: "P1",
  },
  {
    signal: "错误率飙升",
    weight: 0.6,
    pattern: /错误率.*飙升|error.*rate.*spike|5xx.*增加|异常.*增长/i,
    severity_hint: "P1",
  },
  // P2 signals
  {
    signal: "非核心功能异常",
    weight: 0.4,
    pattern: /非核心|non-critical|辅助.*功能|次要.*模块/i,
    severity_hint: "P2",
  },
  {
    signal: "性能下降",
    weight: 0.4,
    pattern: /性能.*下降|performance.*degradation|响应.*变慢|latency.*increase/i,
    severity_hint: "P2",
  },
  {
    signal: "单个服务异常",
    weight: 0.3,
    pattern: /单个.*服务|single.*service|某个.*pod|一个.*实例/i,
    severity_hint: "P2",
  },
  // P3 signals
  {
    signal: "告警无影响",
    weight: 0.2,
    pattern: /告警.*无影响|alert.*no.*impact|日志.*异常|log.*anomaly/i,
    severity_hint: "P3",
  },
  {
    signal: "自动恢复",
    weight: 0.2,
    pattern: /自动恢复|auto.*recover|已恢复|resolved.*automatically/i,
    severity_hint: "P3",
  },
];

export function classifySeverity(description: string): SeverityClassification {
  const signals: SeveritySignal[] = [];
  const severityScores: Record<IncidentSeverity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };

  for (const def of SIGNAL_DEFS) {
    const matched = def.pattern.test(description);
    signals.push({ signal: def.signal, weight: def.weight, matched });
    if (matched) {
      severityScores[def.severity_hint] += def.weight;
    }
  }

  // 选最高分的 severity
  let maxScore = 0;
  let severity: IncidentSeverity = "P3";
  for (const [sev, score] of Object.entries(severityScores) as [IncidentSeverity, number][]) {
    if (score > maxScore) {
      maxScore = score;
      severity = sev;
    }
  }

  // 无信号命中时默认 P2
  if (maxScore === 0) severity = "P2";

  const matchedCount = signals.filter((s) => s.matched).length;
  const confidence = Math.min(1, matchedCount > 0 ? maxScore / (matchedCount * 0.5 + 0.5) : 0.3);

  const recommendations: Record<IncidentSeverity, string> = {
    P0: "立即启动 War Room + 全员 oncall + 15 分钟内出 hotfix 或回滚",
    P1: "通知 oncall + 30 分钟内定位根因 + 1 小时内出 mitigation",
    P2: "下一个工作日处理 + 记录 incident ticket + 排期修复",
    P3: "记录日志 + 观察趋势 + 无需立即行动",
  };

  return {
    severity,
    confidence: Math.round(confidence * 100) / 100,
    signals,
    recommendation: recommendations[severity],
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { file: { type: "string" } }, allowPositionals: false });
  const content = values.file ? readFileSync(values.file, "utf-8") : readFileSync(0, "utf-8");
  const r = classifySeverity(content);
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
