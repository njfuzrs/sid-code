/**
 * T3：Side-call 硬超时包裹 — 单元测试
 *
 * 验证 withSideCallDeadline / mergeTimeoutSignal 的核心保证：
 *   1. 底层操作永久 hang 时，Promise.race 硬超时后 reject（不依赖 signal 传播）；
 *   2. 超时时合并 signal 被 abort，reason 为 "side-call-timeout"（尽力释放连接）；
 *   3. 外部 signal abort 时合并 signal 同步 abort（用户中断穿透）；
 *   4. 正常完成时不误伤，dispose 清理定时器。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  withSideCallDeadline,
  mergeTimeoutSignal,
  SideCallTimeoutError,
} from "../../src/llm/side-call-timeout.ts";
import { isAbortError, ABORT_REASONS } from "../../src/llm/errors.ts";

describe("T3 — withSideCallDeadline 硬超时", () => {
  test("底层操作永久 hang → 硬超时 reject SideCallTimeoutError", async () => {
    const hangForever = () => new Promise<never>(() => { /* 永不 settle */ });

    let thrown: Error | null = null;
    const start = Date.now();
    try {
      await withSideCallDeadline("test-hang", 80, hangForever);
    } catch (e) {
      thrown = e as Error;
    }
    const elapsed = Date.now() - start;

    expect(thrown).toBeInstanceOf(SideCallTimeoutError);
    expect(/超时|timeout/i.test(thrown!.message)).toBe(true);
    // 在阈值附近 reject（不会等到永久 hang）
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(60);
  }, 10_000);

  test("超时时把合并 signal abort，reason=side-call-timeout（尽力释放连接）", async () => {
    let observedAbortReason: unknown = undefined;

    const captureSignal = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbortReason = (signal as any).reason;
        reject(new Error("aborted by timeout"));
      }, { once: true });
    });

    let thrown: Error | null = null;
    try {
      await withSideCallDeadline("test-abort", 60, captureSignal);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).not.toBeNull();
    // 合并 signal 被超时 abort，reason 是已登记的 side-call-timeout
    expect(observedAbortReason).toBe("side-call-timeout");
    // 该 reason 已登记 ABORT_REASONS，孤儿 rejection 不会被当真故障
    expect(ABORT_REASONS).toContain("side-call-timeout");
    expect(isAbortError("side-call-timeout")).toBe(true);
  }, 10_000);

  test("正常完成时不误伤，返回结果", async () => {
    const result = await withSideCallDeadline("test-ok", 1000, async (signal) => {
      await new Promise((r) => setTimeout(r, 20));
      expect(signal.aborted).toBe(false);
      return { value: 42 };
    });
    expect(result.value).toBe(42);
  }, 10_000);

  test("外部 signal abort 时立即穿透到操作（用户中断）", async () => {
    const external = new AbortController();
    // 10ms 后用户中断
    setTimeout(() => external.abort("user-cancel"), 10);

    let observedAborted = false;
    let thrown: Error | null = null;
    try {
      await withSideCallDeadline(
        "test-external",
        5000, // 硬超时很长，证明是外部 signal 先触发
        (signal) => new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAborted = true;
            reject(new Error("Request aborted"));
          }, { once: true });
        }),
        external.signal,
      );
    } catch (e) {
      thrown = e as Error;
    }

    expect(observedAborted).toBe(true);
    expect(thrown).not.toBeNull();
  }, 10_000);
});

describe("T3 — mergeTimeoutSignal", () => {
  test("外部 signal 已 abort → 合并 signal 立即 abort", () => {
    const external = new AbortController();
    external.abort("user-cancel");
    const { signal, dispose } = mergeTimeoutSignal(external.signal, 10_000);
    expect(signal.aborted).toBe(true);
    dispose();
  });

  test("超时到点 → 合并 signal abort + timedOut() 为 true", async () => {
    const { signal, dispose, timedOut } = mergeTimeoutSignal(undefined, 40);
    expect(signal.aborted).toBe(false);
    expect(timedOut()).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(signal.aborted).toBe(true);
    expect(timedOut()).toBe(true);
    expect((signal as any).reason).toBe("side-call-timeout");
    dispose();
  }, 10_000);

  test("dispose 后定时器被清理（不再 abort）", async () => {
    const { signal, dispose, timedOut } = mergeTimeoutSignal(undefined, 40);
    dispose();
    await new Promise((r) => setTimeout(r, 80));
    // dispose 已清定时器 → 不会超时 abort
    expect(signal.aborted).toBe(false);
    expect(timedOut()).toBe(false);
  }, 10_000);
});
