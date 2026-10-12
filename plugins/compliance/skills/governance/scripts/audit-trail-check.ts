#!/usr/bin/env bun
/**
 * audit-trail-check.ts — code-governance Skill 审计 trail 检查
 *
 * 输入: unified diff + 可选 commit message（stdin 或 --file <path> --commit-msg <text>）
 * 输出: 结构化 JSON
 *   {
 *     missing_adr: [{ file, reason, high_risk_path, suggested_adr_section }],
 *     audit_trail_status: "complete" | "incomplete",
 *     summary: { total_high_risk_files, missing_count }
 *   }
 *
 * 高风险路径列表 (默认):
 *   - src/auth/ / src/payment/ / src/data/export/ / src/permission/ / src/llm/hooks/
 *   - 任何 .env / config.prod / *.deploy.yaml
 *
 * 完整 vs 缺失判定:
 *   - 高风险文件改动且 commit_msg 含 "ADR-NNN" 或文件 ≥ 1 个新 ADR-NNN.md → complete
 *   - 否则 → incomplete (warning, 不阻断)
 *
 * RFC-005 §3.5 / SKILL.md §3.5 / S8-T04 实施.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface AuditMissing {
  file: string;
  reason: string;
  high_risk_path: string;
  suggested_adr_section: string;
}

export interface AuditTrailResult {
  missing_adr: AuditMissing[];
  audit_trail_status: "complete" | "incomplete";
  summary: {
    total_high_risk_files: number;
    missing_count: number;
    matched_adr_ids: string[];
  };
}

const HIGH_RISK_PATHS: Array<{ pattern: RegExp; reason: string; section: string }> = [
  { pattern: /^src\/auth\//, reason: "auth 鉴权变更必须有 ADR", section: "鉴权设计 / 攻击面分析" },
  {
    pattern: /^src\/payment\//,
    reason: "payment 资金链路变更必须有 ADR",
    section: "资金链路 / 异常补偿",
  },
  {
    pattern: /^src\/data\/export\//,
    reason: "数据导出变更必须有 ADR",
    section: "数据出境 / 脱敏策略",
  },
  {
    pattern: /^src\/permission\//,
    reason: "permission 系统变更必须有 ADR",
    section: "权限边界 / 红线守护",
  },
  {
    pattern: /^src\/llm\/hooks\//,
    reason: "LLM hook 变更必须有 ADR (secret-redact 类)",
    section: "Hook 守护点",
  },
  {
    pattern: /\.env(\.|$)/,
    reason: ".env 配置变更必须有 ADR / 不应提交真值",
    section: "Secret 管理",
  },
  { pattern: /config\.prod/, reason: "生产配置变更必须有 ADR", section: "生产配置 / 灰度回滚" },
  { pattern: /\.deploy\.ya?ml$/, reason: "部署配置变更必须有 ADR", section: "部署蓝图 / 灰度策略" },
];

function extractFiles(diff: string): string[] {
  const files: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) files.push(raw.slice(6).trim());
  }
  return Array.from(new Set(files));
}

function extractAdrIds(commitMsg: string, diff: string): string[] {
  const ids = new Set<string>();
  const re = /ADR-(\d{3,})/g;
  for (const text of [commitMsg, diff]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ids.add(`ADR-${m[1]}`);
  }
  return Array.from(ids);
}

function newAdrFiles(diff: string): string[] {
  // 增量行有 +++ b/docs/adr/ADR-NNN-*.md 视为新增 ADR
  const out: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/docs/adr/ADR-")) out.push(raw.slice(6).trim());
  }
  return Array.from(new Set(out));
}

export function checkAuditTrail(diff: string, commitMsg: string = ""): AuditTrailResult {
  const files = extractFiles(diff);
  const adrIds = extractAdrIds(commitMsg, diff);
  const newAdrs = newAdrFiles(diff);
  const hasAdrEvidence = adrIds.length > 0 || newAdrs.length > 0;

  const missing: AuditMissing[] = [];
  let highRiskCount = 0;

  for (const file of files) {
    for (const rule of HIGH_RISK_PATHS) {
      if (!rule.pattern.test(file)) continue;
      highRiskCount++;
      if (hasAdrEvidence) break; // 全 PR 共享一份 ADR 引用即可
      missing.push({
        file,
        reason: rule.reason,
        high_risk_path: rule.pattern.source,
        suggested_adr_section: rule.section,
      });
      break;
    }
  }

  return {
    missing_adr: missing,
    audit_trail_status: missing.length === 0 ? "complete" : "incomplete",
    summary: {
      total_high_risk_files: highRiskCount,
      missing_count: missing.length,
      matched_adr_ids: adrIds,
    },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { file: { type: "string" }, "commit-msg": { type: "string" } },
    allowPositionals: false,
  });
  const content = values.file ? readFileSync(values.file, "utf-8") : readFileSync(0, "utf-8");
  const r = checkAuditTrail(content, values["commit-msg"] ?? "");
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
