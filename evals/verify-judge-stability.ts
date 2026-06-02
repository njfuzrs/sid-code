#!/usr/bin/env bun
/**
 * verify-judge-stability.ts —— 验证 LLM judge 稳定性的独立脚本
 *
 * 目的：把"wrapper 输出波动"和"judge 评分波动"两个噪声源分离。
 * 用同一段固定 agent 输出 × N 次 judge 调用，直接测 judge 自身的方差。
 *
 * 修复前预期：跨次 score 标准差 > 0.2（temperature 默认 1.0 + max_tokens 256 截断 JSON）
 * 修复后预期：跨次 score 标准差 < 0.05（temperature 0 + max_tokens 2048）
 */

import { parse as parseYaml } from "yaml";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { gradeRubric } from "eval-framework/core/judge.ts";
import { buildRubricPrompt } from "eval-framework/judge/rubric-template.ts";
import type { CaseYaml } from "eval-framework/core/types.ts";

const ROOT = resolve(import.meta.dir);

interface Fixture {
  caseId: string;
  output: string;
  expectedRubric: number;
}

/**
 * 固定的 agent 输出 fixture（取自历史 _runs 数据，确保可复现）。
 * 选有方差问题的 case，看 judge 这次能不能稳定。
 */
const FIXTURES: Fixture[] = [
  {
    caseId: "case_015",
    // sid-code 历史输出（3 次评分 0.95 / 0.95 / 0.3 跨度极大）
    output: `现有测试已经在第 37 行覆盖了 \`currentCost === costLimit\`（10.0 / 10.0）的 case。但**真正的边界行为死角**是：**exceeded 之后再次调用 \`check\` 且 currentCost 仍等于阈值时，去重逻辑是否生效**（\`currentIdx (3) <= lastIdx (3)\` → 返回 null）。

这是你要的 \`it()\` 块：

\`\`\`ts
test("exceeded 后再次达到 100% 不重复告警", () => {
    const qm = new QuotaManager(10.0);
    // 第一次达到 100% → exceeded
    const r1 = qm.check(10.0);
    expect(r1).not.toBeNull();
    expect(r1!.level).toBe("exceeded");

    // 再次达到 100%（同级别，不重复）
    const r2 = qm.check(10.0);
    expect(r2).toBeNull();

    // 确认 isExceeded 仍为 true
    expect(qm.isExceeded(10.0)).toBe(true);
  });
\`\`\`

插入位置参考：第 51 行 \`超过 100% 也触发 exceeded\` 测试之后即可。`,
    expectedRubric: 0.6,
  },
  {
    caseId: "case_022",
    // sid-code 历史输出（3 次评分 0.3 / 0.95 / 0.95，跨度 2.84 分）
    output: `看完权限模块了，以下几个发现：

**现状总览**：15 个文件、746 行 \`checker.ts\`、14 步检查流程、7 种权限模式、8 来源规则系统、熔断器、macOS Seatbelt 沙箱——模块本身相当成熟。

**发现的明显问题**：
1. **零测试** — 整个 \`src/permission/\` 模块下 \`tests/\` 中找不到任何测试文件
2. \`checker.ts:378\` 有两个重复的 **Step 8** 标签（一个 for bypass、一个 for allow 规则）
3. \`check()\` 方法内混合了模式后处理（dontAsk / 非交互 / 熔断）和`,
    expectedRubric: 0.5,
  },
  {
    caseId: "case_002",
    // sid-code 输出违反 precision（混入 7 个 extra 工具到"6 个内置工具"中）
    output: `sid-code 实现了 **6 个核心内置工具**:

1. **read** \`src/tool/read.ts\`
2. **write** \`src/tool/write.ts\`
3. **edit** \`src/tool/edit.ts\`
4. **bash** \`src/tool/bash.ts\`
5. **grep** \`src/tool/grep.ts\`
6. **glob** \`src/tool/glob.ts\`

注：除这 6 个外，sid-code 还扩展了 \`ls\`、\`read-many\`、\`web-search\`、\`web-fetch\`、\`memory\`、\`enter-plan-mode\`、\`exit-plan-mode\` 等内置工具，共计 13 个内置工具。`,
    expectedRubric: 0.7, // 违反 precision 应被惩罚
  },
];

function loadCase(caseId: string): CaseYaml {
  for (const dir of ["p0-core", "p1-common", "p2-edge", "holdout"]) {
    const p = join(ROOT, dir, `${caseId}.yaml`);
    try {
      return parseYaml(readFileSync(p, "utf-8")) as CaseYaml;
    } catch { continue; }
  }
  throw new Error(`case 不存在: ${caseId}`);
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

async function main() {
  const N = parseInt(process.argv[2] || "5", 10);
  console.log(`[verify-judge-stability] N=${N} 次/fixture，共 ${FIXTURES.length} fixture`);
  console.log("");

  const rows: { caseId: string; scores: number[]; mean: number; stddev: number; min: number; max: number; range: number }[] = [];

  for (const fixture of FIXTURES) {
    const c = loadCase(fixture.caseId);
    const prompt = buildRubricPrompt(c);
    console.log(`▶ ${fixture.caseId} (expected ≈ ${fixture.expectedRubric}, output ${fixture.output.length} chars)`);
    const scores: number[] = [];
    for (let i = 0; i < N; i++) {
      const r = await gradeRubric(fixture.output, prompt);
      if (r.score === null) {
        console.log(`  [${i + 1}/${N}] judge 不可用: ${r.reason.slice(0, 80)}`);
        continue;
      }
      scores.push(r.score);
      console.log(`  [${i + 1}/${N}] score=${r.score.toFixed(3)} pass=${r.pass} reason=${r.reason.slice(0, 80)}...`);
    }
    if (scores.length === 0) continue;
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    const sd = stddev(scores);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    rows.push({ caseId: fixture.caseId, scores, mean, stddev: sd, min, max, range: max - min });
    console.log(`  → 均值=${mean.toFixed(3)} stddev=${sd.toFixed(4)} range=${(max - min).toFixed(3)} [${min.toFixed(2)}, ${max.toFixed(2)}]`);
    console.log("");
  }

  console.log("=== 汇总 ===");
  console.log(`${"case".padEnd(12)} ${"mean".padEnd(7)} ${"stddev".padEnd(7)} ${"range".padEnd(7)} ${"min".padEnd(5)} ${"max"}`);
  for (const r of rows) {
    console.log(`${r.caseId.padEnd(12)} ${r.mean.toFixed(3).padEnd(7)} ${r.stddev.toFixed(4).padEnd(7)} ${r.range.toFixed(3).padEnd(7)} ${r.min.toFixed(2).padEnd(5)} ${r.max.toFixed(2)}`);
  }

  const avgStddev = rows.reduce((s, r) => s + r.stddev, 0) / rows.length;
  const maxRange = Math.max(...rows.map(r => r.range));
  console.log("");
  console.log(`平均 stddev = ${avgStddev.toFixed(4)} (修复前历史值 > 0.20)`);
  console.log(`最大 range  = ${maxRange.toFixed(3)} (修复前历史值 > 0.65 i.e. 2.84/5 分制)`);

  if (avgStddev < 0.05 && maxRange < 0.15) {
    console.log("✅ judge 稳定性验证通过：stddev < 0.05 且 range < 0.15");
    process.exit(0);
  } else {
    console.log("⚠️  judge 稳定性仍未达预期");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[verify-judge-stability] fatal:", err);
  process.exit(2);
});
