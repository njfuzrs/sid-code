/**
 * Agentic Loop P1 闸门集成：forceStop 真停、unanswered 耗尽不被后续门打穿、
 * max_tokens 带完整 tool_use 必须执行、最后一轮 return 仍发 TurnComplete。
 *
 * 对应缺陷文档 P1-1 / P1-3 / P1-4 / P1-6。mock 套路沿用 unanswered-end-turn-loop /
 * turn-complete-e2e。
 */
import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { MAX_UNANSWERED_RETRIES } from "@sid-code/core/query/todo-reminder.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 20,
    maxTokens: 128000,
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

function unansweredResp(round: number): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: `思考发散 round ${round} `.repeat(60) }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 0 },
    _unansweredEndTurn: true,
  } as AccumulatedResponse;
}

function endTurnResp(text = "做完了"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

function toolUseAtMaxTokens(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "我来写文件" },
      {
        type: "tool_use",
        id: "call-write",
        name: "write",
        input: { file_path: "/tmp/a.ts", content: "export const x = 1;" },
      },
    ],
    stopReason: "max_tokens",
    usage: { inputTokens: 100, outputTokens: 8000 },
  } as AccumulatedResponse;
}

interface CapturedEvent {
  event: string;
  data: Record<string, unknown>;
}

function setup(opts: {
  responses: AccumulatedResponse[];
  depsOverrides?: Partial<QueryDeps>;
  configOverrides?: Partial<Config>;
  userText?: string;
  hookSystem?: QueryLoopConfig["hookSystem"];
}) {
  const events: CapturedEvent[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({
    role: "user",
    content: [{ type: "text", text: opts.userText ?? "请完成任务" }],
  });

  let call = 0;
  const executed: Array<{ id: string; name: string }> = [];
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = opts.responses[call] ?? endTurnResp();
      call++;
      return r;
    },
    executeTools: async (content) => {
      const tools = content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      for (const t of tools) executed.push({ id: t.id, name: t.name });
      return {
        results: tools.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: "ok",
        })),
      };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
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
    sessionState: new SessionState("test-p1-gates"),
    fallback: new ModelFallback(),
    deps,
    ...(opts.hookSystem ? { hookSystem: opts.hookSystem } : {}),
  };
  return { loopConfig, events, ctxMgr, executed };
}

async function drain(loopConfig: QueryLoopConfig) {
  const kinds: string[] = [];
  const systemTexts: string[] = [];
  for await (const ev of queryLoop(loopConfig)) {
    kinds.push(ev.kind);
    if (ev.kind === "system" && "text" in ev) systemTexts.push((ev as { text: string }).text);
  }
  return { kinds, systemTexts };
}

describe("P1-1 · forceStop 必须立刻收尾", () => {
  test("Stop Hook preventContinuation 后 Goal Gate 不得续命", async () => {
    const goal = createGoal("必须修完所有测试", { maxTurns: 150 });
    const fireStopCalls: number[] = [];
    const hookSystem = new Proxy(
      {
        fireStopEvent: async () => {
          fireStopCalls.push(1);
          return {
            finalOutput: {
              shouldStopExecution: () => true,
              isBlockingDecision: () => false,
              getEffectiveReason: () => "",
            },
            allOutputs: [{ continue: false, stopReason: "preventContinuation" }],
          };
        },
      } as Record<string, unknown>,
      {
        get: (target, prop: string) =>
          prop in target ? target[prop] : async () => ({}) as unknown,
      },
    );

    const { loopConfig, events } = setup({
      responses: Array.from({ length: 10 }, () => endTurnResp("看起来做完了")),
      configOverrides: { maxTurns: 10 },
      hookSystem: hookSystem as unknown as QueryLoopConfig["hookSystem"],
      depsOverrides: {
        getGoalState: () => goal,
        updateGoalState: (fn) => fn(goal),
        getProviderForModel: () => {
          throw new Error("Goal 评估器不该被调用：forceStop / unanswered 耗尽必须先收尾");
        },
      },
    });

    const { kinds } = await drain(loopConfig);

    expect(kinds.filter((k) => k === "done").length).toBe(1);
    expect(fireStopCalls.length).toBe(1);
    // Goal 默认前 2 轮跳过评估并 continue；forceStop 必须在那之前 return。
    expect(
      events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type),
    ).not.toContain("goal_gate_retry");
    const tcs = events.filter((e) => e.event === "TurnComplete");
    expect(tcs.length).toBe(1);
    expect(tcs[0].data.stop_reason).toBe("other");
  });
});

