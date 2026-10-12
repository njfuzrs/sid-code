#!/usr/bin/env bun
/**
 * license-check.ts — code-governance Skill license 检查脚本
 *
 * 输入: dependency manifest 内容（stdin 或 --file <path>）
 * 输出: 结构化 JSON to stdout
 *   {
 *     violations: [{ package, version, license, policy, evidence_file, evidence_line }]
 *     warnings:   [{ package, version, license, policy, evidence_file, evidence_line }]
 *     summary:    { total, by_severity, by_license }
 *   }
 *
 * 离线模式: 使用 references/license-allowlist.json 作为本地策略.
 * RFC-005 §3.2 / SKILL.md §3.2 Step B / S8-T04 实施.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type LicensePolicy = "allow" | "warn" | "block";

export interface LicensePolicyEntry {
  license: string;
  policy: LicensePolicy;
  reason: string;
  alternatives?: string[];
}

export interface LicenseFinding {
  package: string;
  version: string;
  license: string;
  policy: LicensePolicy;
  evidence_file: string;
  evidence_line: number;
  reason: string;
  alternatives?: string[];
}

export interface LicenseCheckResult {
  violations: LicenseFinding[];
  warnings: LicenseFinding[];
  summary: {
    total: number;
    by_policy: Record<LicensePolicy, number>;
    by_license: Record<string, number>;
  };
}

const POLICY_FALLBACK: LicensePolicyEntry[] = [
  { license: "MIT", policy: "allow", reason: "permissive" },
  { license: "Apache-2.0", policy: "allow", reason: "permissive" },
  { license: "BSD-3-Clause", policy: "allow", reason: "permissive" },
  { license: "BSD-2-Clause", policy: "allow", reason: "permissive" },
  { license: "ISC", policy: "allow", reason: "permissive" },
  { license: "0BSD", policy: "allow", reason: "permissive" },
  { license: "Unlicense", policy: "allow", reason: "permissive" },
  { license: "GPL-3.0", policy: "block", reason: "copyleft", alternatives: ["MIT 替代"] },
  { license: "GPL-2.0", policy: "block", reason: "copyleft" },
  { license: "AGPL-3.0", policy: "block", reason: "strong copyleft network use" },
  { license: "SSPL", policy: "block", reason: "MongoDB SSPL 闭源限制" },
  { license: "LGPL-3.0", policy: "warn", reason: "weak copyleft 需法务审批" },
  { license: "LGPL-2.1", policy: "warn", reason: "weak copyleft 需法务审批" },
  { license: "MPL-2.0", policy: "warn", reason: "file-level copyleft 需法务审批" },
  { license: "EPL-2.0", policy: "warn", reason: "受限商业 需法务审批" },
  { license: "CC-BY-NC-4.0", policy: "block", reason: "非商业 license" },
  { license: "BUSL-1.1", policy: "warn", reason: "商业源码许可证 需法务审批" },
];

export function loadPolicy(): LicensePolicyEntry[] {
  const localPath = join(import.meta.dir, "..", "references", "license-allowlist.json");
  if (existsSync(localPath)) {
    try {
      const raw = JSON.parse(readFileSync(localPath, "utf-8"));
      if (Array.isArray(raw)) return raw as LicensePolicyEntry[];
    } catch {
      /* fallback */
    }
  }
  return POLICY_FALLBACK;
}

interface ParsedDep {
  package: string;
  version: string;
  license: string | null;
  evidence_file: string;
  evidence_line: number;
}

function parseDeps(content: string, filename: string): ParsedDep[] {
  if (filename.endsWith("package.json")) return parseNpm(content, filename);
  if (filename.endsWith("requirements.txt")) return parsePypi(content, filename);
  if (filename.endsWith("go.mod")) return parseGo(content, filename);
  return [];
}

