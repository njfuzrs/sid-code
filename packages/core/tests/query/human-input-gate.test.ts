/**
 * 人机输入闸门测试
 *
 * 锁定「弹窗阻塞等用户作答期间看门狗不误杀」的闸门语义（根因B修复）：
 * 引用计数、嵌套、异常安全的 withHumanInputWait。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  activeHitlScopeCount,
  beginHumanInputWait,
  closeHitlScope,
  endHumanInputWait,
  humanInputWaitElapsedMs,
  isAwaitingHumanInput,
  openHitlScope,
  readHitlSegmentCount,
  resolveHitlScope,
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

  test("区段计数与耗时同源：嵌套只算一段，不会因嵌套翻倍", async () => {
    const before = readHitlSegmentCount();
    await withHumanInputWait(async () => {
      await withHumanInputWait(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    });
    // 强断言：嵌套两层也只 +1。此前是 `toBeGreaterThan(0)`，实现退化成「每层 +1」也能绿。
    expect(readHitlSegmentCount()).toBe(before + 1);
  });

  test("__resetHumanInputGate 连区段数一起清零（否则用例互相污染）", () => {
    beginHumanInputWait();
    endHumanInputWait();
    expect(readHitlSegmentCount()).toBeGreaterThan(0);
    __resetHumanInputGate();
    expect(readHitlSegmentCount()).toBe(0);
  });

  // ─── F4-2：作用域归属 ───
  //
  // 锁住「别的 agent 等人的时间不会被扣进我的模型耗时」。归属规则是**宁可漏计，
  // 不可多计** —— 多计的后果是凭空造出「模型耗时 0ms」的假样本，方向与「更快」相反。

  test("没有活跃 scope 时不猜归属：等待只进进程级累计", async () => {
    expect(activeHitlScopeCount()).toBe(0);
    expect(resolveHitlScope()).toBeUndefined();
    await withHumanInputWait(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    // 进程级口径照常（既有消费者不受影响），但没有任何 scope 认领它
    expect(readHitlSegmentCount()).toBe(1);
    expect(humanInputWaitElapsedMs()).toBeGreaterThanOrEqual(5);
  });

  test("唯一活跃 scope 时，未显式传 scope 的等待按推断归属它", async () => {
    const only = openHitlScope();
    expect(resolveHitlScope()).toBe(only);
    await withHumanInputWait(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(readHitlSegmentCount(only)).toBe(1);
    expect(humanInputWaitElapsedMs(only)).toBeGreaterThanOrEqual(20);
    closeHitlScope(only);
  });

  test("两个活跃 scope 时推断失败（多 agent 并发不猜）", () => {
    const a = openHitlScope();
    const b = openHitlScope();
    expect(activeHitlScopeCount()).toBe(2);
    expect(resolveHitlScope()).toBeUndefined();
    closeHitlScope(a);
    closeHitlScope(b);
  });

  test("【污染回归】两个 scope 顺序等待，各自的时长互不含对方", async () => {
    const a = openHitlScope();
    const b = openHitlScope();
    await withHumanInputWait(() => new Promise((r) => setTimeout(r, 40)), a);
    const aMs = humanInputWaitElapsedMs(a);
    await withHumanInputWait(() => new Promise((r) => setTimeout(r, 40)), b);
    const bMs = humanInputWaitElapsedMs(b);

    expect(aMs).toBeGreaterThanOrEqual(30);
    expect(bMs).toBeGreaterThanOrEqual(30);
    // 关键断言：若 b 读到的是进程级累计（实现退化），bMs ≈ aMs + 40 会明显超出这个上界。
    expect(bMs).toBeLessThan(aMs + 20);
    closeHitlScope(a);
    closeHitlScope(b);
  });

  test("【污染回归】重叠等待时，后加入的 scope 一秒都不认领（降级为漏计）", async () => {
    const a = openHitlScope();
    const b = openHitlScope();
    await withHumanInputWait(async () => {
      // a 已等了一会儿之后，b 才进入等待 —— 后台子代理与主循环重叠的形态
      await new Promise((r) => setTimeout(r, 30));
      await withHumanInputWait(() => new Promise((r) => setTimeout(r, 30)), b);
    }, a);

    // b 只是「加入」，不是发起者：它不该认领任何时长（多计就是从这条路径来的）
    expect(humanInputWaitElapsedMs(b)).toBe(0);
    expect(readHitlSegmentCount(b)).toBe(0);
    // a 只结算冲突之前的那 30ms 左右，不会把 b 的那段也算进来
    expect(humanInputWaitElapsedMs(a)).toBeLessThan(55);
    // 进程级累计仍覆盖整段并集（~60ms）—— 既有消费者语义不变
    expect(humanInputWaitElapsedMs()).toBeGreaterThanOrEqual(40);
    closeHitlScope(a);
    closeHitlScope(b);
  });

  test("closeHitlScope 丢掉该 scope 的累计（loop 退出后不残留）", async () => {
    const scope = openHitlScope();
    await withHumanInputWait(() => new Promise((r) => setTimeout(r, 20)), scope);
    expect(humanInputWaitElapsedMs(scope)).toBeGreaterThan(0);
    closeHitlScope(scope);
    expect(humanInputWaitElapsedMs(scope)).toBe(0);
    expect(readHitlSegmentCount(scope)).toBe(0);
    expect(activeHitlScopeCount()).toBe(0);
  });
});
