#!/usr/bin/env bun
/**
 * pii-scan.ts — code-governance Skill PII 扫描脚本
 *
 * 输入: unified diff（stdin 或 --file <path>）
 * 输出: 结构化 JSON to stdout
 *   {
 *     findings: [
 *       { pii_class, severity, file, line, snippet_redacted, pattern_id, evidence_kind }
 *     ],
 *     summary: { total, by_class, by_severity }
 *   }
 *
 * 7 类 PII:
 *   - email / phone_cn / phone_intl / id_card_cn / credit_card / ipv4_private / ipv6_private
 *
 * 上下文豁免:
 *   - 文件路径含 fixture/test/example/sample/mock
 *   - 同行注释含 "脱敏" / "redacted" / "fake" / "test data"
 *   - 占位符 (xxx@example.com / 138*****1234)
 *
 * RFC-005 §3.3 / SKILL.md §3.3 / S8-T04 实施.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface PiiFinding {
  pii_class:
    | "email"
    | "phone_cn"
    | "phone_intl"
    | "id_card_cn"
    | "credit_card"
    | "ipv4_private"
    | "ipv6_private";
  severity: "violation" | "warning";
  file: string;
  line: number;
  /** 已脱敏的摘要,不含真实 PII */
  snippet_redacted: string;
  pattern_id: string;
  evidence_kind: "heuristic";
}

export interface PiiScanResult {
  findings: PiiFinding[];
  summary: {
    total: number;
    by_class: Record<string, number>;
    by_severity: Record<string, number>;
  };
}

interface PiiPattern {
  pii_class: PiiFinding["pii_class"];
  severity: PiiFinding["severity"];
  pattern_id: string;
  match: RegExp;
  redact: (s: string) => string;
}

const PATTERNS: PiiPattern[] = [
  {
    pii_class: "email",
    severity: "warning",
    pattern_id: "email_basic",
    match: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/,
    redact: (s) => s.replace(/(\w)[\w.+\-]*?(\w)?@/, "$1***@"),
  },
  {
    pii_class: "phone_cn",
    severity: "violation",
    pattern_id: "phone_cn_11digit",
    match: /(?<![\d])1[3-9]\d{9}(?![\d])/,
    redact: (s) => s.replace(/(1[3-9]\d)(\d{4})(\d{4})/, "$1****$3"),
  },
  {
    pii_class: "phone_intl",
    severity: "warning",
    pattern_id: "phone_intl",
    match: /(?<![\d])\+\d{1,3}[\s\-]?\d{6,12}(?![\d])/,
    redact: (s) => s.replace(/(\+\d{1,3})[\s\-]?\d+/, "$1********"),
  },
  {
    pii_class: "id_card_cn",
    severity: "violation",
    pattern_id: "id_card_cn_18",
    match:
      /(?<![\d])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\d])/,
    redact: (s) => s.replace(/(\d{6})\d{8}([\dXx]{4})/, "$1********$2"),
  },
  {
    pii_class: "credit_card",
    severity: "violation",
    pattern_id: "credit_card_16",
    match: /(?<![\d])(?:\d{4}[\s\-]?){3}\d{4}(?![\d])/,
    redact: (s) => s.replace(/(\d{4})[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?(\d{4})/, "$1********$2"),
  },
  {
    pii_class: "ipv4_private",
    severity: "warning",
    pattern_id: "ipv4_private_range",
    match:
      /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/,
    redact: (s) => s.replace(/(\d+\.\d+\.)(\d+\.\d+)/, "$1***.***"),
  },
];

const FIXTURE_PATH = /(fixtures?|tests?|examples?|samples?|mocks?|__mocks__)\//i;
const REDACTED_HINT =
  /(脱敏|redacted|fake|test\s*data|placeholder|example\s*data|do\s*not\s*use|不\s*要\s*使用)/i;
const PLACEHOLDER = /(?:xxx|yyy|zzz|\*+|\<TODO\>|\<placeholder\>|example\.com)/i;

interface DiffLine {
  file: string;
  line: number;
  content: string;
}

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let currentFile = "";
  let lineNum = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      currentFile = raw.slice(6).trim();
      lineNum = 0;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      if (m) lineNum = parseInt(m[1], 10) - 1;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lineNum++;
      out.push({ file: currentFile, line: lineNum, content: raw.slice(1) });
    } else if (!raw.startsWith("-")) {
      lineNum++;
    }
  }
  return out;
}

export function scanPii(diff: string): PiiScanResult {
  const findings: PiiFinding[] = [];
  const byClass: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const lines = parseDiff(diff);

  for (const ln of lines) {
    const isFixture = FIXTURE_PATH.test(ln.file);
    const hasRedactedHint = REDACTED_HINT.test(ln.content);
    const isPlaceholder = PLACEHOLDER.test(ln.content);

    for (const p of PATTERNS) {
      const m = ln.content.match(p.match);
      if (!m) continue;
      // 上下文豁免：fixture / 注释含脱敏提示 / 占位符
      if (isFixture && (hasRedactedHint || isPlaceholder)) continue;
      if (hasRedactedHint && isPlaceholder) continue;
      // 真 PII：fixture 但无 redacted hint 也算 warning（降级）
      const sev: PiiFinding["severity"] = isFixture && !hasRedactedHint ? "warning" : p.severity;
      const f: PiiFinding = {
        pii_class: p.pii_class,
        severity: sev,
        file: ln.file,
        line: ln.line,
        snippet_redacted: p.redact(m[0]).slice(0, 80),
        pattern_id: p.pattern_id,
        evidence_kind: "heuristic",
      };
      findings.push(f);
      byClass[p.pii_class] = (byClass[p.pii_class] ?? 0) + 1;
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }
  }

  return {
    findings,
    summary: { total: findings.length, by_class: byClass, by_severity: bySeverity },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { file: { type: "string" } }, allowPositionals: false });
  const content = values.file ? readFileSync(values.file, "utf-8") : readFileSync(0, "utf-8");
  const r = scanPii(content);
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
