/**
 * 门禁 · N12：app.ts 里 side_call_stats 的读写两端接线。
 *
 * 行为语义（基线回灌 / 不双计 / reset 不清基线）在
 * packages/core/tests/trace/p2-side-call-session-baseline.test.ts 覆盖；
 * 这里锁 app.ts 里那几行接线 —— restoreSession 是 9000+ 行 App 的私有路径，
 * 没有行为层接缝，与 checkpoint-session-id-wiring.test.ts 同一种静态门禁。
 *
 * 纯静态扫描：只 readFileSync，不落盘。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "app.ts"), "utf-8");

/** 取从 marker 开始、到下一个同缩进方法声明为止的一段（粗粒度定位，够用且不依赖行号）。 */
function section(marker: string, len = 4000): string {
  const i = appSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  return appSrc.slice(i, i + len);
}

describe("N12 · side_call_stats 读写两端", () => {
  test("扫描面非空", () => {
    expect(appSrc.length).toBeGreaterThan(100_000);
  });

  test("restoreSession 读取 side_call_stats 并回灌基线", () => {
    const body = section("async restoreSession(", 40_000);
    expect(body).toContain('metadata["side_call_stats"]');
    expect(body).toContain("hydrateSideCallBaseline(");
  });

  test("落盘与账本都取会话维度（getSessionSideStats），app.ts 不再用进程维度 getSideStats", () => {
    // 用进程维度落盘 = resume 后下一轮用「只含本进程」的值覆盖旧快照，历史直接丢
    expect(appSrc).not.toMatch(/\bgetSideStats\(/);
    expect(section("private persistUsageStats(")).toContain("getSessionSideStats()");
    expect(section("private buildLedgerSideUsage(")).toContain("getSessionSideStats()");
  });

  test("/clear 归零会话维度，并强制落一条归零快照", () => {
    const i = appSrc.indexOf("this.sessionState.resetCounters();");
    expect(i).toBeGreaterThan(-1);
    const clearBody = appSrc.slice(i, i + 3000);
    expect(clearBody).toContain("resetSessionSideStats();");
    expect(clearBody).toContain("this.sideStatsClearedPending = true;");
    expect(clearBody).toContain("this.persistUsageStats();");
    expect(section("private persistUsageStats(")).toContain("this.sideStatsClearedPending");
  });
});
