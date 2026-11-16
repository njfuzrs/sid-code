/**
 * Goal 硬约束每轮生效 — 集成测试（G1 / G3 / G4）
 *
 * 守的是 2026-11-16 事故：`maxTurns` / `tokenBudget` 原本只在 `isEndTurnLike` 分支
 * （`handleGoalGate`）里检查，模型连续 `tool_use` 空转时**一次都没被检查过**
 * （实测 119 轮轮询、`goal.maxTurns=150` 形同虚设）。
 *
 * 这几条用例的核心不是"上限能拦住"，而是"上限**每轮**都判"：
 * 响应序列全部是 tool_use，没有任何 end_turn —— 旧实现下一条都不会触发。
 *
 * 设计约束（同 goal-loop.test.ts）：不触发真实 LLM 网络调用。
 * 需要走 Goal Gate 的用例把 `goal.minTurnsBeforeEval` 设成 999 → gate 走
 * 「前 N 轮跳过评估」直接放行，不构造评估者调用。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import type { GoalState } from "@sid-code/core/goal/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "test-model",
    provider: "anthropic",
    maxTurns: 50,
    goal: { minTurnsBeforeEval: 999 },
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* 收尾轮不读流内容 */
}

/** 一轮 tool_use 响应（不同轮用不同 tool 名，便于断言"第 N 轮确实执行了"） */
function toolUseResponse(
  text: string,
  toolName = "bash",
  usage = { inputTokens: 100, outputTokens: 50 },
): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: `call-${text}`, name: toolName, input: { command: "true" } },
    ] as ContentBlock[],
    stopReason: "tool_use",
    usage,
  };
}

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

interface Harness {
  loopConfig: QueryLoopConfig;
  goal: GoalState;
  /** 每次 updateGoalState 后的 status（= 生产里"落盘 + 状态栏刷新"的观测点） */
  syncedStatuses: string[];
  /** processStream 实际被调用次数（= 模型调用次数） */
  modelCalls: () => number;
  /** executeTools 每轮的入参（tool_use 块） */
  toolCalls: () => ContentBlock[][];
  /** GoalGateDecision trace 事件的 data 列表 */
  decisions: () => Array<Record<string, unknown>>;
  /** 收尾时拿到的 done 事件 */
  doneEvent: () => Record<string, unknown> | undefined;
  /** 全部 system 事件文本（告警条数断言用） */
  systemTexts: () => string[];
  /** 跑完一轮 queryLoop */
  run: () => Promise<void>;
}

