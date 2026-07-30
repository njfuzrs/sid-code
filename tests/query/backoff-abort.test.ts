/**
 * 重试退避可被 abort 打断 — 单元测试
 *
 * 根因（轨迹 20260730-142920-d98e7f16）：超时重试的退避此前是裸
 * `await new Promise(r => setTimeout(r, backoffMs))`——睡满才醒，期间会话被 abort
 * 也感知不到。实测时间线：
 *   07:37:49.077  Session 超过 60 分钟上限，触发 abort("session-timeout")
 *   07:37:53.491  仍发出 BeforeModel idx=47（退避睡醒后照发新请求）
 * UI 于是先弹「会话已运行超过 60 分钟，已自动结束本轮」，紧接着又弹
 * 「⟳ 正在重试（第 1 次）…」——两个状态机各说各话，正是用户报的现象。
 *
 * 退避基数默认 5s、上限 120s（network-profile DEFAULTS），封顶时最坏要拖 2 分钟
 * 才能响应中断，所以这不是"多等一下"而是"中断在两分钟内无效"。
 *
 * 本测试覆盖 sleepUnlessAborted 的契约（loop.ts 退避点依赖它）：
 *   1. 未 abort → 正常睡满；
 *   2. 睡眠中 abort → 立即返回（不 reject——调用方靠复检 signal 决定收尾）；
 *   3. 传入时已 abort → 同步返回，不白等一轮；
 *   4. 无 signal → 退化为普通 sleep；
 *   5. 正常睡满后不留 abort listener（防泄漏）。
 *
 * fix_type: regression
 */

import { describe, test, expect } from "bun:test";
import { sleepUnlessAborted } from "../../src/query/loop.ts";

describe("sleepUnlessAborted（退避可被中断）", () => {
  test("未 abort：正常睡满", async () => {
    const t0 = Date.now();
    await sleepUnlessAborted(120, new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  test("睡眠中 abort：立即返回，远早于睡满（本次事故的直接修复点）", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort("session-timeout"), 50);
    // 若退避不可中断，这里会等满 5000ms
    await sleepUnlessAborted(5000, ac.signal);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    // 语义：resolve 而非 reject；由调用方复检 signal 决定收尾
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("session-timeout");
  });

  test("传入时已 abort：同步返回，不白等一轮", async () => {
    const ac = new AbortController();
    ac.abort("user-cancel");
    const t0 = Date.now();
    await sleepUnlessAborted(5000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test("无 signal：退化为普通 sleep", async () => {
    const t0 = Date.now();
    await sleepUnlessAborted(80, undefined);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
  });

  test("正常睡满后不残留 abort listener（防泄漏）", async () => {
    const ac = new AbortController();
    let added = 0;
    let removed = 0;
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof origAdd>) => {
      added++;
      return origAdd(...a);
    }) as typeof origAdd;
    ac.signal.removeEventListener = ((...a: Parameters<typeof origRemove>) => {
      removed++;
      return origRemove(...a);
    }) as typeof origRemove;

    await sleepUnlessAborted(60, ac.signal);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  test("abort 唤醒后重复 abort 不会二次 resolve（幂等）", async () => {
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort("session-timeout");
      ac.abort("session-timeout");
    }, 30);
    await sleepUnlessAborted(3000, ac.signal);
    // 能正常返回即证明没有因重复触发抛错
    expect(ac.signal.aborted).toBe(true);
  });
});
