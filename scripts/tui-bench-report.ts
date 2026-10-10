#!/usr/bin/env bun
/**
 * 差分测试台指标报告（B9 / T0.4）：每个场景跑 N 轮，打印字节、full reset、OSC 计数与帧耗时分位数。
 *
 * 确定性指标（字节 / full reset / OSC）已经冻进 `term-bench/baseline/*.json` 由测试判定；
 * 帧耗时随机器负载抖动，不进基线、不做门禁，只在这里报告，换底座时人工对照（P2）。
 *
 * 用法：bun run tui:bench [--rounds 5] [S1 S3 …]
 */
import { percentile, runScenario } from "../packages/cli/tests/render-port/term-bench/harness.ts";
import { SCENARIOS } from "../packages/cli/tests/render-port/term-bench/scenarios.tsx";

const args = process.argv.slice(2);
const ri = args.indexOf("--rounds");
const rounds = ri >= 0 ? Number(args[ri + 1]) : 5;
const names = args.filter((a, i) => /^S\d+$/.test(a) && args[i - 1] !== "--rounds");
const selected = names.length > 0 ? names : Object.keys(SCENARIOS);

console.log(
  `场景   字节   2J  3J  sync  帧数   帧 p50   帧 p95   帧 p99  （${rounds} 轮合并，ms）`,
);
for (const name of selected) {
  const frames: number[] = [];
  let first: Awaited<ReturnType<typeof runScenario>> | undefined;
  for (let i = 0; i < rounds; i++) {
    const r = await runScenario(name);
    if (r.error) {
      console.log(`${name.padEnd(5)} ❌ ${r.error.split("\n")[0]}`);
      break;
    }
    first ??= r;
    frames.push(...r.perf.frames);
  }
  if (!first) continue;
  const t = first.total;
  const f = (p: number) => percentile(frames, p).toFixed(2).padStart(7);
  console.log(
    `${name.padEnd(5)} ${String(t.bytes).padStart(5)} ${String(t.eraseScreen).padStart(4)} ${String(t.eraseScrollback).padStart(3)} ${String(t.syncBegin).padStart(5)} ${String(frames.length / rounds).padStart(5)}  ${f(50)}  ${f(95)}  ${f(99)}`,
  );
}
