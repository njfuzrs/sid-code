/**
 * 门禁 · 信号退出路径的遥测排空接线（2026-11-02 信号退出丢根 span 方案 A）
 *
 * ## 缺陷形态
 *
 * 10-01 起有模型调用的 498 个会话里 **283 个没有根 span**，其中 276 个以
 * `terminal_closed` / `abort` 结束；`/exit` 结束的 180 个里 178 个有根。
 *
 * 遥测队列只有两个出口：每 5 秒一次的定时刷新，和 `runShutdownSequence` 的 flush 阶段
 * （500ms 硬超时）。信号退出两个都赶不上 —— 根 span（只在 SessionEnd 里 `end()`）与最后
 * 几秒的子 span 留在内存里，随 `process.exit` 一起消失。
 *
 * ## 这个文件拦什么
 *
 * 1. 有人把 `drainTelemetry` 从 `onSignal` 里删掉 / 挪到 `process.exit` 之后；
 * 2. 有人把预算改成固定值（忽略已经耗在 SessionEnd 上的时间）；
 * 3. 有人把 1.5s 强退兜底加长（拍板上限：排空最多 450ms，整体退出时长不变）。
 *
 * 行为层由 `packages/core/tests/telemetry/span-persist-callback.test.ts`（bus 判据）、
 * `hook-probe.test.ts`（标记等落盘确认）与 `cli/tests/signal-teardown.test.ts`
 * （预算纯函数）覆盖。本文件只做静态接线检查，仿照
 * `trace-upload-exit-path-wiring.test.ts` 的写法。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_SRC = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf-8");
const SIGNAL_TEARDOWN_SRC = readFileSync(
  join(import.meta.dir, "../../src/signal-teardown.ts"),
  "utf-8",
);

/**
 * 取 `onSignal` 的函数体：从 `const onSignal = async (` 到它自己的结束 `\n    };`。
 * 函数体内部没有更浅缩进的 `};`，所以第一个匹配就是结尾。
 */
function onSignalBody(): string {
  const start = APP_SRC.indexOf("const onSignal = async (");
  expect(start).toBeGreaterThan(0);
  const end = APP_SRC.indexOf("\n    };", start);
  expect(end).toBeGreaterThan(start);
  return APP_SRC.slice(start, end);
}

describe("信号退出必须排空遥测（否则根 span 随进程消失）", () => {
  test("drainTelemetry 位于 SessionEnd 赛跑之后、process.exit 之前", () => {
    const body = onSignalBody();
    const sessionEnd = body.indexOf("fireSessionEndEvent");
    const drain = body.indexOf("const { drainTelemetry }");
    // 精确到调用形态：body 里的注释也写着 `process.exit()`（「1.2s 后就 process.exit()」），
    // 用裸 `process.exit(` 会命中那条注释，断言就变成恒假/恒真。
    const exit = body.indexOf("process.exit(exitCodeOf(signal))");
    expect(sessionEnd).toBeGreaterThan(0);
    expect(drain).toBeGreaterThan(sessionEnd);
    expect(exit).toBeGreaterThan(drain);
  });

  test("预算来自 telemetryDrainBudgetMs(自 onSignal 入口的已耗时)，不是固定值", () => {
    const body = onSignalBody();
    // signalStart 必须在 onSignal 最开头附近就取值：1.5s 兜底是从 armForceExit 开始走的
    expect(body).toContain("const signalStart = Date.now()");
    expect(body).toContain("telemetryDrainBudgetMs(Date.now() - signalStart)");
  });

  test("强退兜底用 SIGNAL_FORCE_EXIT_MS 常量，不再写字面量 1500（不许借排空加长退出时长）", () => {
    const body = onSignalBody();
    expect(body).toContain("armForceExit(exitCodeOf(signal), SIGNAL_FORCE_EXIT_MS)");
    expect(body).not.toMatch(/armForceExit\([^)]*,\s*\d{4}\s*\)/);
  });

  test("排空后打 telemetry drained= 日志（验收口径：数它判断 450ms 够不够）", () => {
    expect(onSignalBody()).toContain("telemetry drained=");
  });

  test("排空失败不抛（丢遥测可接受，挂起不可接受）", () => {
    const body = onSignalBody();
    const drain = body.indexOf("drainTelemetry");
    // drainTelemetry 调用必须落在 try 块里（catch 注释见 app.ts）
    expect(body.slice(Math.max(0, drain - 200), drain)).toContain("try {");
  });
});

describe("signal-teardown 里的预算常量与纯函数（拍板值）", () => {
  test("整体退出上限 1.5s、排空上限 450ms 都是导出常量", () => {
    expect(SIGNAL_TEARDOWN_SRC).toContain("export const SIGNAL_FORCE_EXIT_MS = 1500");
    expect(SIGNAL_TEARDOWN_SRC).toContain("export const SIGNAL_TELEMETRY_DRAIN_MAX_MS = 450");
  });

  test("预算函数是纯函数且带下限 0（剩余不足时跳过，不挤掉 log.flush）", () => {
    expect(SIGNAL_TEARDOWN_SRC).toContain("export function telemetryDrainBudgetMs(");
    expect(SIGNAL_TEARDOWN_SRC).toContain("Math.max(0, Math.min(SIGNAL_TELEMETRY_DRAIN_MAX_MS");
  });
});