function makeHarness(opts: {
  goal: GoalState;
  responses: AccumulatedResponse[];
  config?: Partial<Config>;
  /** 当前权限模式（plan = 计划模式，goal 应暂停计量） */
  permissionMode?: "default" | "plan";
  /** 往工具注册表里塞工具（F1 空参数检测需要工具的 required schema） */
  registerTools?: (registry: ToolRegistry) => void;
}): Harness {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: opts.goal.objective }] });

  let respIdx = 0;
  const goal = opts.goal;
  const syncedStatuses: string[] = [];
  const executed: ContentBlock[][] = [];
  const traceEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
  let done: Record<string, unknown> | undefined;
  const systemTexts: string[] = [];

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = opts.responses[respIdx] ?? endTurnResponse("（无更多响应）");
      respIdx++;
      return r;
    },
    executeTools: async (content: ContentBlock[]) => {
      executed.push(content);
      // content 里可能先有 text 块，必须按类型找 tool_use（不是取 [0]）
      const block = content.find((b) => b.type === "tool_use");
      const id = block && block.type === "tool_use" ? block.id : "call-unknown";
      return {
        results: [
          { type: "tool_result", tool_use_id: id, content: "ok", is_error: false } as ContentBlock,
        ],
      };
    },
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${respIdx}`,
    getGoalState: () => goal,
    getCurrentPermissionMode: () => opts.permissionMode ?? "default",
    updateGoalState: (updater: (g: GoalState) => void) => {
      updater(goal);
      syncedStatuses.push(goal.status);
    },
    traceAppendEvent: (ev: { event: string; data?: Record<string, unknown> }) => {
      traceEvents.push(ev);
    },
  };

  const toolRegistry = new ToolRegistry();
  opts.registerTools?.(toolRegistry);

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(opts.config),
    ctxMgr,
    toolRegistry,
    sessionState: new SessionState(`test-goal-limits-${Math.random()}`),
    fallback: new ModelFallback(),
    deps,
  };

  return {
    loopConfig,
    goal,
    syncedStatuses,
    modelCalls: () => respIdx,
    toolCalls: () => executed,
    decisions: () =>
      traceEvents.filter((e) => e.event === "GoalGateDecision").map((e) => e.data ?? {}),
    doneEvent: () => done,
    systemTexts: () => systemTexts,
    run: async () => {
      for await (const ev of queryLoop(loopConfig)) {
        if (ev.kind === "system") systemTexts.push((ev as unknown as { text: string }).text);
        if (ev.kind === "done") done = ev as unknown as Record<string, unknown>;
      }
    },
  };
}

const N_TOOL_ROUNDS = (n: number, toolName = "bash") =>
  Array.from({ length: n }, (_, i) => toolUseResponse(`第${i + 1}轮`, toolName));

/** 空参数的 tool_use（F1 退化形态：input={} 且工具 schema 有 required 字段） */
function emptyParamToolUse(
  text: string,
  usage = { inputTokens: 100, outputTokens: 50 },
): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: `call-${text}`, name: "bash", input: {} },
    ] as ContentBlock[],
    stopReason: "tool_use",
    usage,
  };
}

/** 带 required 的工具（F1 判据需要它才能识别「真退化」而不是「本就无必填参数」） */
function bashLikeTool(): LegacyTool {
  return {
    name: () => "bash",
    description: () => "run a command",
    inputSchema: () => ({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
    call: async () => ({ output: "ok" }),
  } as unknown as LegacyTool;
}

describe("G1 · goal 轮次上限每轮生效", () => {
  test("T-G1-1：maxTurns=5、10 轮 tool_use → 第 5 轮后收尾，不再发第 6 次工作请求", async () => {
    const goal = createGoal("推进目标", { maxTurns: 5 });
    const h = makeHarness({ goal, responses: N_TOOL_ROUNDS(10) });

    await h.run();

    expect(goal.status).toBe("turns_limited");
    // 5 轮工作 + 1 轮强制总结 = 6 次模型调用（旧实现会跑满 10 轮 tool_use）
    expect(h.modelCalls()).toBe(6);
    expect(h.toolCalls().length).toBe(5);
    // 归因恰好一条，且口径是 turns_limited（不是 budget 族）
    const d = h.decisions();
    expect(d.filter((x) => x.reason === "turns_limited").length).toBe(1);
    expect(d[0]!.shouldContinue).toBe(false);
    // 终态经 updateGoalState 同步（不落盘 resume 会看到 active）
    expect(h.syncedStatuses).toContain("turns_limited");
    // done 上有显式声明，供 SDK / 轨迹归因
    expect((h.doneEvent()!.goalLimitExceeded as { source: string }).source).toBe("turns");
  });

  test("T-G1-2：第 5 轮的工具照常执行完（tool_use/tool_result 必须成对）", async () => {
    const goal = createGoal("推进目标", { maxTurns: 5 });
    const h = makeHarness({
      goal,
      // 前 4 轮 bash，第 5 轮 write —— 断言第 5 轮的工具没有被裁掉
      responses: [...N_TOOL_ROUNDS(4), toolUseResponse("第5轮", "write"), ...N_TOOL_ROUNDS(5)],
    });

    await h.run();

    expect(h.toolCalls().length).toBe(5);
    // content 里可能先有 text 块，按类型找 tool_use
    const last = h.toolCalls()[4]!.find((b) => b.type === "tool_use");
    expect(last && last.type === "tool_use" ? last.name : "").toBe("write");
    // 工具结果已回注（下一轮请求能看到），否则会留下悬空 tool_use
    const msgs = h.loopConfig.ctxMgr.getMessages();
    const flat = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(flat.some((b: any) => b.type === "tool_result" && b.tool_use_id === "call-第5轮")).toBe(
      true,
    );
  });

  test("T-G1-3：goal.turnsUsed 跨用户消息累计 → 第二条消息第 1 轮就收尾", async () => {
    const goal = createGoal("推进目标", { maxTurns: 5 });
    // 主循环 maxTurns=4：第一条消息跑到第 4 轮就被 while 条件挡住，goal.turnsUsed 停在 4
    const h = makeHarness({
      goal,
      responses: N_TOOL_ROUNDS(10),
      config: { maxTurns: 4 } as Partial<Config>,
    });

    // 第一条用户消息：4 轮 tool_use（turnsUsed 4 < 5），随后 maxTurns 挡住主循环
    await h.run();
    expect(goal.turnsUsed).toBe(4);
    expect(goal.status).toBe("active");

    // 第二条用户消息：LoopState 重建，但 goal 跨消息累计 → 第 1 轮即命中
    const h2 = makeHarness({ goal, responses: N_TOOL_ROUNDS(10) });
    await h2.run();

    expect(goal.status).toBe("turns_limited");
    expect(h2.toolCalls().length).toBe(1);
    expect(h2.modelCalls()).toBe(2); // 那 1 轮工作 + 1 轮强制总结
    expect(h2.doneEvent()!.goalLimitExceeded).toEqual({ source: "turns" });
  });

  test("T-G1-4：运行时 /goal turns 调大到 8 → 第 8 轮才收尾（上限是活的，不是启动时快照）", async () => {
    const goal = createGoal("推进目标", { maxTurns: 5 });
    const h = makeHarness({ goal, responses: N_TOOL_ROUNDS(10) });
    // 模拟用户在跑动中执行 /goal turns 8
    goal.maxTurns = 8;

    await h.run();

    expect(goal.status).toBe("turns_limited");
    expect(h.toolCalls().length).toBe(8);
    expect(h.modelCalls()).toBe(9);
  });
});

describe("G3 · todo write 死锁 / 预算告警重复", () => {
  test("T-G3-1：tokenBudget=1000、每轮 450 → 第 3 轮 budget_limited；告警只注入 1 次", async () => {
    const goal = createGoal("推进目标", { tokenBudget: 1000 });
    const h = makeHarness({
      goal,
      responses: Array.from({ length: 10 }, (_, i) =>
        toolUseResponse(`第${i + 1}轮`, "bash", { inputTokens: 400, outputTokens: 50 }),
      ),
    });

    await h.run();

    expect(goal.status).toBe("budget_limited");
    // 450 / 900(告警) / 1350(超限) → 第 3 轮收尾
    expect(h.toolCalls().length).toBe(3);
    expect(h.modelCalls()).toBe(4);
    // 告警只在第 2 轮出现一次：不去重就会第 2、3 轮各塞一条
    expect(h.systemTexts().filter((t) => t.includes("预算预警")).length).toBe(1);
    expect(h.doneEvent()!.goalLimitExceeded).toEqual({ source: "budget" });
  });

  test("T-G3-1b：连续多轮都处于告警档 → 提醒只注入 1 次（不是每轮一条）", async () => {
    const goal = createGoal("推进目标", { tokenBudget: 100000 });
    goal.tokensUsed = 85000; // 模拟长会话已用掉 85%
    const h = makeHarness({
      goal,
      // 每轮 +1000：86000 / 87000 / 88000 —— 三轮全在 85%~100% 之间（warning 档）
      responses: Array.from({ length: 3 }, (_, i) =>
        toolUseResponse(`第${i + 1}轮`, "bash", { inputTokens: 1000, outputTokens: 0 }),
      ),
      config: { maxTurns: 3 } as Partial<Config>,
    });

    await h.run();

    expect(goal.status).toBe("active"); // 没耗尽，只是告警
    expect(h.systemTexts().filter((t) => t.includes("预算预警")).length).toBe(1);
    // 对话里也只注入一条 warning 文本（不重复塞）
    const msgs = h.loopConfig.ctxMgr.getMessages();
    const texts = msgs
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === "text")
      .map((b: any) => String(b.text));
    expect(texts.filter((t) => t.includes("预算预警") || t.includes("警告")).length).toBe(1);
  });
});

describe("G4 · token 记账不双记", () => {
  test("T-G4-1：无预算时每轮都记账（tool_use 轮也记），末轮 end_turn 不重复记", async () => {
    const goal = createGoal("推进目标", { maxTurns: 20 });
    const h = makeHarness({
      goal,
      // 3 轮 tool_use + 1 轮 end_turn；主循环 maxTurns=4 让它在 end_turn 后退出
      responses: [
        toolUseResponse("r1"),
        toolUseResponse("r2"),
        toolUseResponse("r3"),
        endTurnResponse("r4"),
      ],
      config: { maxTurns: 4 } as Partial<Config>,
    });

    await h.run();

    // 4 轮 × (100 + 50) = 600，**外加强制总结轮 150**（T-G4-3 之前的实现不记收尾轮，
    // 这条断言当时是 600；修了收尾轮漏账后应为 750）。
    // 「不双记」这条契约仍由它守：若每轮检查与 handleGoalGate 都记账，末轮会被算两次，
    // 结果会是 900（6 × 150）而不是 750。
    expect(goal.tokensUsed).toBe(750);
  });

  test("T-G4-2：end_turn 轮只记一次（旧路径 + 新路径同时记账会翻倍）", async () => {
    const goal = createGoal("推进目标", { maxTurns: 20 });
    const h = makeHarness({
      goal,
      // 仅 1 轮 end_turn；maxTurns=1 → 主循环直接退出，只走一次记账
      responses: [endTurnResponse("一次说完", { inputTokens: 300, outputTokens: 100 })],
      config: { maxTurns: 1 } as Partial<Config>,
    });

    await h.run();

    // 那一轮 end_turn 400 + 强制总结轮 150（默认响应）= 550。
    // 若 end_turn 被两条路径各记一次，这里会是 950（400 + 400 + 150）。
    expect(goal.tokensUsed).toBe(550);
  });

  test("T-G4-3：强制总结轮也进账（撞 goal 上限时 900 而不是 750）", async () => {
    // 2026-11-16 复核发现的漏账：每轮检查只覆盖 while 内的轮次，收尾轮在 while 之外，
    // 不经过 checkGoalHardLimits。修前实测 maxTurns=5 只记到 750（5×150），
    // 比值 0.83，达不到方案 §7.5 的 tokensUsed ÷ AfterModel 合计 ∈ [0.95, 1.05]。
    const goal = createGoal("推进目标", { maxTurns: 5 });
    const h = makeHarness({ goal, responses: N_TOOL_ROUNDS(10) });

    await h.run();

    expect(h.modelCalls()).toBe(6); // 5 轮工作 + 1 轮强制总结
    expect(goal.tokensUsed).toBe(900); // 6 × (100 + 50)
  });

  test("T-G4-4：主循环撞 maxTurns、goal 仍 active → 收尾轮同样进账", async () => {
    const goal = createGoal("推进目标", { maxTurns: 100 });
    const h = makeHarness({
      goal,
      responses: N_TOOL_ROUNDS(10),
      config: { maxTurns: 3 } as Partial<Config>,
    });

    await h.run();

    expect(goal.status).toBe("active");
    expect(h.modelCalls()).toBe(4); // 3 轮工作 + 1 轮强制总结
    expect(goal.tokensUsed).toBe(600); // 4 × (100 + 50)
  });
});

describe("G1/G3/G4 · plan mode 期间 goal 暂停计量", () => {
  test("T-PLAN-1：plan mode、goal.maxTurns=3 → 轮次/token 都不记，上限不可能触发", async () => {
    // 2026-11-16 复核发现的 P1：此前只豁免「判上限」而没豁免「累加轮次」与「记账」，
    // 三者不一致。实测 plan mode 下 turnsUsed=50 / tokensUsed=0 / status=active
    // （goal.maxTurns=3 形同不存在），退出 plan mode 后立刻 turns_limited，
    // 且这些轮的 token 对 tokenBudget 完全隐形。
    const goal = createGoal("推进目标", { maxTurns: 3 });
    const h = makeHarness({
      goal,
      responses: N_TOOL_ROUNDS(10),
      permissionMode: "plan",
    });

    await h.run();

    expect(goal.turnsUsed).toBe(0);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.status).toBe("active");
    expect(h.decisions().filter((x) => x.reason === "turns_limited").length).toBe(0);
  });

  test("T-PLAN-2：对照 default 模式 → 同一输入按 goal 上限收尾", async () => {
    // 守住「差异确实来自 plan 判据」，而不是 harness 本身没跑起来
    const goal = createGoal("推进目标", { maxTurns: 3 });
    const h = makeHarness({ goal, responses: N_TOOL_ROUNDS(10) });

    await h.run();

    expect(goal.status).toBe("turns_limited");
    expect(goal.turnsUsed).toBe(3);
    expect(goal.tokensUsed).toBe(600); // 3 轮工作 + 1 轮总结，各 150
  });
});

describe("G4 · F1 空参数重试轮也记账", () => {
  test("T-F1-1：退化重试轮不丢账（3 次真实调用 = 450，而不是 300）", async () => {
    // 2026-11-16 复核发现的第三处漏账：F1 分支在每轮硬约束检查（checkGoalHardLimits）
    // **之前**就 `continue` 了，那一轮真实发生的模型调用不进 goal.tokensUsed。
    // 期望值来自「tokensUsed 应当等于真实模型调用消耗」这个口径，
    // 不是从修复后的实现反推：3 次调用 × (100+50) = 450。
    const goal = createGoal("推进目标", { maxTurns: 20 });
    const h = makeHarness({
      goal,
      registerTools: (r) => r.register(bashLikeTool()),
      responses: [
        emptyParamToolUse("退化轮"), // 第 1 轮：空参数 → F1 重试（同一轮的第二次请求）
        toolUseResponse("恢复轮"), // 第 2 轮：正常 tool_use
        endTurnResponse("收尾轮"), // 第 3 轮：end_turn
      ],
      // 靠主循环 maxTurns 退出：goal.minTurnsBeforeEval=999 会让 end_turn 被 gate
      // 推回（gate 走「前 N 轮跳过评估」直接 shouldContinue），不设上限会一直跑到 10 轮
      config: { maxTurns: 3 } as Partial<Config>,
    });

    await h.run();

    // 先证明 F1 真的触发了，否则这条用例什么都没测到
    expect(h.systemTexts().some((t) => t.includes("参数为空"))).toBe(true);
    // 3 轮工作 + 1 轮强制总结
    expect(goal.turnsUsed).toBe(3);
    expect(h.modelCalls()).toBe(4);
    // 4 次真实调用 × 150。若退化重试轮漏账，这里会是 450
    expect(goal.tokensUsed).toBe(600);
  });
});
