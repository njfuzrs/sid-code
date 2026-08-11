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
});
