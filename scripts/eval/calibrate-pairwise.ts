#!/usr/bin/env bun
/**
 * calibrate-pairwise.ts — Pairwise judge calibration runner（T-13）
 *
 * 用法：
 *   bun run scripts/eval/calibrate-pairwise.ts --judge claude-sonnet-4-5-20250929
 *   bun run scripts/eval/calibrate-pairwise.ts --judge gpt-4o --pairs evals/_judge/calibration-set/pairs.jsonl
 *
 * 设计：
 *   - 读 evals/_judge/calibration-set/pairs.jsonl（每行一个 CalibrationPair）
 *   - 每 pair 跑两遍：AB 顺序 + BA 顺序
 *   - 量化 position bias / accuracy / verdict flip rate
 *   - 输出：results-{date}-{judge}.jsonl + summary-{date}-{judge}.md
 *
 * 校准指标见 evals/_judge/calibration-set/README.md。
 *
 * 注意：本脚本依赖 ANTHROPIC_API_KEY 调真实 judge。CI 环境下应跑 dry-run 模式
 * （不实际调 API，仅做 schema 验证）—— --dry-run 开关。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type {
  CalibrationPair,
  CalibrationVerdict,
  CalibrationSummary,
} from "../../evals/_judge/calibration-set/types.ts";

const PAIRS_DEFAULT = "evals/_judge/calibration-set/pairs.jsonl";
const OUT_DIR = "evals/_judge/calibration-set";

const PAIRWISE_PROMPT = `你是评分裁判。给你两份 agent 对同一用户问题的回答（标号 1 和 2），请判断哪份更准确。

=== 用户问题 ===
{{USER_QUERY}}

=== 回答 1 ===
{{RESPONSE_FIRST}}

=== 回答 2 ===
{{RESPONSE_SECOND}}

请仅输出 JSON: {"winner": "1" | "2" | "tie", "reason": "简短理由（不超过 50 字）"}`;

interface RunOptions {
  judge: string;
  pairsPath: string;
  outDir: string;
  dryRun: boolean;
}

async function loadPairs(path: string): Promise<CalibrationPair[]> {
  if (!existsSync(path)) {
    console.warn(`[calibrate-pairwise] pair 文件不存在: ${path}`);
    console.warn(`  → 框架已就位，但 100 对 pair 数据待写入。详见 ${OUT_DIR}/README.md`);
    return [];
  }
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
  return lines.map((l) => JSON.parse(l) as CalibrationPair);
}

async function runOnePair(
  client: Anthropic,
  judge: string,
  pair: CalibrationPair,
  order: "AB" | "BA",
  dryRun: boolean,
): Promise<CalibrationVerdict> {
  const first = order === "AB" ? pair.response_A : pair.response_B;
  const second = order === "AB" ? pair.response_B : pair.response_A;
  const prompt = PAIRWISE_PROMPT.replace("{{USER_QUERY}}", pair.user_query)
    .replace("{{RESPONSE_FIRST}}", first.slice(0, 8000))
    .replace("{{RESPONSE_SECOND}}", second.slice(0, 8000));

  let pick: "first" | "second" | "tie" | "error" = "error";
  let reason = "";

  if (dryRun) {
    pick = "first"; // 占位
    reason = "[dry-run] 跳过真实调用";
  } else {
    try {
      const resp = await client.messages.create({
        model: judge,
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      const m = text.match(/\{[^{}]*\}/);
      if (!m) {
        reason = `judge 返回非 JSON: ${text.slice(0, 100)}`;
      } else {
        const obj = JSON.parse(m[0]) as { winner?: string; reason?: string };
        if (obj.winner === "1") pick = "first";
        else if (obj.winner === "2") pick = "second";
        else if (obj.winner === "tie") pick = "tie";
        reason = String(obj.reason ?? "");
      }
    } catch (err) {
      reason = `judge 异常: ${(err as Error).message}`;
    }
  }

  // 标准化：first/second 还原为 A/B
  let normalized: "A" | "B" | "tie" | "error";
  if (pick === "tie" || pick === "error") {
    normalized = pick;
  } else if (order === "AB") {
    normalized = pick === "first" ? "A" : "B";
  } else {
    normalized = pick === "first" ? "B" : "A";
  }

  const correct = normalized === pair.ground_truth_winner;

  return {
    pair_id: pair.pair_id,
    judge,
    order,
    judge_pick: pick,
    normalized_winner: normalized,
    reason,
    correct,
    tested_at: new Date().toISOString(),
  };
}

function summarize(verdicts: CalibrationVerdict[], judge: string): CalibrationSummary {
  const byPair = new Map<string, CalibrationVerdict[]>();
  for (const v of verdicts) {
    if (!byPair.has(v.pair_id)) byPair.set(v.pair_id, []);
    byPair.get(v.pair_id)!.push(v);
  }

  const ab = verdicts.filter((v) => v.order === "AB");
  const ba = verdicts.filter((v) => v.order === "BA");
  const accuracyAB = ab.length > 0 ? ab.filter((v) => v.correct).length / ab.length : 0;
  const accuracyBA = ba.length > 0 ? ba.filter((v) => v.correct).length / ba.length : 0;

  // position bias：AB 顺序选 A 比例 vs BA 顺序选 A 比例
  const abPickA =
    ab.length > 0 ? ab.filter((v) => v.normalized_winner === "A").length / ab.length : 0;
  const baPickA =
    ba.length > 0 ? ba.filter((v) => v.normalized_winner === "A").length / ba.length : 0;
  const positionBias = Math.abs(abPickA - baPickA);

  // verdict flip rate：同 pair 在 AB / BA 下结论不一致的比例
  let flipped = 0;
  let totalPaired = 0;
  for (const [, vs] of byPair) {
    if (vs.length !== 2) continue;
    totalPaired++;
    const a = vs.find((v) => v.order === "AB");
    const b = vs.find((v) => v.order === "BA");
    if (a && b && a.normalized_winner !== b.normalized_winner) flipped++;
  }
  const verdictFlipRate = totalPaired > 0 ? flipped / totalPaired : 0;

  return {
    judge,
    total_pairs: byPair.size,
    position_bias: Number(positionBias.toFixed(4)),
    accuracy_AB: Number(accuracyAB.toFixed(4)),
    accuracy_BA: Number(accuracyBA.toFixed(4)),
    accuracy_avg: Number(((accuracyAB + accuracyBA) / 2).toFixed(4)),
    verdict_flip_rate: Number(verdictFlipRate.toFixed(4)),
    by_category: {},
  };
}

function renderSummaryMd(summary: CalibrationSummary, judge: string, datestamp: string): string {
  return `# Pairwise Calibration — ${judge} @ ${datestamp}

## 核心指标

| 指标 | 数值 | 评级 |
|---|---|---|
| total_pairs | ${summary.total_pairs} | ${summary.total_pairs >= 100 ? "✅ 达标（≥100）" : "⚠️ 不足"} |
| accuracy_avg | ${(summary.accuracy_avg * 100).toFixed(1)}% | ${summary.accuracy_avg >= 0.7 ? "✅ 可信" : "⚠️ 低"} |
| position_bias | ${(summary.position_bias * 100).toFixed(1)}% | ${summary.position_bias < 0.05 ? "✅ 良好" : summary.position_bias < 0.1 ? "🟡 边缘" : "🔴 强偏置"} |
| verdict_flip_rate | ${(summary.verdict_flip_rate * 100).toFixed(1)}% | ${summary.verdict_flip_rate < 0.1 ? "✅ 稳定" : summary.verdict_flip_rate < 0.15 ? "🟡 警惕" : "🔴 严重"} |

## 触发动作

${summary.position_bias >= 0.05 ? "- ⚠️ position_bias ≥ 5% → 启用 swap+average（每 case 跑 AB + BA 取均值）\n" : ""}${summary.accuracy_avg < 0.7 ? "- ⚠️ accuracy_avg < 70% → 启用 T-12 ensemble（多 judge majority vote）\n" : ""}${summary.verdict_flip_rate >= 0.15 ? "- 🔴 verdict_flip_rate ≥ 15% → judge 不可信，告警 + 回退 anchor 主导\n" : ""}${summary.position_bias < 0.05 && summary.accuracy_avg >= 0.7 && summary.verdict_flip_rate < 0.15 ? "✅ 全部指标达标，judge 当前可信" : ""}

## 详细分顺序

- AB 顺序 accuracy: ${(summary.accuracy_AB * 100).toFixed(1)}%
- BA 顺序 accuracy: ${(summary.accuracy_BA * 100).toFixed(1)}%

详见 \`results-${datestamp}-${judge}.jsonl\`。
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      judge: { type: "string", default: "claude-sonnet-4-5-20250929" },
      pairs: { type: "string", default: PAIRS_DEFAULT },
      "out-dir": { type: "string", default: OUT_DIR },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const opts: RunOptions = {
    judge: values.judge as string,
    pairsPath: resolve(values.pairs as string),
    outDir: resolve(values["out-dir"] as string),
    dryRun: Boolean(values["dry-run"]),
  };

  console.log(`[calibrate-pairwise] judge=${opts.judge} dry-run=${opts.dryRun}`);
  const pairs = await loadPairs(opts.pairsPath);
  if (pairs.length === 0) {
    console.log("[calibrate-pairwise] 0 pair，退出（框架就绪，等待数据填充）");
    return;
  }

  const client = new Anthropic();
  const verdicts: CalibrationVerdict[] = [];
  for (const p of pairs) {
    const ab = await runOnePair(client, opts.judge, p, "AB", opts.dryRun);
    const ba = await runOnePair(client, opts.judge, p, "BA", opts.dryRun);
    verdicts.push(ab, ba);
    console.log(
      `  ${p.pair_id}: AB=${ab.normalized_winner}/${ab.correct ? "✓" : "✗"}  BA=${ba.normalized_winner}/${ba.correct ? "✓" : "✗"}`,
    );
  }

  const datestamp = new Date().toISOString().slice(0, 10);
  if (!existsSync(opts.outDir)) mkdirSync(opts.outDir, { recursive: true });
  const judgeSafe = opts.judge.replace(/[^a-zA-Z0-9-]/g, "_");
  const resultsPath = join(opts.outDir, `results-${datestamp}-${judgeSafe}.jsonl`);
  writeFileSync(resultsPath, verdicts.map((v) => JSON.stringify(v)).join("\n"), "utf-8");

  const summary = summarize(verdicts, opts.judge);
  const summaryPath = join(opts.outDir, `summary-${datestamp}-${judgeSafe}.md`);
  writeFileSync(summaryPath, renderSummaryMd(summary, opts.judge, datestamp), "utf-8");

  console.log(`[calibrate-pairwise] 写入:`);
  console.log(`  ${resultsPath} (${verdicts.length} verdicts)`);
  console.log(`  ${summaryPath}`);
  console.log(
    `  position_bias=${summary.position_bias} accuracy_avg=${summary.accuracy_avg} flip_rate=${summary.verdict_flip_rate}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

// 暴露 summarize 给单测
export { summarize, renderSummaryMd };
