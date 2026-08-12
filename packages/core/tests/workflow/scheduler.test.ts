/**
 * Dynamic Workflows M1 — 调度器单测
 *
 * 固化并发不变量:
 *  - cap 解析(min(16, cores-2),环境变量可覆盖)
 *  - 槽位满 → 排队,release 按 FIFO 唤醒
 *  - 并发峰值不超过 cap
 *  - thunk 抛错也释放槽位(不泄漏配额)
 */

import { test, expect, describe } from "bun:test";
import { Scheduler, resolveWorkflowConcurrency } from "@sid-code/core/workflow/scheduler.ts";

/** 受控延迟 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("M1 scheduler — 并发上限解析", () => {
  test("环境变量覆盖优先", () => {
    expect(resolveWorkflowConcurrency("4")).toBe(4);
    expect(resolveWorkflowConcurrency("1")).toBe(1);
    expect(resolveWorkflowConcurrency("100")).toBe(100);
  });

  test("非法环境变量 → 回退按核数算", () => {
    const auto = resolveWorkflowConcurrency("");
    expect(auto).toBeGreaterThanOrEqual(1);
    expect(auto).toBeLessThanOrEqual(16);
    const auto2 = resolveWorkflowConcurrency("abc");
    expect(auto2).toBeGreaterThanOrEqual(1);
  });

  test("自动解析在 [1,16] 区间", () => {
    const c = resolveWorkflowConcurrency(undefined);
    expect(c).toBeGreaterThanOrEqual(1);
    expect(c).toBeLessThanOrEqual(16);
  });
});

describe("M1 scheduler — 并发约束", () => {
  test("并发峰值不超过 cap", async () => {
    const cap = 3;
    const sched = new Scheduler(cap);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, () =>
      sched.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(20);
        active--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(cap);
    expect(peak).toBe(cap); // 12 个任务足以打满 3 槽位
  });

  test("超额任务进队列(queued 反映等待数)", async () => {
    const sched = new Scheduler(2);
    let unblock = false;
    // 投递 5 个任务,每个自旋等待 unblock 标志
    const tasks = Array.from({ length: 5 }, () =>
      sched.run(async () => {
        while (!unblock) await delay(5);
      }),
    );
    await delay(20);
    expect(sched.running).toBe(2); // 2 个在跑
    expect(sched.queued).toBe(3); // 3 个排队
    // 放行
    unblock = true;
    await Promise.all(tasks);
    expect(sched.running).toBe(0);
    expect(sched.queued).toBe(0);
  });

  test("FIFO 唤醒顺序", async () => {
    const sched = new Scheduler(1);
    const order: number[] = [];
    const gate: Array<() => void> = [];
    const tasks = [0, 1, 2, 3].map((i) =>
      sched.run(async () => {
        order.push(i);
        await new Promise<void>((resolve) => gate.push(resolve));
      }),
    );
    // 逐个放行,确认按投递顺序执行
    for (let i = 0; i < 4; i++) {
      await delay(5);
      gate[i]?.();
    }
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("thunk 抛错也释放槽位(配额不泄漏)", async () => {
    const sched = new Scheduler(1);
    await expect(
      sched.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sched.running).toBe(0);
    // 槽位已释放,后续任务能跑
    const r = await sched.run(async () => 42);
    expect(r).toBe(42);
  });

  test("cap 至少为 1(传 0 被纠正)", () => {
    const sched = new Scheduler(0);
    expect(sched.capacity).toBe(1);
  });
});
