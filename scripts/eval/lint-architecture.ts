#!/usr/bin/env bun
/**
 * 架构纪律 lint 脚本（E-01 / E-02 / E-14 / E-15 / E-16）
 *
 * 出处：docs/eval/09-研发智能基座-eval详细清单.md §E 类
 *      docs/eval/TODO.md S2-T11
 *
 * 5 个规则：
 *   E-01 ADR 必须标注"垂直场景需求来源"（底座加固 ADR，scope=ADR-019+）
 *   E-02 底座加固 Spec / RFC 必须标注场景来源（scope=docs/specs/ + docs/rfcs/）
 *   E-14 每个 Skill 目录含 SKILL.md + Known Limitations 段
 *   E-15 M3/M6 阶段交付物含 RFC + Changelog + SLA（scope=docs/weekly-eval-report/sprint-S*.md）
 *   E-16 Buy vs Build 评估段：每个 Runtime 相关 ADR 必含
 *
 * 用法：
 *   bun run scripts/eval/lint-architecture.ts
 *   exit code 0 = 全 pass；exit 1 = 有违规（CI 红）
 *   bun run scripts/eval/lint-architecture.ts --rules E-01,E-14   # 只跑指定规则
 *
 * 注意：lint 是"宁严勿松"，违反时打印具体文件 + 缺失行，方便修复。
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

interface LintFinding {
  rule: string;
  severity: "error" | "warn";
  file: string;
  message: string;
}

interface LintRule {
  id: string;
  description: string;
  run(): LintFinding[];
}

/** 读文件，文件不存在返回 null（让规则自行决定如何处理缺失） */
function readSafe(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/** 列子目录（按字典序） */
function listDirs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((e) => statSync(join(dir, e)).isDirectory())
    .sort();
}

/** 列 .md 文件（递归一层） */
function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => e.endsWith(".md"))
    .map((e) => join(dir, e))
    .sort();
}

// ============================================================
// E-01: ADR 必须标注"垂直场景需求来源"
// ============================================================
const ruleE01: LintRule = {
  id: "E-01",
  description: "ADR 必须标注「垂直场景需求来源」段（底座加固 ADR）",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    const adrDir = join(ROOT, "docs/adr");
    const files = listMdFiles(adrDir);

    /** 元 ADR / 模板等不算"加固 ADR"，豁免名单（按文件名） */
    const exempted = new Set<string>([
      "_template.md",
      "ADR-000-启动评测体系.md",
      "ADR-001-W1从棕地路径切入.md",
      "ADR-002-语义去重阈值定为0.90.md",
      "ADR-004-bench-task-schema-v0.1.md",
      "ADR-012-W9离线adapter决策.md",
    ]);

    for (const f of files) {
      const name = basename(f);
      if (exempted.has(name)) continue;
      const content = readSafe(f);
      if (content === null) continue;
      // 仅"底座加固 ADR"必须标注；评测体系内部设计 ADR（Plan/Memory capability eval 系列）
      // 由 ADR header 的 "Phase: Sprint S<N>" + "capability 评测设计" 类标识判定豁免
      const isCapabilityDesignAdr =
        /capability\s*评测设计|live\s*adapter|plan-recovery\s*真机制/i.test(
          content,
        );
      if (isCapabilityDesignAdr) continue;
      if (!content.includes("垂直场景需求来源")) {
        findings.push({
          rule: this.id,
          severity: "error",
          file: f.replace(ROOT + "/", ""),
          message: '缺失"垂直场景需求来源"段（在 ADR header 或 §1.1 之前必须有）',
        });
      }
    }
    return findings;
  },
};

// ============================================================
// E-02: 底座加固 Spec / RFC 必须标注场景来源
// ============================================================
const ruleE02: LintRule = {
  id: "E-02",
  description: "底座加固 Spec / RFC 必须标注场景来源（场景驱动而非凭空设计）",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    const specsDir = join(ROOT, "docs/specs");
    const rfcsDir = join(ROOT, "docs/rfcs");
    const candidates = [
      ...(existsSync(specsDir) ? listMdFiles(specsDir) : []),
      ...(existsSync(rfcsDir) ? listMdFiles(rfcsDir) : []),
    ];

    for (const f of candidates) {
      const name = basename(f);
      // 模板 / 索引 / 宪法（不是底座加固，是产品宪法）豁免
      if (
        name === "_template.md" ||
        name === "README.md" ||
        name === "constitution.md" ||
        name.toLowerCase().startsWith("index")
      ) {
        continue;
      }
      const content = readSafe(f);
      if (content === null) continue;
      // 满足任一即视为已标注
      const ok =
        content.includes("垂直场景需求来源") ||
        content.includes("场景来源") ||
        content.includes("Problem") ||
        content.includes("## 1. Context");
      if (!ok) {
        findings.push({
          rule: this.id,
          severity: "error",
          file: f.replace(ROOT + "/", ""),
          message: "缺失场景来源标注（Problem / Context / 垂直场景需求来源 任一）",
        });
      }
    }
    return findings;
  },
};

