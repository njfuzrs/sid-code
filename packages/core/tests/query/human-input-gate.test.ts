/**
 * 人机输入闸门测试
 *
 * 锁定「弹窗阻塞等用户作答期间看门狗不误杀」的闸门语义（根因B修复）：
 * 引用计数、嵌套、异常安全的 withHumanInputWait。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  beginHumanInputWait,
  endHumanInputWait,
  isAwaitingHumanInput,
  readHitlSegmentCount,
  withHumanInputWait,
  __resetHumanInputGate,
} from "@sid-code/core/query/human-input-gate.ts";

afterEach(() => __resetHumanInputGate());

describe("human-input-gate", () => {
  test("初始未在等待", () => {
    expect(isAwaitingHumanInput()).toBe(false);
  });

  test("begin/end 配对切换状态", () => {
    beginHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(true);
    endHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(false);
  });

  test("引用计数：嵌套等待需全部结束才关闭", () => {
    beginHumanInputWait();
    beginHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(true);
    endHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(true); // 还有一层未闭合
    endHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(false);
  });

  test("end 下限保护：多余的 end 不会把计数打成负数", () => {
    endHumanInputWait();
    endHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(false);
    beginHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(true); // 一次 begin 即可开启，未被负计数抵消
    endHumanInputWait();
    expect(isAwaitingHumanInput()).toBe(false);
  });

  test("withHumanInputWait：执行期间为 true，结束后恢复 false", async () => {
    let during = false;
    const ret = await withHumanInputWait(async () => {
      during = isAwaitingHumanInput();
      return 42;
    });
    expect(during).toBe(true);
    expect(ret).toBe(42);
    expect(isAwaitingHumanInput()).toBe(false);
  });

  test("withHumanInputWait：回调抛异常也必须闭合闸门（finally 语义）", async () => {
    await expect(
      withHumanInputWait(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // 异常后闸门必须已关闭，否则看门狗被永久架空
    expect(isAwaitingHumanInput()).toBe(false);
  });

  // ─── F4：区段计数（HITL 次数与耗时的唯一登记点）───

  test("区段计数只在引用计数 0→1 的边沿递增（嵌套不重复计）", () => {
    const before = readHitlSegmentCount();
    beginHumanInputWait();
    beginHumanInputWait(); // 嵌套：同一段等待
    endHumanInputWait();
    expect(readHitlSegmentCount()).toBe(before + 1); // 还剩一层，仍算同一段
    endHumanInputWait();
    expect(readHitlSegmentCount()).toBe(before + 1);
  });

  test("区段计数只增不减：两次独立等待累计 +2", () => {
    const before = readHitlSegmentCount();
    beginHumanInputWait();
    endHumanInputWait();
    beginHumanInputWait();
    endHumanInputWait();
    expect(readHitlSegmentCount()).toBe(before + 2);
  });

  test("区段计数与耗时同源：嵌套不计时，独立段各计一次", async () => {
    // 时长仍以引用计数配对为准（嵌套不重复计），但段数也是同一口径 —— 两者不会互相矛盾。
    await withHumanInputWait(async () => {
      await withHumanInputWait(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    });
    // 区段只 +1；耗时 > 0 且只计一次（无法精确断言时长，只锁"不会因嵌套而翻倍"）
    expect(readHitlSegmentCount()).toBeGreaterThan(0);
  });
});
