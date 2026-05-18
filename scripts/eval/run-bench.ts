/**
 * eval:bench — 跑 bench-runner（W9 Phase 4 入口）
 *
 * 用法：
 *   bun run eval:bench -- --split smoke --skip-llm-judge
 *   bun run eval:bench -- --split smoke --execute   # 真调 LLM Judge
 *   bun run eval:bench -- --task T0001              # 单 task 调试
 *
 * 默认走 sid-code-offline adapter（从 trajectory-platform 抽取已有 trajectory），
 * 不调 sid-code CLI（避免 W9 阶段引入 CLI 跑分依赖）。
 *
 * 输出：
 *   evals/raw-outputs/bench-results-<ts>.jsonl
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runBench, type RunConfig } from "../../evals/bench-runner/runner.ts";

const ROOT = process.cwd();
const TRAJ_PLATFORM = resolve(ROOT, "../trajectory-platform");
const BENCH_DIR = join(TRAJ_PLATFORM, "bench/tasks");
const SPLITS_DIR = join(TRAJ_PLATFORM, "bench/splits");
const TRAJ_DESENSITIZED = join(TRAJ_PLATFORM, "data/bench-staging/desensitized");
const META_FILE = join(TRAJ_PLATFORM, "data/bench-staging/meta/all-sessions.jsonl");
const RAW_DIR = join(ROOT, "evals/raw-outputs");

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "smoke" },
    task: { type: "string" },
    "skip-llm-judge": { type: "boolean", default: false },
    execute: { type: "boolean", default: false },
    "bench-dir": { type: "string" },
    "out-dir": { type: "string" },
  },
  allowPositionals: true,
});

const benchDir = values["bench-dir"] || BENCH_DIR;
const outDir = values["out-dir"] || RAW_DIR;
const skipLlm = values["skip-llm-judge"] || !values.execute;

if (!existsSync(benchDir)) {
  console.error(`✗ bench dir 不存在: ${benchDir}`);
  console.error(`  请确认 trajectory-platform/bench/tasks 已生成（Phase 2 产出）`);
  process.exit(1);
}
if (!existsSync(TRAJ_DESENSITIZED)) {
  console.error(`✗ trajectory 目录不存在: ${TRAJ_DESENSITIZED}`);
  process.exit(1);
}
if (!existsSync(META_FILE)) {
  console.error(`✗ meta 文件不存在: ${META_FILE}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const splitFile = values.task
  ? undefined
  : join(SPLITS_DIR, `${values.split}.txt`);

if (splitFile && !existsSync(splitFile)) {
  console.error(`✗ split 文件不存在: ${splitFile}`);
  process.exit(1);
}

const config: RunConfig = {
  benchDir,
  splitFile,
  outputDir: outDir,
  skipLlmJudge: skipLlm,
  adapter: "sid-code-offline",
  adapterConfig: {
    trajectoryDir: TRAJ_DESENSITIZED,
    metaFile: META_FILE,
  },
  judgeConfig: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
    model: process.env.JUDGE_MODEL || "claude-sonnet-4-6",
    promptPath: join(ROOT, "evals/_judge/prompt-v2.md"),
  },
};

console.log(`Mode      : ${values.execute ? "execute (real LLM judge)" : "skip-llm-judge (省钱模式)"}`);
console.log(`Adapter   : sid-code-offline (从 trajectory-platform 抽取)`);
console.log(`Split     : ${values.task ? `single task ${values.task}` : values.split}`);
console.log(`Bench dir : ${benchDir}`);
console.log(`Out dir   : ${outDir}`);
console.log("");

if (values.task) {
  // 单 task 调试模式：构造一次性 split 文件
  const tmpSplit = join(outDir, `_single-${values.task}.txt`);
  await Bun.write(tmpSplit, values.task + "\n");
  config.splitFile = tmpSplit;
}

const results = await runBench(config);

// 打印 W9 关键 sanity 指标
const fallbackCount = results.filter(
  (r) => r.agentSnapshot.exit_status === "fallback_missing_trajectory",
).length;
const zeroToolCount = results.filter((r) => r.agentSnapshot.tools_called.length === 0).length;

console.log(`\n  Sanity:`);
console.log(`    fallback_missing_trajectory: ${fallbackCount}/${results.length}`);
console.log(`    zero_tool_call           : ${zeroToolCount}/${results.length}`);
