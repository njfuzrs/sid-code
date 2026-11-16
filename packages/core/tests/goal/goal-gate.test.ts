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
import { handleGoalGate, type GoalGateContext } from "@sid-code/core/query/goal-gate.ts";
import {
  MAX_CONSECUTIVE_WAIT_PASSES,
  type GoalWaitingFacts,
} from "@sid-code/core/query/goal-waiting.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import { BlockedDetector } from "@sid-code/core/goal/blocked-detector.ts";
import { DEFAULT_GOAL_CONFIG } from "@sid-code/core/goal/config.ts";
import type { EvalConfig } from "@sid-code/core/goal/evaluator.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent, Message } from "@sid-code/core/llm/types.ts";

// ─── Mock ───

function mockProvider(responseText: string): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: responseText },
      } as StreamEvent;
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
  blockedDetector?: BlockedDetector;
  messages?: Message[];
}): GoalGateContext {
  const goal = createGoal("让 bun test 通过", {
    tokenBudget: opts.goalOverrides?.tokenBudget,
    maxTurns: opts.goalOverrides?.maxTurns,
  });
  Object.assign(goal, opts.goalOverrides);
  return {
    goal,
    messages: opts.messages ?? [],
    evalConfig: evalConfig(
      mockProvider(opts.evalResponse ?? JSON.stringify({ satisfied: false, reason: "继续" })),
    ),
    goalConfig: DEFAULT_GOAL_CONFIG,
    blockedDetector:
      opts.blockedDetector ?? new BlockedDetector(DEFAULT_GOAL_CONFIG.blockedThreshold),
  };
}

// ─── 预算 ───

// ─── 职责边界（2026-11-16 拆分）───

