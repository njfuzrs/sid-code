#!/usr/bin/env bun
/**
 * check-failure-taxonomy-coverage.ts —— B7-8 §13.4.4 护栏 3 判定
 *
 * 用途：
 *   读 _reports/sid-vs-claude/diff-*.json 中的 failure_modes[].code，对照失败分类法 v1
 *   （docs/eval/失败分类法-v1.md §1 表 14 个小类编码），统计 unknown_ratio。
 *
 * 判定规则（§13.4.4 护栏 3 + 失败分类法 v1 §3）：
 *   - unknown_ratio < 5%   → 绿灯（飞轮收敛，继续 v1）
 *   - 5% ≤ unknown_ratio ≤ 15% → 黄灯（评估单独加小类）
 *   - unknown_ratio > 15%  → 红灯（触发 v(N+1) 升级 + SKILL.md 对齐）
 *
 * Sprint 末毕业判定（§7.4）入参：
 *   退出码 0 = 绿/黄灯（不阻塞），1 = 红灯（Sprint 末毕业判定阻塞）
 *
 * 用法：
 *   # 默认读 _reports/sid-vs-claude/diff-*.json
 *   bun run scripts/eval/check-failure-taxonomy-coverage.ts
 *
 *   # 自定义路径（季度复检接 _reports/external/paired-Q?-*.json）
 *   bun run scripts/eval/check-failure-taxonomy-coverage.ts --diff-glob "_reports/external/paired-2026-Q3-*.json"
 *
 *   # JSON 输出（CI 用）
 *   bun run scripts/eval/check-failure-taxonomy-coverage.ts --json
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_DIFF_DIR = join(REPO_ROOT, "_reports/sid-vs-claude");
const DEFAULT_REPORT = join(REPO_ROOT, "_reports/failure-taxonomy-coverage.md");

/**
 * 失败分类法 v1 已定义的编码集合（来自 docs/eval/失败分类法-v1.md §1）。
 * 任何 failure_modes[].code 不在本集合 → 计为 unknown（新失败模式）。
 *
 * 升级路径：
 *   每次 §13.4.4 护栏 3 触发 v(N+1) 升级时，同步 update 本 set + bump 版本号。
 *   先改 set，再改 docs/eval/失败分类法-v1.md（避免代码与文档不同步）。
 */
export const FAILURE_TAXONOMY_V1 = new Set<string>([
  // Tool Selection
  "TS-01", "TS-02", "TS-03",
  // Execution Failure
  "EX-01", "EX-02",
  // Context Misuse
  "CTX-01", "CTX-02",
  // Output / Reasoning
  "OUT-01", "OUT-02", "OUT-03", "OUT-04",
  // Abort / Loop
  "ABORT-01", "ABORT-02",
  // Tool 调用异常
  "TOOL-01",
]);

export const TAXONOMY_VERSION = "v1";

export type CoverageStatus = "green" | "yellow" | "red";

export interface CoverageResult {
  total: number;
  knownCount: number;
  unknownCount: number;
  unknownRatio: number;
  status: CoverageStatus;
  threshold: { yellow: number; red: number };
  knownByCode: Record<string, number>;
  unknownCodes: Record<string, number>;
  taxonomyVersion: string;
  sourceFiles: string[];
}

const THRESHOLD_YELLOW = 0.05;
const THRESHOLD_RED = 0.15;

interface DiffFinding { code?: string; title?: string; severity?: string }
interface DiffEntry { task_id?: string; failure_modes?: DiffFinding[] }

/**
 * 评估一组 diff JSON 的失败模式覆盖率。
 *
 * 阈值语义（§13.4.4）：
 *   - red 用 ">" 严格大于：刚好 15% 算黄灯，不强制升 v(N+1)，避免一条新发现就把团队拽去做大版本升级
 *   - yellow 用 ">=" 包含 5%：5% 是有意义信号，应该提示评估
 */
export function classifyCoverage(diffs: DiffEntry[], sourceFiles: string[] = []): CoverageResult {
  const knownByCode: Record<string, number> = {};
  const unknownCodes: Record<string, number> = {};
  let knownCount = 0, unknownCount = 0;
  for (const d of diffs) {
    for (const fm of d.failure_modes ?? []) {
      const code = String(fm.code ?? "").trim();
      if (!code) continue;
      if (FAILURE_TAXONOMY_V1.has(code)) {
        knownByCode[code] = (knownByCode[code] ?? 0) + 1;
        knownCount++;
      } else {
        unknownCodes[code] = (unknownCodes[code] ?? 0) + 1;
        unknownCount++;
      }
    }
  }
  const total = knownCount + unknownCount;
  const unknownRatio = total === 0 ? 0 : unknownCount / total;
  let status: CoverageStatus;
  if (unknownRatio > THRESHOLD_RED) status = "red";
  else if (unknownRatio >= THRESHOLD_YELLOW) status = "yellow";
  else status = "green";
  return {
    total,
    knownCount,
    unknownCount,
    unknownRatio,
    status,
    threshold: { yellow: THRESHOLD_YELLOW, red: THRESHOLD_RED },
    knownByCode,
    unknownCodes,
    taxonomyVersion: TAXONOMY_VERSION,
    sourceFiles,
  };
}

interface CliArgs { diffGlob: string | null; json: boolean; reportPath: string }

function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = { diffGlob: null, json: false, reportPath: DEFAULT_REPORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--diff-glob") out.diffGlob = argv[++i] ?? null;
    else if (a === "--json") out.json = true;
    else if (a === "--report") out.reportPath = argv[++i] ?? DEFAULT_REPORT;
  }
  return out;
}

