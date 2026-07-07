/**
 * Goal Gate 单测
 *
 * 验证 end_turn 拦截链最末环节 handleGoalGate 的决策逻辑：
 * - 预算耗尽 → shouldContinue=false + 注入收尾消息
 * - 预算预警(85%) → 注入预警但继续
 * - 轮次超限 → shouldContinue=false
 * - 前 N 轮跳过评估 → shouldContinue=true 不调 LLM
 * - 评估满足 → completed=true
 * - 评估 impossible → impossible=true
 * - 评估未满足 → 注入反馈 + shouldContinue=true
 * - 连续相同 blockerKey → blocked（shouldContinue=false）
 *
 * 评估者 LLM 通过 mock Provider 隔离。
 */

import { describe, test, expect } from "bun:test";
import { handleGoalGate, type GoalGateContext } from "../../src/query/goal-gate.ts";
import { createGoal } from "../../src/goal/state.ts";
import { BlockedDetector } from "../../src/goal/blocked-detector.ts";
import { DEFAULT_GOAL_CONFIG } from "../../src/goal/config.ts";
import type { EvalConfig } from "../../src/goal/evaluator.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { StreamEvent, Message } from "../../src/llm/types.ts";

// ─── Mock ───

function mockProvider(responseText: string): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: responseText } } as StreamEvent;
    },
  };
}

/** P0-1：模拟必失败的评估者 provider（抛错），用于验证评估器熔断路径 */
function failingProvider(): Provider {
  return {
    name: () => "mock-fail",
    // eslint-disable-next-line require-yield
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      throw new Error("Request aborted");
    },
  };
}

function evalConfig(provider: Provider): EvalConfig {
  return { model: "haiku-test", provider, timeout: 1000, minTurnsBeforeEval: 2 };
}

/** 构造一个最小 GoalGateContext，evalResponse 是 mock 评估者返回的文本 */
function makeCtx(opts: {
  goalOverrides?: Partial<ReturnType<typeof createGoal>>;
  evalResponse?: string;
  turnUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number };
  blockedDetector?: BlockedDetector;
  messages?: Message[];
}): GoalGateContext {
  const goal = createGoal("让 bun test 通过", { tokenBudget: opts.goalOverrides?.tokenBudget, maxTurns: opts.goalOverrides?.maxTurns });
  Object.assign(goal, opts.goalOverrides);
  return {
    goal,
    messages: opts.messages ?? [],
    turnUsage: opts.turnUsage ?? { inputTokens: 100, outputTokens: 50 },
    evalConfig: evalConfig(mockProvider(opts.evalResponse ?? JSON.stringify({ satisfied: false, reason: "继续" }))),
    goalConfig: DEFAULT_GOAL_CONFIG,
    blockedDetector: opts.blockedDetector ?? new BlockedDetector(DEFAULT_GOAL_CONFIG.blockedThreshold),
  };
}

// ─── 预算 ───

describe("handleGoalGate · 预算", () => {
  test("预算耗尽 → shouldContinue=false + 注入收尾 + status=budget_limited", async () => {
    const ctx = makeCtx({
      goalOverrides: { tokenBudget: 1000, tokensUsed: 0, turnsUsed: 5 },
      turnUsage: { inputTokens: 800, outputTokens: 300 }, // 1100 > 1000
    });
    const out = await handleGoalGate(ctx);
    expect(out.result.shouldContinue).toBe(false);
    expect(out.result.completed).toBe(false);
    expect(ctx.goal.status).toBe("budget_limited");
    expect(out.injectMessages.length).toBeGreaterThan(0);
    expect(out.injectMessages[0]!.content[0]!.text).toContain("预算已耗尽");
  });

  test("预算预警(85%) → 注入预警但继续评估", async () => {
    const ctx = makeCtx({
      goalOverrides: { tokenBudget: 1000, tokensUsed: 0, turnsUsed: 5 },
      turnUsage: { inputTokens: 700, outputTokens: 200 }, // 900 = 90%
      evalResponse: JSON.stringify({ satisfied: false, reason: "还在做", progress: 50 }),
    });
    const out = await handleGoalGate(ctx);
    // 90% 触发 warning，但未超限 → 继续走到评估，评估未满足 → shouldContinue=true
    expect(out.result.shouldContinue).toBe(true);
    const warnMsg = out.systemMessages.find((m) => m.text.includes("预警"));
    expect(warnMsg).toBeDefined();
  });
});