describe("handleGoalGate · 职责边界", () => {
  // 预算与轮次判定已移到 goal/limits.ts 的 checkGoalHardLimits（每轮执行，
  // 不再只在 end_turn 触发）。这里锁住"没人把它们又塞回 gate"：
  // 塞回来就会重新变成「模型连续 tool_use 时空转不受上限约束」那个事故形态。
  test("即使预算已耗尽，gate 本身不再拦截（判定已前移到每轮硬约束检查）", async () => {
    const ctx = makeCtx({
      goalOverrides: { tokenBudget: 1000, tokensUsed: 5000, turnsUsed: 5 },
      evalResponse: JSON.stringify({ satisfied: false, reason: "还在做" }),
    });
    const out = await handleGoalGate(ctx);
    expect(ctx.goal.status).not.toBe("budget_limited");
    expect(out.result.shouldContinue).toBe(true);
  });

  test("即使轮次已超限，gate 本身不再拦截（判定已前移到每轮硬约束检查）", async () => {
    const ctx = makeCtx({
      goalOverrides: { turnsUsed: 50, maxTurns: 50 },
      evalResponse: JSON.stringify({ satisfied: false, reason: "还在做" }),
    });
    const out = await handleGoalGate(ctx);
    expect(ctx.goal.status).not.toBe("turns_limited");
    expect(out.result.shouldContinue).toBe(true);
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
      evalResponse: JSON.stringify({
        satisfied: false,
        reason: "还差 2 个测试",
        progress: 70,
        blockerKey: "test-x",
      }),
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
      const response = JSON.stringify({
        satisfied: false,
        reason: "卡在同一处",
        blockerKey: "stuck-key",
      });

      // 前两次：未满足但未达阈值 → 继续
      for (let i = 0; i < 2; i++) {
        const ctx = makeCtx({
          goalOverrides: { turnsUsed: 5 + i },
          evalResponse: response,
          blockedDetector: detector,
        });
        ctx.goal.objective = "完成迁移工作";
        const out = await handleGoalGate(ctx);
        expect(out.result.shouldContinue).toBe(true);
      }

      // 第三次：连续 3 次相同 blockerKey → 降级模式下仍继续，但注入"换思路"软提醒、不标 blocked
      const ctx3 = makeCtx({
        goalOverrides: { turnsUsed: 7 },
        evalResponse: response,
        blockedDetector: detector,
      });
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
      const response = JSON.stringify({
        satisfied: false,
        reason: "卡在同一处",
        blockerKey: "stuck-key",
      });

      for (let i = 0; i < 2; i++) {
        const ctx = makeCtx({
          goalOverrides: { turnsUsed: 5 + i },
          evalResponse: response,
          blockedDetector: detector,
        });
        ctx.goal.objective = "完成迁移工作";
        const out = await handleGoalGate(ctx);
        expect(out.result.shouldContinue).toBe(true);
      }

      const ctx3 = makeCtx({
        goalOverrides: { turnsUsed: 7 },
        evalResponse: response,
        blockedDetector: detector,
      });
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
          // 必失败 provider → catch 分支设 blockerKey=__evaluator_unavailable__
          evalConfig: {
            model: "haiku-test",
            provider: failingProvider(),
            timeout: 1000,
            minTurnsBeforeEval: 2,
          },
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
      evalConfig: {
        model: "haiku-test",
        provider: failingProvider(),
        timeout: 1000,
        minTurnsBeforeEval: 2,
      },
      goalConfig: DEFAULT_GOAL_CONFIG,
      blockedDetector: new BlockedDetector(3),
    };
    const out = await handleGoalGate(ctx);
    const warnMsg = out.systemMessages.find(
      (m) => m.level === "warning" && m.text.includes("评估器连续失败"),
    );
    expect(warnMsg).toBeDefined();
  });

  test("默认（降级）模式：告警文案不承诺「自动放行」，改为「持续提醒」", async () => {
    // 回归 P0-1 告警文案与默认行为不一致：默认模式达阈值不放行，文案不得写「将自动放行」
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    delete process.env.SID_ENABLE_GOAL_HARD_STOP;
    try {
      const ctx: GoalGateContext = {
        goal: (() => {
          const g = createGoal("完成迁移工作");
          g.objective = "完成迁移工作";
          g.turnsUsed = 5;
          return g;
        })(),
        messages: [],
        evalConfig: {
          model: "haiku-test",
          provider: failingProvider(),
          timeout: 1000,
          minTurnsBeforeEval: 2,
        },
        goalConfig: DEFAULT_GOAL_CONFIG,
        blockedDetector: new BlockedDetector(3),
      };
      const out = await handleGoalGate(ctx);
      const warnMsg = out.systemMessages.find(
        (m) => m.level === "warning" && m.text.includes("评估器连续失败"),
      );
      expect(warnMsg).toBeDefined();
      expect(warnMsg!.text).not.toContain("自动放行");
      expect(warnMsg!.text).toContain("持续提醒");
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });

  test("硬停止模式：告警文案承诺「自动放行」", async () => {
    const saved = process.env.SID_ENABLE_GOAL_HARD_STOP;
    process.env.SID_ENABLE_GOAL_HARD_STOP = "1";
    try {
      const ctx: GoalGateContext = {
        goal: (() => {
          const g = createGoal("完成迁移工作");
          g.objective = "完成迁移工作";
          g.turnsUsed = 5;
          return g;
        })(),
        messages: [],
        evalConfig: {
          model: "haiku-test",
          provider: failingProvider(),
          timeout: 1000,
          minTurnsBeforeEval: 2,
        },
        goalConfig: DEFAULT_GOAL_CONFIG,
        blockedDetector: new BlockedDetector(3),
      };
      const out = await handleGoalGate(ctx);
      const warnMsg = out.systemMessages.find(
        (m) => m.level === "warning" && m.text.includes("评估器连续失败"),
      );
      expect(warnMsg).toBeDefined();
      expect(warnMsg!.text).toContain("自动放行");
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_GOAL_HARD_STOP;
      else process.env.SID_ENABLE_GOAL_HARD_STOP = saved;
    }
  });
});

// ─── P1-1：报告型任务放行（F3 后降级为「评估器不可用时的兜底」）───
//
// 语义变更（F3，2026-09-03）：这段放行原先在 tryFastPathEval 最前面、抢在评估器之前，
// 于是评估器健康时也会被它判定完成，且连 Evidence Log 都不看。现已移到评估器失败后的
// catch 分支——能力保留（这类任务没有客观完成信号，评估器一挂就没出路），抢跑消除。
// 下面两条用 failingProvider() 恰好落在「评估器不可用」这个前提上，故仍应放行。

