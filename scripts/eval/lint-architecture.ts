#!/usr/bin/env bun
/**
 * 架构纪律 lint 脚本（E-14 / P-11）
 *
 * 2 个规则：
 *   E-14 每个 Skill 目录含 SKILL.md + Known Limitations 段（scope=packages/core/src/skill/builtin/）
 *   P-11 core_code commit 拆分检查（scope=git 历史）
 *
 * 用法：
 *   bun run scripts/eval/lint-architecture.ts
 *   exit code 0 = 全 pass；exit 1 = 有违规（CI 红）
 *   bun run scripts/eval/lint-architecture.ts --rules E-14   # 只跑指定规则
 *
 * 原有 E-01 / E-02 / E-15 / E-16 四条已删除：它们扫的是本仓已不存在的文档目录
 * （`docs/adr/`、`docs/specs/` + `docs/rfcs/`、`docs/weekly-eval-report/`）。
 *
 * **刻意删除而不是留着让它空转**：这四条规则都以 `if (!existsSync(dir)) return []`
 * 开头，目录不存在时会「0 finding」通过 —— 那是一道永远不会红的门禁，
 * 比没有门禁更糟，因为它让人以为还有人在管。
 *
 * 注意：lint 是"宁严勿松"，违反时打印具体文件 + 缺失行，方便修复。
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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

// ============================================================
// E-14: 每个 Skill 目录含 SKILL.md + Known Limitations 段
// ============================================================
const ruleE14: LintRule = {
  id: "E-14",
  description: "每个 Skill 目录含 SKILL.md + Known Limitations 段",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    const builtinDir = join(ROOT, "packages/core/src/skill/builtin");
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
          file: `packages/core/src/skill/builtin/${skillName}/SKILL.md`,
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
          file: `packages/core/src/skill/builtin/${skillName}/SKILL.md`,
          message: "SKILL.md 缺 Known Limitations 段（M0 阶段允许 warn，S3+ 必须有）",
        });
      }
    }
    return findings;
  },
};

// ============================================================
// P-11: commit 触及 src/agent/ src/tool/ src/llm/ ≥ 3 个文件 + 无 Reviewed-by trailer → warn
// ============================================================
const ruleP11: LintRule = {
  id: "P-11",
  description: "core_code commit 拆分检查(≥ 3 个内核文件须带 Reviewed-by trailer)",
  run(): LintFinding[] {
    const findings: LintFinding[] = [];
    // P2-2 分包：三个内核目录都归 core 包。**同时保留旧前缀**——本规则扫的是
    // `git log -n 10` 的历史 commit，分包提交之前的那些 commit 里路径仍是 `src/agent/` 等。
    // 只留新前缀会让规则在历史 commit 上静默失效（漏判），只留旧前缀则对新 commit 失效。
    const KERNEL_PREFIXES = [
      "packages/core/src/agent/",
      "packages/core/src/tool/",
      "packages/core/src/llm/",
      // 分包前的历史路径（滚动窗口越过分包提交后可删）
      "src/agent/",
      "src/tool/",
      "src/llm/",
    ];
    let commits: string[] = [];
    try {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      commits = execSync("git log -n 10 --format=%H", { cwd: ROOT, encoding: "utf-8" })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      // git 不可用时静默 pass(CI 兼容)
      return findings;
    }

    for (const sha of commits) {
      let files: string[] = [];
      let body = "";
      try {
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        files = execSync(`git show --pretty=format: --name-only ${sha}`, {
          cwd: ROOT,
          encoding: "utf-8",
        })
          .trim()
          .split("\n")
          .filter(Boolean);
        body = execSync(`git show -s --format=%B ${sha}`, { cwd: ROOT, encoding: "utf-8" });
      } catch {
        continue;
      }
      const kernelFiles = files.filter((f) => KERNEL_PREFIXES.some((p) => f.startsWith(p)));
      if (kernelFiles.length < 3) continue;
      const hasReviewBy = /Reviewed-by:/i.test(body);
      const hasAdrRef = /ADR-\d{3}/i.test(body);
      const hasFixTypeTrailer = /fix_type:\s*(core_code|new_module)/i.test(body);
      if (!hasReviewBy && !hasAdrRef && !hasFixTypeTrailer) {
        findings.push({
          rule: "P-11",
          severity: "warn",
          file: `commit ${sha.slice(0, 8)}`,
          message: `触及 ${kernelFiles.length} 个内核文件但缺 Reviewed-by/ADR/fix_type trailer (CLAUDE.md §0.3.1.1)`,
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
  const allRules: LintRule[] = [ruleE14, ruleP11];
  const filter = parseRulesFlag();
  const rules = filter ? allRules.filter((r) => filter.has(r.id)) : allRules;

  console.log(`架构 lint：跑 ${rules.length} 条规则`);
  console.log("=".repeat(60));

  const allFindings: LintFinding[] = [];
  for (const rule of rules) {
    const findings = rule.run();
    allFindings.push(...findings);
    const passEmoji = findings.length === 0 ? "✅" : "❌";
    console.log(`${passEmoji} ${rule.id} ${rule.description} —— ${findings.length} finding`);
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

export { ruleE14, ruleP11 };
