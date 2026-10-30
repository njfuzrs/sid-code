/**
 * continue 路径封顶与可观测性（2026-10-24）
 *
 * 锁住四件事：
 *   1. `model_context_window_exceeded` 有界：压不动立即收尾，压得动也只给
 *      MAX_CTX_WINDOW_RECOVERIES 次；收尾带 incompleteReason；不再冒用 max_tokens_continuation、
 *      不再吃掉 max_tokens 的「先提高上限」那一档。
 *   2. 发送错误只有一个处理入口：sendWithRetry 同步抛错也走流式 catch（原连接阶段 catch 已删）。
 *   3. 闸门耗尽语义：退化门（unanswered）耗尽 = 整条链收尾；质量门（todo）耗尽 = 只是本门
 *      放行，用户授权门（+500k）照常续跑。两者都落 GateExhausted。
 *   4. TurnComplete 带 continue_counts / max_continue_streak / gates_exhausted，digest 能据此
 *      判「超封顶」与「收尾后续命」。
 */
import { describe, test, expect } from "bun:test";
import { queryLoop, MAX_CTX_WINDOW_RECOVERIES } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { CONTINUE_STREAK_CAPS } from "@sid-code/core/query/transition.ts";
import { GATE_EXHAUSTION_EFFECT } from "@sid-code/core/query/gate-exhaustion.ts";
import { MAX_STOP_HOOK_RETRIES } from "@sid-code/core/query/stop-hooks.ts";
import {
  MAX_TODO_GATE_RETRIES,
  MAX_UNANSWERED_RETRIES,
} from "@sid-code/core/query/todo-reminder.ts";
import { MAX_PROMISE_NUDGES } from "@sid-code/core/query/promise-nudge.ts";
import { MAX_EMPTY_PARAM_RETRIES } from "@sid-code/core/query/empty-param.ts";
import { aggregateContinuePathStats } from "@sid-code/core/trace/digest.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 20,
    maxTokens: 8000,
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

function resp(stopReason: string, text = "x".repeat(50), outputTokens = 1000): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    usage: { inputTokens: 100, outputTokens },
  } as AccumulatedResponse;
}

const ctxWindow = () => resp("model_context_window_exceeded");
const endTurn = (text = "做完了") => resp("end_turn", text);

function unansweredResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "思考发散 ".repeat(80) }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 0 },
    _unansweredEndTurn: true,
  } as AccumulatedResponse;
}

interface Captured {
  event: string;
  data: Record<string, unknown>;
}

function setup(opts: {
  responses: AccumulatedResponse[];
  /** 历史消息对数：>2 对才让 reactiveCompact 有东西可压 */
  historyPairs?: number;
  userText?: string;
  configOverrides?: Partial<Config>;
  depsOverrides?: Partial<QueryDeps>;
}) {
  const events: Captured[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  for (let i = 0; i < (opts.historyPairs ?? 0); i++) {
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: `问题 ${i} `.repeat(40) }] });
    ctxMgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: `回答 ${i} `.repeat(40) }],
    });
  }
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: opts.userText ?? "请完成" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = opts.responses[call] ?? endTurn();
      call++;
      return r;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev) => {
      events.push({ event: ev.event, data: (ev.data ?? {}) as Record<string, unknown> });
    },
    ...opts.depsOverrides,
  };
  const loopConfig: QueryLoopConfig = {
    config: makeConfig(opts.configOverrides),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-continue-caps"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, events, ctxMgr, calls: () => call };
}

async function drain(loopConfig: QueryLoopConfig) {
  const yields: Array<Record<string, unknown>> = [];
  for await (const ev of queryLoop(loopConfig)) yields.push(ev as Record<string, unknown>);
  return yields;
}

const transitionsOf = (events: Captured[]) =>
  events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type as string);
const doneOf = (yields: Array<Record<string, unknown>>) => yields.find((y) => y.kind === "done");
const turnCompleteOf = (events: Captured[]) => events.find((e) => e.event === "TurnComplete");

