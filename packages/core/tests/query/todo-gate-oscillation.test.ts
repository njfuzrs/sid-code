/**
 * 发现 2b 回归：续命预算 / nag 计数只在 completed **创新高**时复位，振荡不再续命
 *
 * 缺陷现场（会话 20261020-110542-ce7ea52e）：completed 序列 `…1,0,1,0,1,1,0,1,0,0`。
 * 旧判据「completed 或 total 有任何变化就复位」让每次 1→0→1 都把预算回满，
 * cap 从未生效，防线到顶只会沉默，会话跑了 9 小时。
 *
 * fix_type: logic
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { advanceTodoGateBudget, type TodoGateBudget } from "@sid-code/core/query/todo-reminder.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");

/** 构造 total=3、completed=n 的清单 */
function list(n: number, total = 3): TodoItem[] {
  return Array.from({ length: total }, (_, i) => ({
    content: `项${i}`,
    activeForm: `正在做项${i}`,
    status: i < n ? "completed" : "in_progress",
  })) as TodoItem[];
}

/** 逐个喂入 completed 序列，返回复位次数与终态预算 */
function replay(seq: number[]): { resets: number; budget: TodoGateBudget } {
  let budget: TodoGateBudget | undefined;
  let resets = 0;
  for (const n of seq) {
    const r = advanceTodoGateBudget(budget, list(n));
    if (r.progressed) resets++;
    budget = r.budget;
  }
  return { resets, budget: budget! };
}

describe("advanceTodoGateBudget：振荡不续命", () => {
  test("本会话 completed 序列：复位次数 = 创新高次数，下降计入振荡", () => {
    const seq = [1, 0, 1, 0, 1, 1, 0, 1, 0, 0];
    const { resets, budget } = replay(seq);
    // 首次建预算算一次（1），此后再无新高
    expect(resets).toBe(1);
    // 1→0 共 4 次下降
    expect(budget.oscillations).toBe(4);
    expect(budget.peakCompleted).toBe(1);
    expect(budget.completed).toBe(0);
  });

  test("振荡期间消耗的 retries 不会被回升抹掉", () => {
    let { budget } = replay([1]);
    budget = { ...budget, retries: 2 };
    budget = advanceTodoGateBudget(budget, list(0)).budget;
    budget = advanceTodoGateBudget(budget, list(1)).budget;
    expect(budget.retries).toBe(2);
  });

  test("真推进（超过峰值）照常复位，振荡史保留", () => {
    let { budget } = replay([1, 0, 1]);
    budget = { ...budget, retries: 3 };
    const r = advanceTodoGateBudget(budget, list(2));
    expect(r.progressed).toBe(true);
    expect(r.budget.retries).toBe(0);
    expect(r.budget.oscillations).toBe(1);
  });

  test("换清单（total 变化）复位且清零振荡", () => {
    const { budget } = replay([1, 0]);
    const r = advanceTodoGateBudget({ ...budget, retries: 3 }, list(0, 5));
    expect(r.progressed).toBe(true);
    expect(r.budget.retries).toBe(0);
    expect(r.budget.oscillations).toBe(0);
  });

  test("状态不变返回同一对象（不触发 SessionState 写入）", () => {
    const { budget } = replay([1]);
    const r = advanceTodoGateBudget(budget, list(1));
    expect(r.progressed).toBe(false);
    expect(r.budget).toBe(budget);
  });
});

describe("loop.ts 接线：nag 计数与 gate 预算同一判据", () => {
  const loopSrc = readFileSync(join(REPO_ROOT, "packages/core/src/query/loop.ts"), "utf8");

  test("progressNagCount 清零受 progressed 守卫，不再裸挂在 writeVersion 变化上", () => {
    expect(loopSrc).toMatch(
      /if \(advanceSessionTodoGateBudget\(sessionState, todoState\.todos\)\.progressed\) \{\s*state\.progressNagCount = 0;/,
    );
  });

  test("TodoReworkDetected 并入振荡计数", () => {
    const idx = loopSrc.indexOf('event: "TodoReworkDetected"');
    const before = loopSrc.slice(Math.max(0, idx - 1200), idx);
    expect(before).toContain("oscillations: gateBudget.oscillations + 1");
  });
});
