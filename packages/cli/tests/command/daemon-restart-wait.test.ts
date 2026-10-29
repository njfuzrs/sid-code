/**
 * D4：restart 曾固定等 1s，不等旧进程真正退出——旧进程慢一点新进程就抢锁失败，一个 daemon 都没有。
 */

import { describe, it, expect } from "bun:test";
import { waitForDaemonExit } from "../../src/command/daemon.ts";

describe("restart 等旧进程退出", () => {
  it("轮询到旧进程退出才返回 true（超过 1s 也等）", async () => {
    const until = Date.now() + 1200;
    const t0 = Date.now();
    expect(await waitForDaemonExit(() => Date.now() < until, 5000, 20)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1150);
  });
  it("超时返回 false", async () => {
    expect(await waitForDaemonExit(() => true, 100, 20)).toBe(false);
  });
});
