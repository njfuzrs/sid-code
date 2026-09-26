/**
 * P2-2：workflow 的 token 预算是共享池，不是每 run 独立预算。
 *
 * 修之前 `spentReader` 只读本 run 的 outputTokens，`types.ts` 的注释却写
 * 「主循环 + 所有 workflow 的输出 token 之和」。注释描述的才是设计意图：
 * 用户设 `+500k` 时，主循环已经花掉的必须计入，否则 workflow 在池子超支后继续烧。
 *
 * 这里用真实的 SessionState 当池子（与 app.ts 注入的读口同一口径），
 * 验证三件事：
 * - 注入读口后，主循环已花的 token 让 workflow 预算相应收紧；
 * - 子代理用量回写进 SessionState 后，下一次 agent() 看到的是累加后的池子；
 * - 不注入读口时仍只计本 run（headless/测试的既有行为不回归）。
 */

import { describe, test, expect } from "bun:test";
import { WorkflowRuntime, BudgetExceededError } from "@sid-code/core/workflow/runtime.ts";
import type { AgentRunner, AgentCallContext, AgentOpts } from "@sid-code/core/workflow/types.ts";
import { SessionState } from "@sid-code/core/session/state.ts";

const runner: AgentRunner = {
  async run(_prompt: string, _opts: AgentOpts | undefined, _ctx: AgentCallContext) {
    return { ok: true };
  },
};

describe("workflow budget 共享池", () => {
  test("主循环已花的 token 计入预算：400k 已花 + 500k 上限 → 还能跑，再花 100k 后拒绝", async () => {
    const session = new SessionState("budget-pool-test");
    // 主循环花了 400_000 输出 token
    session.updateUsage("m", { inputTokens: 1000, outputTokens: 400_000 }, 0, "openai");

    const rt = new WorkflowRuntime({
      runner,
      budgetTotal: 500_000,
      spentReader: () => session.getTotalUsage().outputTokens,
    });
    const api = rt.buildApi();

    // 池子还剩 100k，第一次调用放行
    expect(api.budget.remaining()).toBe(100_000);
    await expect(api.agent("第一步")).resolves.toEqual({ ok: true });

    // 模拟该子代理回写 100_000 输出 token（app.ts 的 usage sink 就是这么做的）
    session.updateUsage("m", { inputTokens: 1000, outputTokens: 100_000 }, 0, "openai");

    // 池子到顶，下一次 agent() 被预算硬门拒绝
    expect(api.budget.remaining()).toBe(0);
    await expect(api.agent("第二步")).rejects.toThrow(BudgetExceededError);
  });

  test("进入 run 时池子已超支 → 第一次 agent() 就拒绝", async () => {
    const session = new SessionState("budget-pool-over");
    session.updateUsage("m", { inputTokens: 0, outputTokens: 600_000 }, 0, "openai");
    const rt = new WorkflowRuntime({
      runner,
      budgetTotal: 500_000,
      spentReader: () => session.getTotalUsage().outputTokens,
    });
    await expect(rt.buildApi().agent("任意")).rejects.toThrow(BudgetExceededError);
  });

  test("未注入读口时只计本 run（既有兜底不回归）", async () => {
    const rt = new WorkflowRuntime({ runner, budgetTotal: 100 });
    const api = rt.buildApi();
    expect(api.budget.spent()).toBe(0);
    rt.addLocalSpent(40);
    expect(api.budget.remaining()).toBe(60);
  });
});
