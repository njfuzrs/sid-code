#!/usr/bin/env bun
/**
 * detect-vulnerabilities.ts — security-audit Skill 启发式漏洞检测器
 *
 * 输入: unified diff 内容(stdin 或 --file <path>)
 * 输出: 结构化 JSON to stdout
 *   {
 *     findings: [
 *       { vuln_class, severity, file, line, snippet, cwe, owasp, evidence_kind }
 *     ],
 *     summary: { total, by_class, by_severity }
 *   }
 *
 * 8 类漏洞中,本脚本覆盖 5 类启发式可识别的:
 *   - injection (SQL / Command / Template)
 *   - secret_leak (硬编码 token / API key / password)
 *   - xss (innerHTML / dangerouslySetInnerHTML / document.write)
 *   - crypto_weak (MD5 / SHA1 / DES / 短 key / Math.random for crypto)
 *   - iac_misconfig (Dockerfile / k8s 常见误配)
 *
 * 另 3 类 (auth_bypass / cve_dependency / data_leak) 由 LLM 推理 / sca-audit 处理.
 *
 * RFC-003 §3.2 / SKILL.md §3.2 Step B 落地. S7-T04 Step 4 实施.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface Finding {
  vuln_class: "injection" | "secret_leak" | "xss" | "crypto_weak" | "iac_misconfig";
  severity: "blocker" | "high" | "medium" | "low";
  file: string;
  line: number;
  snippet: string;
  cwe: string;
  owasp: string;
  /** evidence_kind: heuristic | llm | sca | merged */
  evidence_kind: "heuristic";
  pattern_id: string;
}

export interface DetectionResult {
  findings: Finding[];
  summary: {
    total: number;
    by_class: Record<string, number>;
    by_severity: Record<string, number>;
  };
}

interface DetectorPattern {
  vuln_class: Finding["vuln_class"];
  severity: Finding["severity"];
  cwe: string;
  owasp: string;
  pattern_id: string;
  match: RegExp;
  /** 反例:命中下面任一正则就视为误报排除(避免敏感 keyword 在注释 / 字符串字面里被误标) */
  excludes?: RegExp[];
}