// ─── 轮次 ───

describe("handleGoalGate · 轮次", () => {
  test("轮次超限 → shouldContinue=false + status=turns_limited", async () => {
    const ctx = makeCtx({ goalOverrides: { turnsUsed: 50, maxTurns: 50 } });
    const out = await handleGoalGate(ctx);
    expect(out.result.shouldContinue).toBe(false);
    expect(ctx.goal.status).toBe("turns_limited");
  });
});

// ─── 跳过评估 ───

describe("handleGoalGate · 前 N 轮跳过", () => {
  test("turnsUsed < minTurnsBeforeEval → shouldContinue=true 不评估", async () => {
    const ctx = makeCtx({
      goalOverrides: { turnsUsed: 1 }, // < 2
      // 即使 mock 评估者返回 satisfied=true，也不该被调用
      evalResponse: JSON.stringify({ satisfied: true, reason: "不该被调用" }),
    });
    const out = await handleGoalGate(ctx);
    expect(out.result.shouldContinue).toBe(true);
    expect(out.result.completed).toBe(false);
  });
});

// ─── 评估结果 ───

describe("handleGoalGate · 评估决策", () => {
  test("评估满足 → completed=true + status=complete", async () => {
    const ctx = makeCtx({
      goalOverrides: { turnsUsed: 5 },
      // 用非测试类目标避免快速路径，强制走 LLM
      evalResponse: JSON.stringify({ satisfied: true, reason: "全部完成" }),
    });
    ctx.goal.objective = "完成迁移工作";
    const out = await handleGoalGate(ctx);
    expect(out.result.completed).toBe(true);
    expect(out.result.shouldContinue).toBe(false);
    expect(ctx.goal.status).toBe("complete");
  });

  test("评估 impossible（默认降级模式）→ 不终止，注入软提醒 + shouldContinue=true", async () => {
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    delete process.env.SID_ENABLE_GOAL_HARD_STOP;
    try {
      const ctx = makeCtx({
        goalOverrides: { turnsUsed: 3 },
        evalResponse: JSON.stringify({ satisfied: false, reason: "文件不存在", impossible: true }),
      });
      ctx.goal.objective = "修复 nonexistent.ts";
      const out = await handleGoalGate(ctx);
      // 降级：不再终止，也不再标 impossible，而是继续并把判断交还模型
      expect(out.result.impossible).toBe(false);
      expect(out.result.shouldContinue).toBe(true);
      expect(ctx.goal.status).not.toBe("impossible");
      expect(out.injectMessages.length).toBeGreaterThan(0);
      expect(out.injectMessages[0]!.content[0]!.text).toContain("无法达成");
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });

  test("评估 impossible（SID_ENABLE_GOAL_HARD_STOP=1 硬停止模式）→ impossible=true + status=impossible", async () => {
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    process.env.SID_ENABLE_GOAL_HARD_STOP = "1";
    try {
      const ctx = makeCtx({
        goalOverrides: { turnsUsed: 3 },
        evalResponse: JSON.stringify({ satisfied: false, reason: "文件不存在", impossible: true }),
      });
      ctx.goal.objective = "修复 nonexistent.ts";
      const out = await handleGoalGate(ctx);
      expect(out.result.impossible).toBe(true);
      expect(out.result.shouldContinue).toBe(false);
      expect(ctx.goal.status).toBe("impossible");
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });

  test("评估未满足 → 注入反馈 + shouldContinue=true + 记录 lastEvalReason", async () => {
    const ctx = makeCtx({
      goalOverrides: { turnsUsed: 5 },
      evalResponse: JSON.stringify({ satisfied: false, reason: "还差 2 个测试", progress: 70, blockerKey: "test-x" }),
    });
    ctx.goal.objective = "完成迁移工作";
    const out = await handleGoalGate(ctx);
    expect(out.result.shouldContinue).toBe(true);
    expect(out.result.completed).toBe(false);
    expect(ctx.goal.lastEvalReason).toBe("还差 2 个测试");
    expect(out.injectMessages.length).toBeGreaterThan(0);
    expect(out.injectMessages[0]!.content[0]!.text).toContain("还差 2 个测试");
  });
});

// ─── Blocked 检测 ───

describe("handleGoalGate · blocked 检测", () => {
  test("连续相同 blockerKey 达阈值（默认降级模式）→ 不终止，注入换思路提醒 + shouldContinue=true", async () => {
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    delete process.env.SID_ENABLE_GOAL_HARD_STOP;
    try {
      const detector = new BlockedDetector(3);
      const response = JSON.stringify({ satisfied: false, reason: "卡在同一处", blockerKey: "stuck-key" });

      // 前两次：未满足但未达阈值 → 继续
      for (let i = 0; i < 2; i++) {
        const ctx = makeCtx({ goalOverrides: { turnsUsed: 5 + i }, evalResponse: response, blockedDetector: detector });
        ctx.goal.objective = "完成迁移工作";
        const out = await handleGoalGate(ctx);
        expect(out.result.shouldContinue).toBe(true);
      }

      // 第三次：连续 3 次相同 blockerKey → 降级模式下仍继续，但注入"换思路"软提醒、不标 blocked
      const ctx3 = makeCtx({ goalOverrides: { turnsUsed: 7 }, evalResponse: response, blockedDetector: detector });
      ctx3.goal.objective = "完成迁移工作";
      const out3 = await handleGoalGate(ctx3);
      expect(out3.result.shouldContinue).toBe(true);
      expect(ctx3.goal.status).not.toBe("blocked");
      expect(out3.injectMessages.length).toBeGreaterThan(0);
      expect(out3.injectMessages[0]!.content[0]!.text).toContain("换一种思路");
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });

  test("连续相同 blockerKey 达阈值（SID_ENABLE_GOAL_HARD_STOP=1 硬停止模式）→ blocked + shouldContinue=false", async () => {
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    process.env.SID_ENABLE_GOAL_HARD_STOP = "1";
    try {
      const detector = new BlockedDetector(3);
      const response = JSON.stringify({ satisfied: false, reason: "卡在同一处", blockerKey: "stuck-key" });

      for (let i = 0; i < 2; i++) {
        const ctx = makeCtx({ goalOverrides: { turnsUsed: 5 + i }, evalResponse: response, blockedDetector: detector });
        ctx.goal.objective = "完成迁移工作";
        const out = await handleGoalGate(ctx);
        expect(out.result.shouldContinue).toBe(true);
      }

      const ctx3 = makeCtx({ goalOverrides: { turnsUsed: 7 }, evalResponse: response, blockedDetector: detector });
      ctx3.goal.objective = "完成迁移工作";
      const out3 = await handleGoalGate(ctx3);
      expect(out3.result.shouldContinue).toBe(false);
      expect(ctx3.goal.status).toBe("blocked");
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });
});

// ─── P0-1：评估器故障熔断 ───

describe("handleGoalGate · 评估器故障熔断（P0-1）", () => {
  test("评估器连续失败达阈值（硬停止模式）→ blocked 放行 shouldContinue=false", async () => {
    // 文档 P0-1 验证方式：注入必失败的评估者，跑 3 轮 goalGate，断言第 3 轮 blocked 放行。
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    process.env.SID_ENABLE_GOAL_HARD_STOP = "1";
    try {
      const detector = new BlockedDetector(3);
      const runOnce = async (turn: number) => {
        const ctx: GoalGateContext = {
          goal: (() => {
            const g = createGoal("完成一份代码审计报告并汇总告诉我");
            g.objective = "完成一份代码审计报告并汇总告诉我";
            g.turnsUsed = turn;
            return g;
          })(),
          messages: [],
          turnUsage: { inputTokens: 100, outputTokens: 50 },
          // 必失败 provider → catch 分支设 blockerKey=__evaluator_unavailable__
          evalConfig: { model: "haiku-test", provider: failingProvider(), timeout: 1000, minTurnsBeforeEval: 2 },
          goalConfig: DEFAULT_GOAL_CONFIG,
          blockedDetector: detector,
        };
        return handleGoalGate(ctx);
      };

      // 前两轮：评估器失败但未达阈值 → 继续
      const out1 = await runOnce(5);
      expect(out1.result.shouldContinue).toBe(true);
      const out2 = await runOnce(6);
      expect(out2.result.shouldContinue).toBe(true);

      // 第三轮：连续 3 次 __evaluator_unavailable__ → blocked 硬停止放行
      const out3 = await runOnce(7);
      expect(out3.result.shouldContinue).toBe(false);
      expect(out3.result.completed).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });

  test("评估器失败时推 warning 系统消息（TUI 可见）", async () => {
    const ctx: GoalGateContext = {
      goal: (() => {
        const g = createGoal("完成迁移工作");
        g.objective = "完成迁移工作";
        g.turnsUsed = 5;
        return g;
      })(),
      messages: [],
      turnUsage: { inputTokens: 100, outputTokens: 50 },
      evalConfig: { model: "haiku-test", provider: failingProvider(), timeout: 1000, minTurnsBeforeEval: 2 },
      goalConfig: DEFAULT_GOAL_CONFIG,
      blockedDetector: new BlockedDetector(3),
    };
    const out = await handleGoalGate(ctx);
    const warnMsg = out.systemMessages.find((m) => m.level === "warning" && m.text.includes("评估器连续失败"));
    expect(warnMsg).toBeDefined();
  });
});

// ─── P1-1：报告型任务 fast-path ───

describe("evaluateGoal · 报告型任务 fast-path（P1-1）", () => {
  test("目标含'汇总/报告' + end_turn + 实质文本 → 快速满足（不调 LLM）", async () => {
    const { evaluateGoal } = await import("../../src/goal/evaluator.ts");
    const goal = createGoal("检查文档一致性并汇总告诉我审计结果");
    goal.objective = "检查文档一致性并汇总告诉我审计结果";
    // provider 抛错——若命中 fast-path 就不会走到 LLM，故此处不应抛出
    const result = await evaluateGoal(
      goal,
      "占位上下文",
      { model: "x", provider: failingProvider(), timeout: 1000, minTurnsBeforeEval: 2 },
      { stopReason: "end_turn", assistantTextLength: 3000 },
    );
    expect(result.satisfied).toBe(true);
    expect(result.progress).toBe(100);
  });

  test("报告型目标但 assistant 文本过短 → 不命中 fast-path", async () => {
    const { evaluateGoal } = await import("../../src/goal/evaluator.ts");
    const goal = createGoal("汇总告诉我结果");
    goal.objective = "汇总告诉我结果";
    // 文本仅 100 字符 < 500 阈值 → 不命中 fast-path → 走 LLM（失败降级为未满足）
    const result = await evaluateGoal(
      goal,
      "占位",
      { model: "x", provider: failingProvider(), timeout: 1000, minTurnsBeforeEval: 2 },
      { stopReason: "end_turn", assistantTextLength: 100 },
    );
    expect(result.satisfied).toBe(false);
  });
});

// ─── Trace 事件 ───

describe("handleGoalGate · trace 事件", () => {
  test("注入 traceAppendEvent 时写入 GoalGateDecision 事件", async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      goalOverrides: { turnsUsed: 5 },
      evalResponse: JSON.stringify({ satisfied: false, reason: "继续" }),
    });
    ctx.goal.objective = "完成迁移工作";
    ctx.traceAppendEvent = (e) => events.push(e);
    ctx.sessionId = "sess-1";
    await handleGoalGate(ctx);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event).toBe("GoalGateDecision");
  });
});