describe("evaluateGoal · 报告型任务兜底放行（P1-1 / F3）", () => {
  test("评估器不可用 + 目标含'汇总告诉我' + 实质文本 → 兜底放行", async () => {
    const { evaluateGoal } = await import("@sid-code/core/goal/evaluator.ts");
    const goal = createGoal("检查文档一致性并汇总告诉我审计结果");
    goal.objective = "检查文档一致性并汇总告诉我审计结果";
    // provider 抛错 → 走 catch → 报告型兜底判据成立 → 放行（保住 P1-1 的原能力）
    const result = await evaluateGoal(
      goal,
      "占位上下文",
      { model: "x", provider: failingProvider(), timeout: 1000, minTurnsBeforeEval: 2 },
      { stopReason: "end_turn", assistantTextLength: 3000 },
    );
    expect(result.satisfied).toBe(true);
    expect(result.progress).toBe(100);
    // 必须是兜底路径给的结论，不是 fast-path 抢跑
    expect(result.reason).toContain("兜底");
  });

  test("报告型目标但 assistant 文本过短 → 不放行（阈值 500 不变）", async () => {
    const { evaluateGoal } = await import("@sid-code/core/goal/evaluator.ts");
    const goal = createGoal("汇总告诉我结果");
    goal.objective = "汇总告诉我结果";
    // 文本仅 100 字符 < 500 阈值 → 兜底判据不成立 → 降级为未满足
    const result = await evaluateGoal(
      goal,
      "占位",
      { model: "x", provider: failingProvider(), timeout: 1000, minTurnsBeforeEval: 2 },
      { stopReason: "end_turn", assistantTextLength: 100 },
    );
    expect(result.satisfied).toBe(false);
  });

  test("评估器健康时，报告型目标由评估器判定，不被兜底抢跑（F3 变异自证）", async () => {
    const { evaluateGoal } = await import("@sid-code/core/goal/evaluator.ts");
    const goal = createGoal("审计文档一致性并汇总告诉我");
    goal.objective = "审计文档一致性并汇总告诉我";
    // 评估器可用且明确判「未完成」——旧实现会被 fast-path 抢在它前面判成完成。
    const result = await evaluateGoal(
      goal,
      "占位上下文",
      {
        model: "x",
        provider: mockProvider('{"satisfied": false, "reason": "报告缺少结论章节"}'),
        timeout: 1000,
        minTurnsBeforeEval: 2,
      },
      { stopReason: "end_turn", assistantTextLength: 3000 },
    );
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain("结论章节");
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

// ─── G2：等待挂起（修复方案 §4.2） ───

/**
 * 数调用次数的 mock 评估者。
 *
 * T-G2-1/3/4 的核心断言是「评估器**没被调用**」—— 只看返回结果分不出
 * 「因等待放行了」和「评估完之后恰好也放行」，所以必须数。
 */
function countingProvider(responseText: string): { provider: Provider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      name: () => "mock-count",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: responseText },
        } as StreamEvent;
      },
    },
    calls: () => calls,
  };
}

function makeWaitingCtx(opts: { waiting?: GoalWaitingFacts; evalResponse?: string } = {}) {
  const counter = countingProvider(
    opts.evalResponse ?? JSON.stringify({ satisfied: false, reason: "继续推进" }),
  );
  const ctx = makeCtx({ goalOverrides: { turnsUsed: 5 } });
  // 非测试类目标：避开报告型 fast-path，让「评估器是否被调用」这个断言有意义。
  ctx.goal.objective = "完成迁移工作";
  ctx.evalConfig = evalConfig(counter.provider);
  if (opts.waiting) ctx.waiting = opts.waiting;
  return { ctx, calls: counter.calls };
}

/** 一个「已挂上 monitor 等 CI」的事实包 */
const MONITOR_WAIT: GoalWaitingFacts = {
  hasDeclaredExternalWait: true,
  hasPendingNotifications: false,
  waitIds: ["mon_ci"],
};

