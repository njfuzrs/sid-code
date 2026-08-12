/**
 * /goal 端到端循环 — 集成测试
 *
 * 真正驱动 queryLoop，验证 Goal Gate / Evidence Collector 在主循环中协同工作。
 *
 * 设计约束：Goal Gate 内部构造评估者 Provider（无法经 deps 注入 mock），
 * 因此集成测试只覆盖「不触发真实 LLM 网络调用」的确定性路径：
 *   ① Evidence Log 自动收集：bash 测试结果被自动提取为 test_result 证据
 *   ② 快速路径完成：测试全绿证据 → Goal Gate 经快速路径判定 satisfied（不调 LLM）→ status=complete
 *   ③ 多轮证据累积：跨轮 tool 调用的证据累积，末轮全绿 → 完成
 *   ④ 预算耗尽：tokenBudget 超限 → 预算检查在评估之前拦截（不调 LLM）→ status=budget_limited
 *   ⑤ 非活跃目标（paused）不触发 Goal Gate
 *
 * 「评估未满足 → 续命」依赖真实 LLM，已在 tests/goal/goal-gate.test.ts 用 mock provider 确定性覆盖，
 * 此处不重复（避免网络依赖与 flaky）。
 *
 * 关键机制说明（影响断言设计）：
 * - Goal Gate 仅在 end_turn 响应时触发（tool_use 响应执行完工具后继续循环，不触发）。
 *   故每个用例以「若干 tool_use 轮（产证据）+ 末轮 end_turn（触发 gate）」组织。
 * - 预算检查读的是触发 gate 那一轮（end_turn 响应）的 usage。
 *
 * mock 范式参照 tests/query/abort-graceful.test.ts。
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import type { GoalState } from "@sid-code/core/goal/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 20 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  // abort 路径不涉及，stream 内容不重要
}

/** 一轮"跑测试"的 LLM 响应：assistant 文本 + bash tool_use */
function bashTestResponse(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: "call-test", name: "bash", input: { command: "bun test" } },
    ] as ContentBlock[],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

/** 一轮 end_turn（无工具）的响应，触发 Goal Gate */
function endTurnResponse(
  text: string,
  usage = { inputTokens: 100, outputTokens: 50 },
): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }] as ContentBlock[],
    stopReason: "end_turn",
    usage,
  };
}

/** bash 工具结果块 */
function bashResult(output: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: "call-test",
    content: output,
    is_error: false,
  } as ContentBlock;
}

/** 测试全绿输出（summary 行含 "0 fail" → 命中快速路径） */
const GREEN = "bun test\n100 pass, 0 fail";
/** 测试未过输出 */
const RED = "bun test\n50 pass, 5 fail";

/**
 * 构造一个驱动 goal 循环的 QueryLoopConfig。
 * responses 按轮次顺序返回；executeTools 对每个 tool_use 轮按序返回 toolOutputs。
 */
