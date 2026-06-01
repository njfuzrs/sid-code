#!/usr/bin/env bun
/**
 * 一次性脚本：从 _runs/<provider>.jsonl 末尾 12 条红线 case 的跑分反向回写
 * baseline_scores 到 evals/architecture/redline/*.yaml。
 *
 * 触发场景：S1-T15 第一次跑红线 baseline 时 baseline-sync.ts 还没认 architecture/ 子目录,
 * 跑了 595 秒但 0 case 回写。修好 baseline-sync 后,用本脚本免去重跑 595s。
 *
 * 仅用一次,跑完即可删除。
 */

import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { syncBaselineScores, type BaselineResult } from "../../evals/framework/core/baseline-sync.ts";
import { COST_FORMULA_VERSION, GRADER_VERSION } from "../../evals/framework/core/judge.ts";

const REDLINE_IDS = [
  "arch_redline_001",
  "arch_redline_002",
  "arch_redline_003",
  "arch_redline_004",
  "arch_redline_005",
  "arch_redline_006",
  "arch_redline_007",
  "arch_redline_008",
  "arch_redline_009",
  "arch_redline_011",
  "arch_redline_012",
  "arch_redline_013",
];

const ROOT = resolve(import.meta.dir, "../..");
const JSONL = join(ROOT, "evals/_runs/sid_code_deepseek_v4_pro.jsonl");

interface JsonlRow {
  case_id: string;
  provider: string;
  score: number | null;
  run_status: string;
  tested_at: string;
  named_scores?: Record<string, number | null>;
}

if (!existsSync(JSONL)) {
  console.error(`找不到 ${JSONL}`);
  process.exit(1);
}

// 取每个 case 最新一条
const lines = readFileSync(JSONL, "utf-8").split("\n").filter((l) => l.trim());
const latest = new Map<string, JsonlRow>();
for (const line of lines) {
  try {
    const row = JSON.parse(line) as JsonlRow;
    if (REDLINE_IDS.includes(row.case_id)) {
      const existing = latest.get(row.case_id);
      if (!existing || new Date(row.tested_at) > new Date(existing.tested_at)) {
        latest.set(row.case_id, row);
      }
    }
  } catch {
    // skip malformed
  }
}

console.log(`提取 ${latest.size} / ${REDLINE_IDS.length} 条红线 case 最新跑分`);

const results: BaselineResult[] = [];
for (const id of REDLINE_IDS) {
  const row = latest.get(id);
  if (!row) {
    console.warn(`⚠️  ${id} 没找到跑分数据`);
    continue;
  }
  results.push({
    caseId: row.case_id,
    provider: row.provider,
    score: row.score,
    runStatus: row.run_status,
    testedAt: row.tested_at,
    dimensions: row.named_scores ?? {},
    formulaVersion: { cost: COST_FORMULA_VERSION, grader: GRADER_VERSION },
  });
}

const updated = syncBaselineScores(results, {
  baseDir: join(ROOT, "evals"),
  testerLabel: "eval-runner",
});

console.log(`✅ 回写完成: ${updated} / ${results.length} 条 case yaml 已更新`);
