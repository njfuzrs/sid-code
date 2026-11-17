/**
 * A1（2026-11-17）：`/goal resume` 在轮次 / 预算终态上不得「假成功」。
 *
 * 缺陷形态（轨迹 20261117 二次核对）：goal 因轮次耗尽变成 `turns_limited` 后，
 * `/goal resume` 只把 status 改回 `active`，`turnsUsed` / `maxTurns` 一个都没动。
 * 主循环下一轮 end_turn 立刻再撞同一个上限，用户看到「已恢复」但目标当场又终止
 * —— 一次静默的空操作。
 *
 * 判据是「约束是否仍然成立」而不是只看 status：
 * - 上限没放宽 → 拒绝，并给出可执行指令（`/goal turns` / `/goal budget` / `/goal clear`）；
 * - 用户先放宽了上限（`turnsUsed < maxTurns`）→ 放行，resume 才真正有意义。
 *
 * 注意这里断言的是**命令层契约**，不是实现细节：拒绝时必须零副作用（status 不变），
 * 这是「假成功」与「明确拒绝」的唯一边界。
 */

import { describe, test, expect } from "bun:test";
import goalMod from "@sid-code/cli/command/commands/goal/goal.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import type { GoalState } from "@sid-code/core/goal/state.ts";

function makeCtx(goal: GoalState | null) {
  let current = goal;
  const ctx: any = {
    config: { model: "main-model" },
    getGoalState: () => current,
    setGoalState: (g: GoalState | null) => {
      current = g;
    },
    updateGoalState: (u: (g: GoalState) => void) => current && u(current),
    notify: () => {},
  };
  return { ctx, goal: () => current };
}

describe("A1 — /goal resume 的终态守卫", () => {
  test("轮次耗尽 → 拒绝并给出指令，status 不变", async () => {
    const goal = createGoal("完成迁移工作", { maxTurns: 3 });
    goal.turnsUsed = 3;
    goal.status = "turns_limited";
    const { ctx, goal: read } = makeCtx(goal);

    const r = (await goalMod.call("resume", ctx)) as { type: string; value: string };

    expect(r.type).toBe("text");
    expect(r.value).toContain("轮次耗尽");
    expect(r.value).toContain("/goal turns");
    // 零副作用：拒绝就必须彻底不动，否则下一轮又是同一个上限。
    expect(read()!.status).toBe("turns_limited");
  });

  test("轮次耗尽但用户已放宽上限 → 放行（约束不再成立）", async () => {
    const goal = createGoal("完成迁移工作", { maxTurns: 3 });
    goal.turnsUsed = 3;
    goal.status = "turns_limited";
    // 先走一遍真实的 /goal turns，验证「放宽 → resume」这条操作流能走通。
    const { ctx, goal: read } = makeCtx(goal);
    await goalMod.call("turns 10", ctx);

    const r = await goalMod.call("resume", ctx);

    expect(r.type).toBe("submit_prompt");
    expect(read()!.status).toBe("active");
  });

  test("预算耗尽 → 拒绝并给出指令，status 不变", async () => {
    const goal = createGoal("完成迁移工作", { tokenBudget: 1000 });
    goal.tokensUsed = 1000;
    goal.status = "budget_limited";
    const { ctx, goal: read } = makeCtx(goal);

    const r = (await goalMod.call("resume", ctx)) as { type: string; value: string };

    expect(r.type).toBe("text");
    expect(r.value).toContain("Token 预算耗尽");
    expect(r.value).toContain("/goal budget");
    expect(read()!.status).toBe("budget_limited");
  });

  test("预算耗尽但用户已放宽预算 → 放行", async () => {
    const goal = createGoal("完成迁移工作", { tokenBudget: 1000 });
    goal.tokensUsed = 1000;
    goal.status = "budget_limited";
    const { ctx, goal: read } = makeCtx(goal);
    await goalMod.call("budget 5000", ctx);

    const r = await goalMod.call("resume", ctx);

    expect(r.type).toBe("submit_prompt");
    expect(read()!.status).toBe("active");
  });

  test("paused → 照常恢复（守卫不扩大打击面）", async () => {
    const goal = createGoal("完成迁移工作");
    goal.status = "paused";
    const { ctx, goal: read } = makeCtx(goal);

    const r = await goalMod.call("resume", ctx);

    expect(r.type).toBe("submit_prompt");
    expect(read()!.status).toBe("active");
  });
});