// ============================================================
// E-14: 每个 Skill 目录含 SKILL.md + Known Limitations 段
// ============================================================
const ruleE14: LintRule = {
  id: "E-14",
  description: "每个 Skill 目录含 SKILL.md + Known Limitations 段",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    const builtinDir = join(ROOT, "src/skill/builtin");
    if (!existsSync(builtinDir)) {
      // M0 阶段没有 Skill 也算 pass，但 M3 起必至少有 1 个
      return findings;
    }
    const skills = listDirs(builtinDir);
    for (const skillName of skills) {
      const skillMd = join(builtinDir, skillName, "SKILL.md");
      const content = readSafe(skillMd);
      if (content === null) {
        findings.push({
          rule: this.id,
          severity: "error",
          file: `src/skill/builtin/${skillName}/SKILL.md`,
          message: "Skill 目录缺 SKILL.md",
        });
        continue;
      }
      const hasKnownLimits =
        content.includes("Known Limitations") ||
        content.includes("known_limitations") ||
        content.includes("已知限制");
      if (!hasKnownLimits) {
        findings.push({
          rule: this.id,
          severity: "warn",
          file: `src/skill/builtin/${skillName}/SKILL.md`,
          message:
            'SKILL.md 缺 Known Limitations 段（M0 阶段允许 warn，S3+ 必须有）',
        });
      }
    }
    return findings;
  },
};

// ============================================================
// E-15: 阶段交付物含 RFC + Changelog + SLA（M3/M6 严，S0~S2 宽）
// ============================================================
const ruleE15: LintRule = {
  id: "E-15",
  description: "阶段交付物含 RFC + Changelog + SLA（S3+ 严格，当前阶段 warn-only）",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    const reportDir = join(ROOT, "docs/weekly-eval-report");
    if (!existsSync(reportDir)) return findings;

    // 当前阶段（S0~S2）只检查 sprint-S*.md 是否存在；
    // S3+ 起加 RFC / Changelog / SLA 强校验
    const sprintReports = readdirSync(reportDir)
      .filter((e) => /^sprint-S\d+\.md$/.test(e))
      .sort();

    if (sprintReports.length === 0) {
      findings.push({
        rule: this.id,
        severity: "warn",
        file: "docs/weekly-eval-report/",
        message: "无任何 sprint-S*.md 报告（每个 Sprint 末必须落盘）",
      });
    }
    return findings;
  },
};

// ============================================================
// E-16: Buy vs Build 纪律：每次 Runtime 相关 ADR 含 Buy vs Build 评估段
// ============================================================
const ruleE16: LintRule = {
  id: "E-16",
  description: "Runtime 相关 ADR 含 Buy vs Build 评估段（默认 Buy 不自建 Runtime）",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    const adrDir = join(ROOT, "docs/adr");
    const files = listMdFiles(adrDir);

    for (const f of files) {
      const content = readSafe(f);
      if (content === null) continue;
      const isRuntimeRelated =
        /Runtime|Daemon|Loop|Permission|内核|kernel/i.test(content);
      if (!isRuntimeRelated) continue;
      // 必须含 Buy vs Build 评估或 rejected alternatives
      const ok =
        /Buy\s*vs\s*Build/i.test(content) ||
        content.includes("rejected alternatives") ||
        content.includes("Rejected Alternatives") ||
        content.includes("Alternatives") ||
        content.includes("被否决方案") ||
        content.includes("替代方案") ||
        content.includes("考虑过的其他方案");
      if (!ok) {
        findings.push({
          rule: this.id,
          severity: "warn",
          file: f.replace(ROOT + "/", ""),
          message:
            "Runtime 相关 ADR 缺 Buy vs Build 评估段（或 rejected alternatives）",
        });
      }
    }
    return findings;
  },
};

// ============================================================
// 主入口
// ============================================================
function parseRulesFlag(): Set<string> | null {
  const arg = process.argv.find((a) => a.startsWith("--rules="));
  if (!arg) {
    const idx = process.argv.indexOf("--rules");
    if (idx >= 0 && process.argv[idx + 1]) {
      return new Set(process.argv[idx + 1].split(","));
    }
    return null;
  }
  return new Set(arg.split("=")[1].split(","));
}

function main(): number {
  const allRules: LintRule[] = [ruleE01, ruleE02, ruleE14, ruleE15, ruleE16];
  const filter = parseRulesFlag();
  const rules = filter ? allRules.filter((r) => filter.has(r.id)) : allRules;

  console.log(`架构 lint：跑 ${rules.length} 条规则`);
  console.log("=".repeat(60));

  const allFindings: LintFinding[] = [];
  for (const rule of rules) {
    const findings = rule.run();
    allFindings.push(...findings);
    const passEmoji = findings.length === 0 ? "✅" : "❌";
    console.log(
      `${passEmoji} ${rule.id} ${rule.description} —— ${findings.length} finding`,
    );
    for (const f of findings) {
      const sev = f.severity === "error" ? "ERR " : "WARN";
      console.log(`   [${sev}] ${f.file}: ${f.message}`);
    }
  }

  console.log("=".repeat(60));
  const errors = allFindings.filter((f) => f.severity === "error").length;
  const warns = allFindings.filter((f) => f.severity === "warn").length;
  console.log(`总计：${errors} error / ${warns} warn`);

  return errors > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main());
}

export { ruleE01, ruleE02, ruleE14, ruleE15, ruleE16 };