describe("问题 1 · model_context_window_exceeded 必须有界", () => {
  test("压得动但持续撞上限 → 只续写 MAX_CTX_WINDOW_RECOVERIES 次后收尾，done 带 incompleteReason", async () => {
    const { loopConfig, events, calls } = setup({
      responses: Array.from({ length: 30 }, ctxWindow),
      historyPairs: 30,
      // 交互模式口径：maxTurns=0 → Infinity。修复前这里只能靠 maxTurns 兜，Infinity 下永不停。
      configOverrides: { maxTurns: 0 },
    });
    const yields = await drain(loopConfig);

    const ts = transitionsOf(events);
    expect(ts.filter((t) => t === "context_window_recovery").length).toBe(
      MAX_CTX_WINDOW_RECOVERIES,
    );
    // 不再冒用输出截断的 transition
    expect(ts).not.toContain("max_tokens_continuation");
    // 恢复 N 次 + 第 N+1 次撞上限时收尾 = N+1 次调用
    expect(calls()).toBe(MAX_CTX_WINDOW_RECOVERIES + 1);
    expect(doneOf(yields)?.incompleteReason).toBe("context_window_exhausted");

    const gx = events.filter((e) => e.event === "GateExhausted");
    expect(gx.map((e) => e.data.gate)).toEqual(["context_window"]);
    expect(gx[0]!.data.effect).toBe("chain_ends");
  });

  test("压不动 → 第一次撞上限就收尾，失败也落 CompactionAttempt", async () => {
    // 只有 1 条用户消息 + 1 条 assistant：reactiveCompact 的 `<=4 条` 守卫必然压不动
    const { loopConfig, events, calls } = setup({
      responses: Array.from({ length: 30 }, ctxWindow),
      configOverrides: { maxTurns: 0 },
    });
    const yields = await drain(loopConfig);

    expect(calls()).toBe(1);
    expect(transitionsOf(events)).not.toContain("context_window_recovery");
    expect(doneOf(yields)?.incompleteReason).toBe("context_window_exhausted");
    const attempts = events.filter(
      (e) => e.event === "CompactionAttempt" && e.data.trigger === "ctx_window_exceeded",
    );
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.data.success).toBe(false);
  });

  test("撞过一次窗口上限后，真正的 max_tokens 仍先走「提高上限」那一档", async () => {
    // 修复前 ctx-window 分支会 maxOutputTokensRecoveryCount++，而 escalate 只在计数为 0 时尝试
    const { loopConfig, events } = setup({
      responses: [ctxWindow(), resp("max_tokens", "y".repeat(100), 8000), endTurn()],
      historyPairs: 30,
      configOverrides: { maxTokens: 8000 },
    });
    await drain(loopConfig);
    const ts = transitionsOf(events);
    expect(ts).toEqual(["context_window_recovery", "max_tokens_escalate"]);
  });
});

describe("问题 2 · 发送错误只有一个处理入口", () => {
  test("sendWithRetry 同步抛 prompt-too-long → 走流式 catch 的响应式压缩，errors 记 phase=stream", async () => {
    const errors: Array<{ phase: string }> = [];
    let sends = 0;
    const { loopConfig, events } = setup({
      responses: [endTurn()],
      historyPairs: 30,
      depsOverrides: {
        sendWithRetry: () => {
          sends++;
          if (sends === 1) throw new Error("prompt is too long: 1200000 tokens > 1000000 maximum");
          return emptyStream();
        },
        recordError: (e) => {
          errors.push({ phase: e.phase });
        },
      },
    });
    const yields = await drain(loopConfig);

    expect(transitionsOf(events)).toEqual(["reactive_compact"]);
    expect(errors.map((e) => e.phase)).toEqual(["stream"]);
    expect(doneOf(yields)?.incompleteReason).toBeUndefined();
  });
});

describe("问题 3 · 闸门耗尽语义：退化门收尾整条链，质量门只放行本门", () => {
  const pending = (c: string): TodoItem => ({ content: c, activeForm: c, status: "pending" });

  test("todo 耗尽后 +500k 预算门照常续跑；GateExhausted(todo, gate_only) 恰落一次", async () => {
    const todos = [pending("步骤一"), pending("步骤二")];
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 20 }, () => endTurn("阶段性进展说明")),
      userText: "把这个模块重构完 +500k",
      configOverrides: { maxTurns: 8 },
      depsOverrides: { getTodoState: () => ({ todos, writeVersion: 1 }) },
    });
    await drain(loopConfig);

    const gx = events.filter((e) => e.event === "GateExhausted");
    expect(gx.map((e) => e.data.gate)).toEqual(["todo"]);
    expect(gx[0]!.data.effect).toBe("gate_only");
    expect(gx[0]!.data.retries).toBe(MAX_TODO_GATE_RETRIES);

    // 耗尽之后，用户授权的预算门仍在推进——这是设计行为，不是打穿
    const ts = transitionsOf(events);
    const lastTodo = ts.lastIndexOf("todo_gate_retry");
    expect(ts.slice(lastTodo + 1)).toContain("token_budget_continuation");
    expect(ts.filter((t) => t === "todo_gate_retry").length).toBe(MAX_TODO_GATE_RETRIES);
  });

  test("unanswered 耗尽 → 整条链收尾：其后零闸门 continue，GateExhausted 标 chain_ends", async () => {
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 12 }, unansweredResp),
      userText: "请深入审计 +500k",
      configOverrides: { maxTurns: 15 },
    });
    await drain(loopConfig);

    const gx = events.filter((e) => e.event === "GateExhausted");
    expect(gx.map((e) => e.data.gate)).toEqual(["unanswered"]);
    expect(gx[0]!.data.effect).toBe("chain_ends");
    expect(transitionsOf(events)).not.toContain("token_budget_continuation");
  });

  test("语义表覆盖每一道可耗尽的门，且退化类恰为 unanswered / empty_param / context_window", () => {
    const chainEnds = Object.entries(GATE_EXHAUSTION_EFFECT)
      .filter(([, v]) => v === "chain_ends")
      .map(([k]) => k)
      .sort();
    expect(chainEnds).toEqual(["context_window", "empty_param", "unanswered"]);
  });
});

