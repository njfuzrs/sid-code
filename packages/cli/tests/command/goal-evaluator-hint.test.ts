/**
 * B16：/goal 评估者独立性提示
 *
 * 未配 goal.evaluatorModel / subAgentModels.default 时评估者就是主模型（自评），
 * 设定目标时必须提示；配了则不提示，/goal status 显示实际评估者。
 * 同时锁住 resolveGoalEvaluatorModel 的取值顺序（loop.ts Goal Gate 与命令共用）。
 */

import { describe, test, expect } from "bun:test";
import goalMod, { EVALUATOR_IS_MAIN_HINT } from "@sid-code/cli/command/commands/goal/goal.ts";
import { resolveGoalEvaluatorModel } from "@sid-code/core/goal/config.ts";
import type { GoalState } from "@sid-code/core/goal/state.ts";

function makeCtx(config: Record<string, unknown>) {
  let goal: GoalState | null = null;
  const notices: string[] = [];
  const ctx: any = {
    config: { model: "main-model", ...config },
    getGoalState: () => goal,
    setGoalState: (g: GoalState | null) => {
      goal = g;
    },
    updateGoalState: (u: (g: GoalState) => void) => goal && u(goal),
    notify: (t: string) => notices.push(t),
  };
  return { ctx, notices };
}

describe("resolveGoalEvaluatorModel", () => {
  test("两项都没配 → 主模型，source=main", () => {
    expect(resolveGoalEvaluatorModel({ model: "m" })).toEqual({ model: "m", source: "main" });
  });
  test("goal.evaluatorModel 优先于 subAgentModels.default", () => {
    expect(
      resolveGoalEvaluatorModel({
        model: "m",
        goal: { evaluatorModel: "e" },
        subAgentModels: { default: "d" },
      }),
    ).toEqual({ model: "e", source: "goal.evaluatorModel" });
  });
  test("只配 subAgentModels.default → 用它", () => {
    expect(resolveGoalEvaluatorModel({ model: "m", subAgentModels: { default: "d" } })).toEqual({
      model: "d",
      source: "subAgentModels.default",
    });
  });
  test("刻意不读 subAgentModels.verify", () => {
    const r = resolveGoalEvaluatorModel({
      model: "m",
      subAgentModels: { verify: "v" } as { default?: string },
    });
    expect(r).toEqual({ model: "m", source: "main" });
  });
});

describe("/goal 设定目标时的评估者提示", () => {
  test("未配置 → 提示评估者 = 主模型", async () => {
    const { ctx, notices } = makeCtx({});
    const r = await goalMod.call("测试全部通过", ctx);
    expect(r.type).toBe("submit_prompt");
    expect(notices).toEqual([EVALUATOR_IS_MAIN_HINT]);
  });

  test("配了 goal.evaluatorModel → 不提示，status 显示配置值", async () => {
    const { ctx, notices } = makeCtx({ goal: { evaluatorModel: "light-model" } });
    await goalMod.call("测试全部通过", ctx);
    expect(notices).toEqual([]);
    const s = await goalMod.call("status", ctx);
    expect(s.type).toBe("text");
    expect((s as { value: string }).value).toContain("评估者: light-model（goal.evaluatorModel）");
  });

  test("配了 subAgentModels.default → 不提示，status 标来源", async () => {
    const { ctx, notices } = makeCtx({ subAgentModels: { default: "sub-model" } });
    await goalMod.call("测试全部通过", ctx);
    expect(notices).toEqual([]);
    const s = (await goalMod.call("status", ctx)) as { value: string };
    expect(s.value).toContain("评估者: sub-model（subAgentModels.default）");
  });

  test("未配置时 status 如实写「自评」", async () => {
    const { ctx } = makeCtx({});
    await goalMod.call("测试全部通过", ctx);
    const s = (await goalMod.call("status", ctx)) as { value: string };
    expect(s.value).toContain("评估者: main-model（未配置，回退主模型 = 自评）");
  });
});
