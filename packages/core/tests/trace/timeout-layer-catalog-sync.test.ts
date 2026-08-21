/**
 * PR11 哨兵：超时层清单不许漂移，且每一层都必须真的会 emit
 *
 * ## 拦的是什么
 *
 * 本文档记录的排查里，方向被带偏整整一轮，成因是两层防线**开枪不留痕**：
 * `Counter({'fallback_stream_timeout': 24})` 看似铁证"100% 是这一层触发"，
 * 实则结构性地只能看到三个闸门中的一个 —— watchdog 只发 `WatchdogKill`、
 * `fetchAbsoluteTimeoutMs` 把 deadline 委托给 runtime，两者都不写 `TimeoutFired`。
 *
 * 这类缺陷的恶劣之处在于**它的症状与"健康"完全相同**：某一层显示零触发，
 * 读起来就像"它从没出过故障"，没人会去查是不是根本没接线。
 *
 * 所以有两类断言：
 *   · 清单同步：`scripts/telemetry-trigger-rate.ts` 的手写副本 == `TimeoutLayer` 联集。
 *     手写清单在本仓有多次漂移前科，漏一层就等于给自己造一个永久零触发的假象。
 *   · 接线存在：每一层在源码里都能找到 emit 点。⚠️ 这一条只证"有发射点"，
 *     不证"生产里被触发过" —— 后者要跑 `scripts/telemetry-trigger-rate.ts` 看真轨迹，
 *     静态测试无论怎么写都替代不了它。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const OBSERVER_SRC = readFileSync(
  join(import.meta.dir, "../../src/trace/stream-observer.ts"),
  "utf8",
);
const SCRIPT_SRC = readFileSync(
  join(import.meta.dir, "../../../../scripts/telemetry-trigger-rate.ts"),
  "utf8",
);

/** 从 `TimeoutLayer` 的类型声明里抽出全部层名（唯一真相源）。 */
function layersFromType(): string[] {
  const m = OBSERVER_SRC.match(/export type TimeoutLayer =([\s\S]*?);\n/);
  expect(m, "没找到 TimeoutLayer 的类型声明 —— 本哨兵的取数源变了，先修哨兵").toBeTruthy();
  return [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

/** 从脚本的 `TIMEOUT_LAYERS` 数组里抽出手写副本。 */
function layersFromScript(): string[] {
  const m = SCRIPT_SRC.match(/const TIMEOUT_LAYERS = \[([\s\S]*?)\];/);
  expect(m, "没找到 TIMEOUT_LAYERS 数组 —— 取数源变了，先修哨兵").toBeTruthy();
  return [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

describe("PR11 — 超时层清单同步", () => {
  test("类型联集与脚本手写清单逐项一致", () => {
    const fromType = layersFromType().sort();
    const fromScript = layersFromScript().sort();
    // 断言集合相等而不只是长度：长度相等但内容不同（改名漏同步）同样会造成
    // "旧名恒零触发 + 新名不被统计"，两个方向都要拦。
    expect(fromScript, "脚本清单漏项/多项 —— 补清单，不要删断言").toEqual(fromType);
  });

  test("每一层都有 emit 点（隐身层是本文档的原始缺陷）", () => {
    // 三个 provider/loop 文件 + observer 自身：覆盖全部 emitTimeoutFired 调用方。
    const sources = [
      OBSERVER_SRC,
      readFileSync(join(import.meta.dir, "../../src/llm/openai.ts"), "utf8"),
      readFileSync(join(import.meta.dir, "../../src/llm/anthropic.ts"), "utf8"),
      readFileSync(join(import.meta.dir, "../../src/llm/fallback.ts"), "utf8"),
      readFileSync(join(import.meta.dir, "../../src/llm/stream-lifecycle.ts"), "utf8"),
      readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf8"),
      readFileSync(join(import.meta.dir, "../../src/agent/agentic-loop.ts"), "utf8"),
    ].join("\n");
    const missing = layersFromType().filter((layer) => !sources.includes(`"${layer}"`));
    expect(missing, "这些层在源码里找不到 emit 点 —— 它们会永久显示零触发").toEqual([]);
  });

  test("PR11：watchdog 与 fetchAbsolute 不再复用他人的层名", () => {
    // watchdog 此前往快照里 push `turn_hard_timeout` 冒充档③。那个复用有害：
    // 档③是"整轮不感知进展的绝对计时"，watchdog 是"快照里的无进展时长"，
    // 谓词不同。混名之后"档③开枪了几次"永远算不对 —— 而那正是判断
    // "新阶梯有没有被架空"的关键数。
    expect(OBSERVER_SRC).toContain('emitTimeoutFired(index, "watchdog_kill"');
    expect(OBSERVER_SRC, "emitWatchdogKill 不该再 push turn_hard_timeout 冒充档③").not.toContain(
      'snapshot.timeoutsFired.push("turn_hard_timeout")',
    );
  });
});
