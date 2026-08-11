#!/usr/bin/env bun
/**
 * compliance-export.ts — code-governance Skill 合规元数据导出
 *
 * 用途: 根据 PR diff + 可选业务方填的 risk_class，生成 EU AI Act 模型卡 / 中国算法备案 模板.
 *
 * 输入: unified diff + 可选 risk_class（low/limited/high/prohibited）
 * 输出: 结构化 JSON
 *   {
 *     eu_ai_act: { risk_class, requires_disclosure, requires_post_market_monitoring, suggested_template_section }
 *     china_aigc: { needs_filing, needs_security_assessment, suggested_template_section }
 *     summary: { auto_inferred_risk_class, files_touched }
 *   }
 *
 * 推断逻辑（保守）:
 *   - 含 face_recognition / faceid / 招聘评分 / 信用打分 / hiring_score → high
 *   - 含 LLM_API / chat / generation 接口 → limited
 *   - 含监控 / 监听 / 实时识别 → high
 *   - 否则 unknown
 *
 * RFC-005 §3.4 / SKILL.md §3.4 / S8-T04 实施.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export type EuRiskClass = "limited" | "high" | "prohibited" | "unknown";

export interface ComplianceExportResult {
  eu_ai_act: {
    risk_class: EuRiskClass;
    requires_disclosure: boolean;
    requires_post_market_monitoring: boolean;
    suggested_template_section: string;
  };
  china_aigc: {
    needs_filing: boolean;
    needs_security_assessment: boolean;
    suggested_template_section: string;
  };
  summary: {
    auto_inferred_risk_class: EuRiskClass;
    files_touched: number;
    triggers: string[];
  };
}

const HIGH_RISK_KEYWORDS = [
  "face_recognition",
  "facial_recognition",
  "faceid",
  "biometric",
  "hiring_score",
  "招聘评分",
  "credit_scoring",
  "信用打分",
  "real_time_identification",
  "live_face_match",
];

const PROHIBITED_KEYWORDS = [
  "social_scoring",
  "社会信用评分",
  "predictive_policing",
  "subliminal_manipulation",
];

const LIMITED_KEYWORDS = [
  "chatgpt",
  "claude",
  "gpt-",
  "llm_api",
  "generative_ai",
  "deepfake",
];

function classifyRisk(text: string): { risk: EuRiskClass; triggers: string[] } {
  const triggers: string[] = [];
  const lower = text.toLowerCase();
  for (const kw of PROHIBITED_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) triggers.push(`prohibited:${kw}`);
  }
  if (triggers.some((t) => t.startsWith("prohibited:"))) {
    return { risk: "prohibited", triggers };
  }
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) triggers.push(`high:${kw}`);
  }
  if (triggers.some((t) => t.startsWith("high:"))) {
    return { risk: "high", triggers };
  }
  for (const kw of LIMITED_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) triggers.push(`limited:${kw}`);
  }
  if (triggers.length > 0) return { risk: "limited", triggers };
  return { risk: "unknown", triggers };
}

function countFiles(diff: string): number {
  const files = new Set<string>();
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) files.add(raw.slice(6).trim());
  }
  return files.size;
}

export function exportCompliance(
  diff: string,
  manualRiskClass?: EuRiskClass,
): ComplianceExportResult {
  const { risk: inferred, triggers } = classifyRisk(diff);
  const final: EuRiskClass = manualRiskClass ?? inferred;
  const isHighOrProhibited = final === "high" || final === "prohibited";
  const isLimitedOrAbove = final === "limited" || isHighOrProhibited;

  return {
    eu_ai_act: {
      risk_class: final,
      requires_disclosure: isLimitedOrAbove,
      requires_post_market_monitoring: isHighOrProhibited,
      suggested_template_section:
        final === "prohibited"
          ? "AI Act Article 5: Prohibited Practices — 必须停止部署"
          : final === "high"
            ? "AI Act Annex III: High-Risk — 必须填模型卡 + post-market monitoring"
            : final === "limited"
              ? "AI Act Article 50: Transparency — 必须披露 AI 生成"
              : "无监管要求 (unknown)",
    },
    china_aigc: {
      needs_filing: isLimitedOrAbove,
      needs_security_assessment: isHighOrProhibited,
      suggested_template_section:
        isHighOrProhibited
          ? "《生成式 AI 服务管理办法》第 17 条 + 安全评估报告模板"
          : isLimitedOrAbove
            ? "《生成式 AI 服务管理办法》第 17 条 算法备案模板"
            : "无备案要求",
    },
    summary: { auto_inferred_risk_class: inferred, files_touched: countFiles(diff), triggers },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { file: { type: "string" }, "risk-class": { type: "string" } },
    allowPositionals: false,
  });
  const content = values.file ? readFileSync(values.file, "utf-8") : readFileSync(0, "utf-8");
  const manual = (values["risk-class"] as EuRiskClass | undefined) ?? undefined;
  const r = exportCompliance(content, manual);
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
