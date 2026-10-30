/**
 * continue 路径接线回归：stop_hook_retry / loop_recovery（2026-10-30）
 *
 * AgenticLoop 防线治理 T2 分诊发现：17 种 ContinueReason 里只有这两条**没有任何驱动真实
 * `queryLoop` 的测试**——`stop-hooks.test.ts` 只测 `handleStopHooks` 本身，
 * `loop-detection.test.ts` 只测检测器类。两者在本地轨迹里都是零触发（未配 Stop hook /
 * 循环检测默认关），零触发 + 无端到端测试 = 接线断了也不会有任何信号。
 * 这里驱动真实主循环，断言 `LoopTransition` 落了对应 type。
 */
import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { MAX_STOP_HOOK_RETRIES } from "@sid-code/core/query/stop-hooks.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 20,
    maxTokens: 8000,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

const endTurn = (text = "做完了"): AccumulatedResponse =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  }) as AccumulatedResponse;

/** 参数完全相同的一次 bash 调用：连续 3 次即命中 toolCallThreshold */
const sameBash = (i: number): AccumulatedResponse =>
  ({
    role: "assistant",
    content: [{ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: "ls" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  }) as AccumulatedResponse;

interface Captured {
  event: string;
  data: Record<string, unknown>;
}

/** 只实现 fireStopEvent 的假 HookSystem，其余 fire* 一律返回空结果 */
function stopHookSystem(decide: (call: number) => "block" | "pass") {
  let calls = 0;
  const hs = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        if (prop === "fireStopEvent") {
          return async () => {
            calls++;
            return decide(calls) === "block"
              ? { allOutputs: [{ decision: "block", reason: "单测未通过" }] }
              : { allOutputs: [] };
          };
        }
        return async () => ({ allOutputs: [] });
      },
    },
  );
  return { hookSystem: hs as unknown as QueryLoopConfig["hookSystem"], calls: () => calls };
}

function setup(opts: {
  responses: AccumulatedResponse[];
  hookSystem?: QueryLoopConfig["hookSystem"];
}) {
  const events: Captured[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请完成" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => opts.responses[call++] ?? endTurn(),
    // 每个 tool_use 回一个 tool_result，保持协议配对
    executeTools: async (content) => ({
      results: content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev) => {
      events.push({ event: ev.event, data: (ev.data ?? {}) as Record<string, unknown> });
    },
  };
  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-continue-wiring"),
    fallback: new ModelFallback(),
    deps,
    ...(opts.hookSystem ? { hookSystem: opts.hookSystem } : {}),
  };
  return { loopConfig, events, ctxMgr };
}

async function drain(loopConfig: QueryLoopConfig): Promise<string[]> {
  const kinds: string[] = [];
  for await (const ev of queryLoop(loopConfig)) kinds.push(ev.kind);
  return kinds;
}

const transitionsOf = (events: Captured[]) =>
  events.filter((e) => e.event === "LoopTransition").map((e) => String(e.data.type));

/** 循环检测在 LoopDetector 构造时读 env；存/恢复原值，不无条件 delete（同批文件共用进程） */
async function withLoopDetection<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SID_ENABLE_LOOP_DETECTION;
  if (value === undefined) delete process.env.SID_ENABLE_LOOP_DETECTION;
  else process.env.SID_ENABLE_LOOP_DETECTION = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SID_ENABLE_LOOP_DETECTION;
    else process.env.SID_ENABLE_LOOP_DETECTION = prev;
  }
}

describe("stop_hook_retry 接线", () => {
  test("Stop hook block 一次 → 续跑一轮并落 LoopTransition，第二次放行后收尾", async () => {
    const { hookSystem, calls } = stopHookSystem((n) => (n === 1 ? "block" : "pass"));
    const { loopConfig, events, ctxMgr } = setup({
      responses: [endTurn("改好了"), endTurn("这次真改好了")],
      hookSystem,
    });

    const kinds = await drain(loopConfig);

    expect(calls()).toBe(2);
    expect(transitionsOf(events)).toEqual(["stop_hook_retry"]);
    expect(kinds.filter((k) => k === "done").length).toBe(1);
    // 失败原因必须回注给模型，否则「续跑」只是让模型原样再说一遍
    const injected = JSON.stringify(ctxMgr.getMessages());
    expect(injected).toContain("单测未通过");
    const tc = events.find((e) => e.event === "TurnComplete")!.data;
    expect((tc.continue_counts as Record<string, number>).stop_hook_retry).toBe(1);
  });

  test("Stop hook 一直 block → 恰好续跑 MAX_STOP_HOOK_RETRIES 次，落 GateExhausted(stop_hook)", async () => {
    const { hookSystem } = stopHookSystem(() => "block");
    const { loopConfig, events } = setup({ responses: [], hookSystem });

    await drain(loopConfig);

    const retries = transitionsOf(events).filter((t) => t === "stop_hook_retry");
    expect(retries.length).toBe(MAX_STOP_HOOK_RETRIES);
    const exhausted = events.filter((e) => e.event === "GateExhausted");
    expect(exhausted.map((e) => e.data.gate)).toEqual(["stop_hook"]);
    expect(exhausted[0]!.data.effect).toBe("gate_only");
  });

  test("没有 hookSystem → 不走 Stop hook 分支（本地零触发的正常形态）", async () => {
    const { loopConfig, events } = setup({ responses: [endTurn()] });
    await drain(loopConfig);
    expect(transitionsOf(events)).not.toContain("stop_hook_retry");
  });
});

describe("loop_recovery 接线", () => {
  const fourSameCalls = () => [sameBash(1), sameBash(2), sameBash(3), sameBash(4), endTurn()];

  test("SID_ENABLE_LOOP_DETECTION=1：连续 3 次相同调用 → 落 loop_recovery", async () => {
    const events = await withLoopDetection("1", async () => {
      const s = setup({ responses: fourSameCalls() });
      await drain(s.loopConfig);
      return s.events;
    });
    const types = transitionsOf(events);
    expect(types).toContain("loop_recovery");
    // 前两次是正常 tool_use，第 3 次相同调用才判循环
    expect(types.slice(0, 3)).toEqual(["tool_use", "tool_use", "loop_recovery"]);
  });

  test("默认（未设 env）：同样输入不触发，全部按 tool_use 续跑", async () => {
    const events = await withLoopDetection(undefined, async () => {
      const s = setup({ responses: fourSameCalls() });
      await drain(s.loopConfig);
      return s.events;
    });
    const types = transitionsOf(events);
    expect(types).not.toContain("loop_recovery");
    expect(types).toEqual(["tool_use", "tool_use", "tool_use", "tool_use"]);
  });
});