describe("P1-3 · unanswered 耗尽后不得被 Goal / Token Budget 打穿", () => {
  test("有活跃 Goal 时耗尽仍直接 done，不发 goal_gate_retry", async () => {
    const goal = createGoal("审计这个仓库", { maxTurns: 150 });
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 12 }, (_, i) => unansweredResp(i)),
      configOverrides: { maxTurns: 15 },
      depsOverrides: {
        getGoalState: () => goal,
        updateGoalState: (fn) => fn(goal),
        getProviderForModel: () => {
          throw new Error("Goal 评估器不该被调用：forceStop / unanswered 耗尽必须先收尾");
        },
      },
    });

    const { kinds, systemTexts } = await drain(loopConfig);

    expect(systemTexts.filter((t) => t.includes("自动引导重新推进")).length).toBe(
      MAX_UNANSWERED_RETRIES,
    );
    expect(systemTexts.some((t) => t.includes("未产出有效答复") && t.includes("切换模型"))).toBe(
      true,
    );
    expect(kinds.filter((k) => k === "done").length).toBe(1);
    expect(
      events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type),
    ).not.toContain("goal_gate_retry");
    // 2 次续命 + 1 次耗尽收尾 = 3 轮，绝不是跑满 maxTurns
    expect(kinds.filter((k) => k === "assistant_message").length).toBe(MAX_UNANSWERED_RETRIES + 1);
  });

  test("用户消息带 +500k 时耗尽仍直接 done，不发 token_budget_continuation", async () => {
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 12 }, (_, i) => unansweredResp(i)),
      configOverrides: { maxTurns: 15 },
      userText: "请深入审计 +500k",
    });

    const { kinds, systemTexts } = await drain(loopConfig);

    expect(systemTexts.some((t) => t.includes("未产出有效答复"))).toBe(true);
    expect(kinds).toContain("done");
    expect(
      events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type),
    ).not.toContain("token_budget_continuation");
  });
});

describe("P1-4 · max_tokens 带完整 tool_use 必须执行", () => {
  test("非空参数的 write 在 max_tokens 下仍走 executeTools，不注入续写提示", async () => {
    const { loopConfig, executed, ctxMgr } = setup({
      responses: [toolUseAtMaxTokens(), endTurnResp("文件已写")],
      configOverrides: { maxTokens: 128000 },
    });

    const { kinds } = await drain(loopConfig);

    expect(executed).toEqual([{ id: "call-write", name: "write" }]);
    expect(kinds).toContain("done");

    const clipMessages = ctxMgr
      .getMessages()
      .filter(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) =>
              b.type === "text" && typeof b.text === "string" && b.text.includes("不要道歉"),
          ),
      );
    expect(clipMessages.length).toBe(0);
  });
});

describe("P1-6 · 最后一轮 return 仍发 TurnComplete", () => {
  test("maxTurns=1 且首轮 end_turn → 发事件且不跑强制总结", async () => {
    let processCalls = 0;
    const { loopConfig, events } = setup({
      responses: [endTurnResp("一轮做完")],
      configOverrides: { maxTurns: 1 },
      depsOverrides: {
        processStream: async () => {
          processCalls++;
          return endTurnResp("一轮做完");
        },
      },
    });

    await drain(loopConfig);

    // 旧判据只看 turnCount>=maxTurns，finally 以为总结还在而跳过 TurnComplete。
    // 强制总结会再调一次 processStream。
    expect(processCalls).toBe(1);
    const tcs = events.filter((e) => e.event === "TurnComplete");
    expect(tcs.length).toBe(1);
    expect(tcs[0].data.stop_reason).toBe("end_turn");
  });
});