function makeGoalLoop(opts: {
  goal: GoalState;
  responses: AccumulatedResponse[];
  toolOutputs: string[];
}): { loopConfig: QueryLoopConfig; goal: GoalState; syncedStatuses: string[] } {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: opts.goal.objective }] });

  let respIdx = 0;
  let toolIdx = 0;
  const goal = opts.goal;
  // 记录每次 updateGoalState 调用后的 status —— 等价于生产中"触发持久化 + TUI 刷新副作用"的次数。
  // 终态（budget_limited/turns_limited/blocked）必须经此回调同步，否则不落盘。
  const syncedStatuses: string[] = [];

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = opts.responses[respIdx] ?? endTurnResponse("（无更多响应）");
      respIdx++;
      return r;
    },
    executeTools: async () => {
      const output = opts.toolOutputs[toolIdx] ?? "done";
      toolIdx++;
      return { results: [bashResult(output)] };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${respIdx}`,
    getGoalState: () => goal,
    updateGoalState: (updater: (g: GoalState) => void) => {
      updater(goal);
      syncedStatuses.push(goal.status);
    },
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-goal-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, goal, syncedStatuses };
}

describe("/goal 端到端循环", () => {
  test("① Evidence Log 自动收集 bash 测试结果", async () => {
    const goal = createGoal("让 bun test 通过");
    // 跑测试（全绿）→ 收集证据 → end_turn 触发 gate → 快速路径满足 → 收尾
    const { loopConfig } = makeGoalLoop({
      goal,
      responses: [bashTestResponse("我来跑测试"), endTurnResponse("测试已通过")],
      toolOutputs: [GREEN],
    });

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(goal.evidenceLog.length).toBeGreaterThan(0);
    const testEvidence = goal.evidenceLog.find((e) => e.type === "test_result");
    expect(testEvidence).toBeDefined();
    expect(testEvidence!.summary).toContain("0 fail");
  });

  test("② 测试全绿 → 快速路径判定完成 → status=complete（不调 LLM）", async () => {
    const goal = createGoal("让 bun test 通过");
    const { loopConfig } = makeGoalLoop({
      goal,
      responses: [bashTestResponse("跑测试"), endTurnResponse("汇总：全部通过")],
      toolOutputs: [GREEN],
    });

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system") systemTexts.push((ev as any).text);
    }

    expect(goal.status).toBe("complete");
    expect(systemTexts.some((t) => t.includes("目标达成"))).toBe(true);
  });

  test("③ 多轮 tool 证据累积，末轮全绿 → 完成", async () => {
    const goal = createGoal("让 bun test 通过");
    // 轮1 测试失败、轮2 测试通过，轮3 end_turn 触发 gate（此时最新证据是绿的）
    const { loopConfig } = makeGoalLoop({
      goal,
      responses: [
        bashTestResponse("第一次跑"),
        bashTestResponse("修完再跑"),
        endTurnResponse("通过了"),
      ],
      toolOutputs: [RED, GREEN],
    });

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    // 两轮 tool 各产一条 test_result 证据
    expect(goal.evidenceLog.filter((e) => e.type === "test_result").length).toBe(2);
    // 末轮证据为绿 → 快速路径完成
    expect(goal.status).toBe("complete");
  });

  test("④ 预算耗尽 → 预算检查先于评估拦截 → status=budget_limited（不调 LLM）", async () => {
    const goal = createGoal("让 bun test 通过", { tokenBudget: 1000 });
    // 末轮 end_turn 的 usage 超预算（触发 gate 时读的就是这一轮）；
    // 证据为 RED 确保即便走到评估也不会快速完成（但预算检查在评估前就拦截）
    const { loopConfig, syncedStatuses } = makeGoalLoop({
      goal,
      responses: [
        bashTestResponse("跑测试"),
        endTurnResponse("汇总", { inputTokens: 800, outputTokens: 300 }), // 1100 > 1000
      ],
      toolOutputs: [RED],
    });

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(goal.status).toBe("budget_limited");
    // 终态必须经 updateGoalState 同步（触发持久化 + TUI 刷新），否则进程退出后不落盘、resume 仍显示 active
    expect(syncedStatuses).toContain("budget_limited");
    // 收尾消息已注入对话
    const msgs = loopConfig.ctxMgr.getMessages();
    const budgetMsg = msgs.find(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes("预算已耗尽")),
    );
    expect(budgetMsg).toBeDefined();
  });

  test("⑤ 非活跃目标（paused）不触发 Goal Gate", async () => {
    const goal = createGoal("让 bun test 通过");
    goal.status = "paused";
    const { loopConfig } = makeGoalLoop({
      goal,
      responses: [endTurnResponse("直接结束")],
      toolOutputs: [],
    });

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    // paused：Goal Gate 跳过，状态不被改成 complete
    expect(goal.status).toBe("paused");
  });

  test("⑥ 轮次超限 → status=turns_limited 且经 updateGoalState 同步落盘", async () => {
    const goal = createGoal("让 bun test 通过", { maxTurns: 1 });
    // turnsUsed 起步 1，本轮 reminder 段会 turnsUsed++ → 2 ≥ maxTurns(1) → 轮次超限
    goal.turnsUsed = 1;
    const { loopConfig, syncedStatuses } = makeGoalLoop({
      goal,
      // 末轮证据为 RED，避免快速路径完成；end_turn 触发 gate → 轮次检查拦截
      responses: [bashTestResponse("跑测试"), endTurnResponse("汇总")],
      toolOutputs: [RED],
    });

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(goal.status).toBe("turns_limited");
    // 终态必须经 updateGoalState 同步，否则不落盘
    expect(syncedStatuses).toContain("turns_limited");
  });
});