function loadDiffs(globOrDir: string | null): { diffs: DiffEntry[]; files: string[] } {
  const dir = globOrDir
    ? globOrDir.endsWith("/") || existsSync(globOrDir) && existsSync(join(globOrDir))
      ? globOrDir
      : dirname(globOrDir)
    : DEFAULT_DIFF_DIR;

  // 简化：只支持目录扫 + 命名前缀（不实现完整 glob）
  if (!existsSync(dir)) return { diffs: [], files: [] };
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("diff-") && f.endsWith(".json") && !f.startsWith("diff-summary") && f !== "paired-diff-summary.json")
    .map((f) => join(dir, f));
  const diffs: DiffEntry[] = [];
  for (const fp of files) {
    try {
      diffs.push(JSON.parse(readFileSync(fp, "utf-8")));
    } catch (e) {
      console.error(`[skip] ${fp}: ${(e as Error).message}`);
    }
  }
  return { diffs, files };
}

function renderMd(r: CoverageResult): string {
  const lines: string[] = [];
  const icon = r.status === "green" ? "🟢" : r.status === "yellow" ? "🟡" : "🔴";
  lines.push(`# B7-8 失败分类法 ${r.taxonomyVersion} 覆盖率报告（§13.4.4 护栏 3）`);
  lines.push(``);
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(`> 工具：scripts/eval/check-failure-taxonomy-coverage.ts`);
  lines.push(`> 输入：${r.sourceFiles.length} 条 paired comparison diff JSON`);
  lines.push(``);
  lines.push(`## 1. 判定`);
  lines.push(``);
  lines.push(`- 状态：${icon} **${r.status.toUpperCase()}**`);
  lines.push(`- unknown_ratio：**${(r.unknownRatio * 100).toFixed(1)}%**（known=${r.knownCount} / unknown=${r.unknownCount} / total=${r.total}）`);
  lines.push(`- 阈值：yellow ≥ ${(r.threshold.yellow * 100).toFixed(0)}% / red > ${(r.threshold.red * 100).toFixed(0)}%`);
  lines.push(``);
  if (r.status === "green") lines.push(`- 决策：飞轮收敛（v1 在新一轮数据上 ≥ 95% 覆盖），继续 v1，不触发升级`);
  else if (r.status === "yellow") lines.push(`- 决策：评估是否新增 1-2 个小类（不整体升 v2），并 patch 进 docs/eval/失败分类法-v1.md`);
  else lines.push(`- 决策：**触发 v(N+1) 升级** + SKILL.md 与新分类法对齐 + bump GRADER_VERSION（§0.3.1）`);
  lines.push(``);
  lines.push(`## 2. 已知编码命中`);
  lines.push(``);
  lines.push(`| code | 命中次数 |`);
  lines.push(`| --- | ---: |`);
  for (const [code, n] of Object.entries(r.knownByCode).sort((a, b) => b[1] - a[1])) lines.push(`| \`${code}\` | ${n} |`);
  if (Object.keys(r.knownByCode).length === 0) lines.push(`| _（无）_ | 0 |`);
  lines.push(``);
  if (Object.keys(r.unknownCodes).length > 0) {
    lines.push(`## 3. 新失败模式（不在 v1 表中）`);
    lines.push(``);
    lines.push(`| 未识别 code | 命中次数 |`);
    lines.push(`| --- | ---: |`);
    for (const [code, n] of Object.entries(r.unknownCodes).sort((a, b) => b[1] - a[1])) lines.push(`| \`${code}\` | ${n} |`);
    lines.push(``);
    lines.push(`> 这些编码未在 \`FAILURE_TAXONOMY_V1\` 集合（docs/eval/失败分类法-v1.md §1）中。需要：`);
    lines.push(`> 1. 阅读 raw diff JSON 的 \`failure_modes[].title/evidence\` 字段，确认是否真的是新模式（vs typo）`);
    lines.push(`> 2. 如果真是新模式：决定是 patch v1（小变化）还是 bump v2（大变化）`);
    lines.push(`> 3. 同步 update \`scripts/eval/check-failure-taxonomy-coverage.ts\` 中的 \`FAILURE_TAXONOMY_V1\` set + 文档`);
    lines.push(``);
  }
  lines.push(`## 4. 输入文件`);
  lines.push(``);
  for (const f of r.sourceFiles) lines.push(`- ${f}`);
  return lines.join("\n");
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const { diffs, files } = loadDiffs(args.diffGlob);
  const result = classifyCoverage(diffs, files);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write("\n");
  } else {
    const icon = result.status === "green" ? "🟢" : result.status === "yellow" ? "🟡" : "🔴";
    console.log(`[B7-8 护栏 3] taxonomy=${result.taxonomyVersion}  ${icon} ${result.status.toUpperCase()}`);
    console.log(`  total=${result.total}  known=${result.knownCount}  unknown=${result.unknownCount}`);
    console.log(`  unknown_ratio=${(result.unknownRatio * 100).toFixed(1)}%  阈值 yellow≥${(result.threshold.yellow * 100).toFixed(0)}% red>${(result.threshold.red * 100).toFixed(0)}%`);
    if (result.status === "red") {
      console.log(`  ❌ Sprint 末毕业判定（§7.4）阻塞——请先升级失败分类法到 v(N+1)`);
    }
  }

  mkdirSync(dirname(args.reportPath), { recursive: true });
  writeFileSync(args.reportPath, renderMd(result), "utf-8");
  if (!args.json) console.log(`  报告：${args.reportPath}`);

  // 退出码：red → 1（阻塞），green/yellow → 0
  process.exit(result.status === "red" ? 1 : 0);
}

if (import.meta.main) main();