describe("handleGoalGate · G2 等待挂起", () => {
  test("T-G2-1 有显式等待源 → 放行 end_turn、不调评估器、goal 仍 active", async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const { ctx, calls } = makeWaitingCtx({ waiting: MONITOR_WAIT });
    ctx.traceAppendEvent = (e) => events.push(e);
    ctx.sessionId = "sess-g2";

    const out = await handleGoalGate(ctx);

    expect(calls()).toBe(0);
    expect(out.result.waiting).toBe(true);
    expect(out.result.shouldContinue).toBe(false);
    expect(out.result.completed).toBe(false);
    expect(out.result.impossible).toBe(false);
    expect(out.result.waitIds).toEqual(["mon_ci"]);
    // 关键：不是终态。goal 仍然 active，通知到达后下一轮继续评估。
    expect(ctx.goal.status).toBe("active");

    const decision = events.find((e) => e.data?.reason === "waiting");
    expect(decision).toBeDefined();
    expect(decision!.data!.wait_ids).toEqual(["mon_ci"]);
    expect(decision!.data!.shouldContinue).toBe(false);
    expect(ctx.goal.waitPass).toEqual({ key: "mon_ci", count: 1 });

    // 用户可见回执：告诉他「在等」，而不是静默收尾。
    expect(out.systemMessages.some((m) => m.text.includes("等待中"))).toBe(true);
  });

  test("T-G2-2 只有派生后台任务、没有显式等待 → 照常调评估器", async () => {
    const { ctx, calls } = makeWaitingCtx({
      waiting: { hasDeclaredExternalWait: false, hasPendingNotifications: false, waitIds: [] },
    });
    const out = await handleGoalGate(ctx);
    expect(calls()).toBe(1);
    expect(out.result.waiting).toBeUndefined();
  });

  test("T-G2-3 同一组等待源连续放行到上限 → 第 4 次回到评估器", async () => {
    const { ctx, calls } = makeWaitingCtx({ waiting: MONITOR_WAIT });
    for (let i = 1; i <= MAX_CONSECUTIVE_WAIT_PASSES; i++) {
      const out = await handleGoalGate(ctx);
      expect(out.result.waiting).toBe(true);
      expect(ctx.goal.waitPass).toEqual({ key: "mon_ci", count: i });
    }
    expect(calls()).toBe(0);

    // 到顶后不再放行：评估器必须能看到这条路径（否则挂个等待就绕过了评估）。
    const over = await handleGoalGate(ctx);
    expect(over.result.waiting).toBeUndefined();
    expect(over.result.shouldContinue).toBe(true);
    expect(calls()).toBe(1);
    expect(ctx.goal.status).toBe("active");
  });

  test("T-G2-4 有待投递通知 → 也放行，不调评估器", async () => {
    const { ctx, calls } = makeWaitingCtx({
      waiting: { hasDeclaredExternalWait: false, hasPendingNotifications: true, waitIds: [] },
    });
    const out = await handleGoalGate(ctx);
    expect(calls()).toBe(0);
    expect(out.result.waiting).toBe(true);
    expect(ctx.goal.waitPass?.key).toBe("notification");
  });

  test("硬上限不归 gate 管（#881 已移到每轮检查）：轮次耗尽时仍按等待放行", async () => {
    // #881（2026-11-16）把轮次/预算检查移到了 `goal/limits.ts` 的 checkGoalHardLimits，
    // 由 loop 每轮在 gate **之前**调用（`goal-hard-limits-loop.test.ts` 守）。
    //
    // 所以本条断言的是**新契约**：gate 只按等待判据走，轮次耗尽的终止语义由 loop 侧负责。
    // 这同时防住「有人把轮次检查又塞回 gate」——那会让终止语义出现两个出口，
    // 而 G2 的等待放行恰好会把其中一个出口挡住。
    const { ctx, calls } = makeWaitingCtx({ waiting: MONITOR_WAIT });
    ctx.goal.turnsUsed = ctx.goal.maxTurns;
    const out = await handleGoalGate(ctx);
    expect(out.result.waiting).toBe(true);
    expect(ctx.goal.waitPass).toEqual({ key: "mon_ci", count: 1 });
    expect(calls()).toBe(0);
  });
});