describe("数据层 · TurnComplete 的 continue 计数", () => {
  test("continue_counts / max_continue_streak / gates_exhausted 与 LoopTransition 同源", async () => {
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 30 }, ctxWindow),
      historyPairs: 30,
      configOverrides: { maxTurns: 0 },
    });
    await drain(loopConfig);

    const tc = turnCompleteOf(events);
    expect(tc).toBeDefined();
    const counts = tc!.data.continue_counts as Record<string, number>;
    const ts = transitionsOf(events);
    for (const [k, v] of Object.entries(counts)) {
      expect(ts.filter((t) => t === k).length).toBe(v);
    }
    expect(tc!.data.max_continue_streak).toEqual({
      type: "context_window_recovery",
      length: MAX_CTX_WINDOW_RECOVERIES,
    });
    expect(tc!.data.gates_exhausted).toEqual(["context_window"]);
  });

  test("tool_use 打断游程且自身不计游程", async () => {
    const toolResp = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "/a" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    } as AccumulatedResponse;
    const { loopConfig, events } = setup({
      responses: [ctxWindow(), toolResp, toolResp, toolResp, ctxWindow(), endTurn()],
      historyPairs: 30,
    });
    await drain(loopConfig);
    const tc = turnCompleteOf(events)!;
    expect((tc.data.continue_counts as Record<string, number>).tool_use).toBe(3);
    // 两次 ctx-window 之间夹了真实工作 → 最长游程是 1，而不是 2
    expect(tc.data.max_continue_streak).toEqual({ type: "context_window_recovery", length: 1 });
  });
});

describe("CONTINUE_STREAK_CAPS 与各封顶常量逐字同源（反漂移）", () => {
  test("每个固定封顶都等于源常量", () => {
    expect(CONTINUE_STREAK_CAPS.stop_hook_retry).toBe(MAX_STOP_HOOK_RETRIES);
    expect(CONTINUE_STREAK_CAPS.todo_gate_retry).toBe(MAX_TODO_GATE_RETRIES);
    expect(CONTINUE_STREAK_CAPS.unanswered_retry).toBe(MAX_UNANSWERED_RETRIES);
    expect(CONTINUE_STREAK_CAPS.promise_nudge).toBe(MAX_PROMISE_NUDGES);
    expect(CONTINUE_STREAK_CAPS.empty_param_retry).toBe(MAX_EMPTY_PARAM_RETRIES);
    expect(CONTINUE_STREAK_CAPS.context_window_recovery).toBe(MAX_CTX_WINDOW_RECOVERIES);
  });
});

describe("digest · aggregateContinuePathStats", () => {
  test("健康会话：超封顶 0、收尾后续命 0", () => {
    const s = aggregateContinuePathStats([
      { event: "LoopTransition", data: { type: "tool_use" } },
      { event: "LoopTransition", data: { type: "todo_gate_retry" } },
      { event: "GateExhausted", data: { gate: "todo", effect: "gate_only", promptSeq: 1 } },
      { event: "LoopTransition", data: { type: "token_budget_continuation" } },
      {
        event: "TurnComplete",
        data: {
          continue_counts: { tool_use: 1, todo_gate_retry: 1, token_budget_continuation: 1 },
          max_continue_streak: { type: "todo_gate_retry", length: 1 },
          gates_exhausted: ["todo"],
        },
      },
    ])!;
    expect(s.prompts).toBe(1);
    expect(s.overCapPrompts).toBe(0);
    // 质量门耗尽后的预算续跑是设计行为，不算打穿
    expect(s.continuedAfterChainEnd).toBe(0);
    expect(s.gatesExhausted).toEqual({ todo: 1 });
  });

  test("超封顶游程与「退化门耗尽后仍续命」都会被点名", () => {
    const s = aggregateContinuePathStats([
      { event: "GateExhausted", data: { gate: "unanswered", effect: "chain_ends", promptSeq: 2 } },
      { event: "LoopTransition", data: { type: "goal_gate_retry" } },
      {
        event: "TurnComplete",
        data: {
          continue_counts: { context_window_recovery: 40, goal_gate_retry: 1 },
          max_continue_streak: { type: "context_window_recovery", length: 40 },
        },
      },
    ])!;
    expect(s.overCapPrompts).toBe(1);
    expect(s.overCap).toEqual({ context_window_recovery: 40 });
    expect(s.continuedAfterChainEnd).toBe(1);
  });

  test("老会话（无新字段、无新事件）→ null，整节不渲染", () => {
    expect(
      aggregateContinuePathStats([
        { event: "LoopTransition", data: { type: "tool_use" } },
        { event: "TurnComplete", data: { stop_reason: "end_turn" } },
      ]),
    ).toBeNull();
  });
});
