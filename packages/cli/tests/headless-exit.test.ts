/**
 * P0 #3（2026-10-27）：无头收尾退出码判定。
 *
 * 缺陷形态：超时重试耗尽 / 退避期被 SIGTERM 中断时 `-p` 退 0、JSON 无 error。
 * 端到端复现见 tests/cli/print-incomplete-exit-code.test.ts，这里锁优先级。
 */

import { describe, test, expect } from "bun:test";
import { headlessIncomplete, resolveHeadlessExitCode } from "../src/headless-exit.ts";

const base = { signalExitCode: null, hasRunError: false, budgetExceeded: false };

describe("resolveHeadlessExitCode", () => {
  test("正常说完 → 0", () => {
    expect(resolveHeadlessExitCode(base)).toBe(0);
  });

  test("incompleteReason 非空 → 1（修前这里是 0）", () => {
    for (const r of [
      "timeout_retry_exhausted",
      "aborted",
      "stalled",
      "context_window_exhausted",
    ] as const) {
      expect(resolveHeadlessExitCode({ ...base, incompleteReason: r })).toBe(1);
    }
  });

  test("收到信号 → 信号退出码优先于一切（不靠竞速）", () => {
    expect(resolveHeadlessExitCode({ ...base, signalExitCode: 143 })).toBe(143);
    expect(
      resolveHeadlessExitCode({
        ...base,
        signalExitCode: 130,
        incompleteReason: "aborted",
        hasRunError: true,
      }),
    ).toBe(130);
  });

  test("会话硬顶引发的 aborted 维持既有约定：不算失败", () => {
    expect(
      resolveHeadlessExitCode({ ...base, incompleteReason: "aborted", sessionTimedOut: true }),
    ).toBe(0);
    expect(headlessIncomplete({ incompleteReason: "aborted", sessionTimedOut: true })).toBe(false);
    // 硬顶只豁免它自己的回声，重试耗尽照样是失败
    expect(
      resolveHeadlessExitCode({
        ...base,
        incompleteReason: "timeout_retry_exhausted",
        sessionTimedOut: true,
      }),
    ).toBe(1);
  });

  test("既有两类失败不变", () => {
    expect(resolveHeadlessExitCode({ ...base, hasRunError: true })).toBe(1);
    expect(resolveHeadlessExitCode({ ...base, budgetExceeded: true })).toBe(1);
  });
});
