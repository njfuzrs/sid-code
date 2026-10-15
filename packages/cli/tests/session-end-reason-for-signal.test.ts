/**
 * sessionEndReasonForSignal 单测 — 信号退出时 SessionEnd 的 reason 判定
 *
 * 缺陷现场（2026-10-15，本地 205 个会话）：abort 126 个里 125 个是 SIGHUP，
 * 有对话的 82 个里 81 个收到信号时上一轮已 end_turn——关终端窗口被一律记成中断。
 */

import { test, expect, describe } from "bun:test";
import { sessionEndReasonForSignal } from "@sid-code/cli/app.ts";

describe("sessionEndReasonForSignal", () => {
  test("空闲时 SIGHUP（关终端窗口）→ terminal_closed", () => {
    expect(sessionEndReasonForSignal("SIGHUP", false)).toBe("terminal_closed");
  });

  test("反向自证：轮次在跑时 SIGHUP 仍是 abort（真打断）", () => {
    // 缺了这条，一个「SIGHUP 一律 terminal_closed」的实现也能让上面那条通过，
    // 而那会把真正被关窗口打断的轮次藏起来。
    expect(sessionEndReasonForSignal("SIGHUP", true)).toBe("abort");
  });

  test("SIGINT / SIGTERM 无论忙闲都是 abort（用户 Ctrl-C / 外部 kill）", () => {
    for (const busy of [true, false]) {
      expect(sessionEndReasonForSignal("SIGINT", busy)).toBe("abort");
      expect(sessionEndReasonForSignal("SIGTERM", busy)).toBe("abort");
    }
  });
});