// 启发式 pattern 集合(覆盖 5 类,每类至少 2 条 pattern)
const PATTERNS: DetectorPattern[] = [
  // injection
  {
    vuln_class: "injection",
    severity: "blocker",
    cwe: "CWE-89",
    owasp: "A03:2021",
    pattern_id: "sql_string_concat",
    // db.query("SELECT ... WHERE id=" + userId) — 字符串拼接 SQL
    match: /(?:execute|query|exec)\s*\(\s*[`"'][^`"']*(?:\$\{[^}]+\}|['"`]\s*\+\s*\w)/,
  },
  {
    vuln_class: "injection",
    severity: "blocker",
    cwe: "CWE-89",
    owasp: "A03:2021",
    pattern_id: "sql_template_literal",
    match: /(?:select|update|delete|insert)\s+.*?\$\{[^}]+\}/i,
    excludes: [/\bparameterized\b|\?\s*\)|prepared/i],
  },
  {
    vuln_class: "injection",
    severity: "blocker",
    cwe: "CWE-78",
    owasp: "A03:2021",
    pattern_id: "command_injection_exec",
    match: /(?:execSync|exec|spawnSync|spawn)\s*\(\s*[`"'][^`"']*\$\{[^}]+\}/,
  },

  // secret_leak (与 secret-redact 互补,这里只看 diff 静态命中)
  {
    vuln_class: "secret_leak",
    severity: "blocker",
    cwe: "CWE-798",
    owasp: "A07:2021",
    pattern_id: "hardcoded_aws_key",
    match: /AKIA[0-9A-Z]{16}/,
  },
  {
    vuln_class: "secret_leak",
    severity: "blocker",
    cwe: "CWE-798",
    owasp: "A07:2021",
    pattern_id: "hardcoded_github_pat",
    match: /ghp_[A-Za-z0-9]{36}/,
  },
  {
    vuln_class: "secret_leak",
    severity: "high",
    cwe: "CWE-798",
    owasp: "A07:2021",
    pattern_id: "hardcoded_password_assign",
    match: /(?:password|passwd|pwd)\s*[:=]\s*['"](?!process\.env|<TODO|\$\{)[^'"]{6,}['"]/i,
    excludes: [/example|sample|placeholder|test/i],
  },
  {
    vuln_class: "secret_leak",
    severity: "high",
    cwe: "CWE-798",
    owasp: "A07:2021",
    pattern_id: "hardcoded_api_key",
    match:
      /(?:api[_-]?key|api[_-]?token|secret[_-]?key)\s*[:=]\s*['"](?!process\.env|<TODO|\$\{)[A-Za-z0-9]{16,}['"]/i,
  },

  // xss
  {
    vuln_class: "xss",
    severity: "high",
    cwe: "CWE-79",
    owasp: "A03:2021",
    pattern_id: "react_dangerously_set_inner_html",
    match: /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*[^}]+\}\}/,
  },
  {
    vuln_class: "xss",
    severity: "high",
    cwe: "CWE-79",
    owasp: "A03:2021",
    pattern_id: "innerHTML_user_input",
    match: /\.innerHTML\s*=\s*[^;]*\b(?:req\.|request\.|input|user|params|query|body)\b/,
  },
  {
    vuln_class: "xss",
    severity: "medium",
    cwe: "CWE-79",
    owasp: "A03:2021",
    pattern_id: "document_write",
    match: /document\.write\s*\(/,
  },

  // crypto_weak
  {
    vuln_class: "crypto_weak",
    severity: "high",
    cwe: "CWE-327",
    owasp: "A02:2021",
    pattern_id: "md5_for_security",
    match: /createHash\s*\(\s*['"]md5['"]\s*\)/i,
    excludes: [/\bcache[_-]?key|content[_-]?hash|etag|fingerprint\b/i],
  },
  {
    vuln_class: "crypto_weak",
    severity: "high",
    cwe: "CWE-327",
    owasp: "A02:2021",
    pattern_id: "sha1_for_security",
    match: /createHash\s*\(\s*['"]sha1['"]\s*\)/i,
    excludes: [/\bcache[_-]?key|content[_-]?hash|etag|fingerprint\b/i],
  },
  {
    vuln_class: "crypto_weak",
    severity: "high",
    cwe: "CWE-327",
    owasp: "A02:2021",
    pattern_id: "des_cipher",
    match: /createCipher(?:iv)?\s*\(\s*['"]des['"]/i,
  },
  {
    vuln_class: "crypto_weak",
    severity: "medium",
    cwe: "CWE-338",
    owasp: "A02:2021",
    pattern_id: "math_random_for_token",
    match: /Math\.random\(\)/,
    excludes: [/\b(?:test|sample|jitter|randomColor|animation|delay)\b/i],
  },

  // iac_misconfig
  {
    vuln_class: "iac_misconfig",
    severity: "high",
    cwe: "CWE-250",
    owasp: "A05:2021",
    pattern_id: "docker_run_as_root",
    match: /^USER\s+root\s*$/im,
  },
  {
    vuln_class: "iac_misconfig",
    severity: "medium",
    cwe: "CWE-1104",
    owasp: "A06:2021",
    pattern_id: "docker_latest_tag",
    match: /^FROM\s+\S+:latest\s*$/im,
  },
  {
    vuln_class: "iac_misconfig",
    severity: "high",
    cwe: "CWE-732",
    owasp: "A05:2021",
    pattern_id: "k8s_priv_container",
    match: /privileged\s*:\s*true/,
  },
  {
    vuln_class: "iac_misconfig",
    severity: "high",
    cwe: "CWE-200",
    owasp: "A05:2021",
    pattern_id: "k8s_host_network",
    match: /hostNetwork\s*:\s*true/,
  },
];

interface DiffLine {
  file: string;
  newLine: number; // 行号(添加方,1-based)
  text: string; // 不含 + 前缀
}

function parseDiffAddedLines(diff: string): DiffLine[] {
  const lines = diff.split(/\r?\n/);
  const out: DiffLine[] = [];
  let curFile = "";
  let curNew = 0;
  for (const ln of lines) {
    if (ln.startsWith("+++ b/")) {
      curFile = ln.slice(6).trim();
      continue;
    }
    if (ln.startsWith("+++ ")) {
      curFile = ln.slice(4).trim().replace(/^b\//, "");
      continue;
    }
    if (ln.startsWith("@@")) {
      const m = ln.match(/\+(\d+)/);
      curNew = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (ln.startsWith("+") && !ln.startsWith("+++")) {
      out.push({ file: curFile, newLine: curNew, text: ln.slice(1) });
      curNew++;
      continue;
    }
    if (ln.startsWith("-") && !ln.startsWith("---")) {
      // 删除行不前进 newLine
      continue;
    }
    if (ln.startsWith(" ")) {
      curNew++;
      continue;
    }
  }
  return out;
}

export function detectVulnerabilities(diff: string): DetectionResult {
  const added = parseDiffAddedLines(diff);
  const findings: Finding[] = [];

  for (const dl of added) {
    if (!dl.file) continue;
    for (const p of PATTERNS) {
      if (p.excludes && p.excludes.some((re) => re.test(dl.text))) continue;
      if (p.match.test(dl.text)) {
        findings.push({
          vuln_class: p.vuln_class,
          severity: p.severity,
          file: dl.file,
          line: dl.newLine,
          snippet: dl.text.slice(0, 200),
          cwe: p.cwe,
          owasp: p.owasp,
          evidence_kind: "heuristic",
          pattern_id: p.pattern_id,
        });
      }
    }
  }

  const by_class: Record<string, number> = {};
  const by_severity: Record<string, number> = {};
  for (const f of findings) {
    by_class[f.vuln_class] = (by_class[f.vuln_class] ?? 0) + 1;
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
  }

  return {
    findings,
    summary: {
      total: findings.length,
      by_class,
      by_severity,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: { file: { type: "string" } },
    allowPositionals: false,
  });
  let diff = "";
  if (values.file) {
    diff = readFileSync(values.file, "utf-8");
  } else {
    diff = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (c) =>
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string)),
      );
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
  }
  const result = detectVulnerabilities(diff);
  process.stdout.write(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