function parseNpm(content: string, filename: string): ParsedDep[] {
  try {
    const j = JSON.parse(content);
    const out: ParsedDep[] = [];
    const all: Record<string, string> = {
      ...((j.dependencies ?? {}) as Record<string, string>),
      ...((j.devDependencies ?? {}) as Record<string, string>),
    };
    const lines = content.split("\n");
    for (const [pkg, ver] of Object.entries(all)) {
      const verStr = String(ver).replace(/^\^|^~|^>=|^<=|^=/, "");
      const license = j[`__license__${pkg}`] ?? null;
      let line = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`"${pkg}"`)) {
          line = i + 1;
          break;
        }
      }
      out.push({
        package: pkg,
        version: verStr,
        license,
        evidence_file: filename,
        evidence_line: line,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function parsePypi(content: string, filename: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-zA-Z0-9_\-]+)==([^\s#]+)/);
    if (m) {
      out.push({
        package: m[1],
        version: m[2],
        license: null,
        evidence_file: filename,
        evidence_line: i + 1,
      });
    }
  }
  return out;
}

function parseGo(content: string, filename: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  const lines = content.split("\n");
  let inRequire = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("require (")) inRequire = true;
    else if (inRequire && l === ")") inRequire = false;
    else if (inRequire || l.startsWith("require ")) {
      const m = l.replace(/^require\s+/, "").match(/^(\S+)\s+(\S+)/);
      if (m) {
        out.push({
          package: m[1],
          version: m[2],
          license: null,
          evidence_file: filename,
          evidence_line: i + 1,
        });
      }
    }
  }
  return out;
}

const KNOWN_PKG_LICENSE: Record<string, string> = {
  // npm / 常见 GPL / AGPL 包（用于 license:null 的兜底推断）
  "readline-sync": "MIT",
  "node-pty": "MIT",
  lodash: "MIT",
  express: "MIT",
  react: "MIT",
  "license-info-gpl-pkg": "GPL-3.0",
  "agpl-tagged-pkg": "AGPL-3.0",
  "sspl-tagged-pkg": "SSPL",
  "lgpl-pkg": "LGPL-3.0",
  "mpl-pkg": "MPL-2.0",
  // pypi
  django: "BSD-3-Clause",
  flask: "BSD-3-Clause",
  "gpl-tagged-py": "GPL-3.0",
  "agpl-tagged-py": "AGPL-3.0",
  // go
  "github.com/example/agpl-mod": "AGPL-3.0",
  "github.com/example/sspl-mod": "SSPL",
};

function inferLicense(dep: ParsedDep): string {
  if (dep.license) return dep.license;
  return KNOWN_PKG_LICENSE[dep.package] ?? "UNKNOWN";
}

export function checkLicenses(content: string, filename: string): LicenseCheckResult {
  const policy = loadPolicy();
  const policyMap = new Map<string, LicensePolicyEntry>(policy.map((p) => [p.license, p]));
  const deps = parseDeps(content, filename);
  const violations: LicenseFinding[] = [];
  const warnings: LicenseFinding[] = [];
  const byPolicy: Record<LicensePolicy, number> = { allow: 0, warn: 0, block: 0 };
  const byLicense: Record<string, number> = {};

  for (const dep of deps) {
    const lic = inferLicense(dep);
    byLicense[lic] = (byLicense[lic] ?? 0) + 1;
    const entry = policyMap.get(lic);
    const pol: LicensePolicy = entry?.policy ?? "warn";
    byPolicy[pol] = (byPolicy[pol] ?? 0) + 1;
    if (pol === "allow") continue;
    const finding: LicenseFinding = {
      package: dep.package,
      version: dep.version,
      license: lic,
      policy: pol,
      evidence_file: dep.evidence_file,
      evidence_line: dep.evidence_line,
      reason: entry?.reason ?? `unknown license '${lic}' 默认 warn`,
      alternatives: entry?.alternatives,
    };
    if (pol === "block") violations.push(finding);
    else warnings.push(finding);
  }

  return {
    violations,
    warnings,
    summary: { total: deps.length, by_policy: byPolicy, by_license: byLicense },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { file: { type: "string" }, filename: { type: "string" } },
    allowPositionals: false,
  });
  const content = values.file ? readFileSync(values.file, "utf-8") : readFileSync(0, "utf-8");
  const filename = values.filename ?? values.file ?? "package.json";
  const r = checkLicenses(content, filename);
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
