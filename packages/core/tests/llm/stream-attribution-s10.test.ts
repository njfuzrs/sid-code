/**
 * S10：收尾后分叉（fork / 子代理）的流内事件必须带来源标注。
 *
 * 被测缺陷：`TurnComplete` 后 fork 事件 56 条里 36 条无归属字段 ——
 * provider 侧 `emitStreamPhase` / `emitHttpConnected` 从不传身份，
 * 而身份其实早已在 ALS（`resilient-stream.ts` 为所有非主循环调用包了 `withRequestContext`）。
 *
 * 本文件走**真实 provider 代码路径**（mock fetch / SDK，不直接调 emit 函数），
 * 断言落盘事件的 data 字段：
 *  - 在 RequestContext 里发起的流：StreamPhase / HttpConnected 带 `agent_id` + `caller`；
 *  - 主循环（无 RequestContext）：两个字段都**不存在**（不是 undefined 值，是没有这个 key）；
 *  - 来源标注不改快照 key：provider 侧仍能用无 agentId 的 key 读到快照（watchdog 依赖它）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import {
  initStreamObserver,
  resetStreamObserver,
  getStreamSnapshot,
} from "@sid-code/core/trace/stream-observer.ts";
import { streamInRequestContext } from "@sid-code/core/llm/request-context.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const realFetch = globalThis.fetch;
let captured: Array<{ event: string; data: Record<string, unknown> }>;

beforeEach(() => {
  captured = [];
  initStreamObserver("s10-session", "/tmp/s10-session", (ev) => {
    captured.push({ event: ev.event, data: ev.data });
  });
});

afterEach(() => {
  resetStreamObserver();
  globalThis.fetch = realFetch;
});

const params: SendParams = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 64,
};

function mockOpenAiFetch(): void {
  const enc = new TextEncoder();
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
            ),
          );
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            ),
          );
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of it) {
    /* 只要副作用（落盘事件） */
  }
}

const streamEvents = () =>
  captured.filter((e) => e.event === "StreamPhase" || e.event === "HttpConnected");

describe("S10 · openai Chat Completions：流内事件来源标注", () => {
  test("fork 的流（RequestContext 内）：StreamPhase / HttpConnected 全部带 agent_id + caller", async () => {
    mockOpenAiFetch();
    const provider = new OpenAIProvider("k", "deepseek-v4-pro");
    await drain(
      streamInRequestContext(
        { turnIndex: 20_001, agentId: "fork:x", callerLabel: "agent:fork" },
        () => provider.sendMessageStream(params) as AsyncGenerator<StreamEvent>,
      ),
    );

    const evs = streamEvents();
    // 前提：provider 确实发了这些事件（否则下面的 every 在空数组上恒真）
    const phases = evs.filter((e) => e.event === "StreamPhase").map((e) => e.data.phase);
    expect(phases).toEqual(
      expect.arrayContaining(["fetch_sent", "headers_received", "sse_consuming", "completed"]),
    );
    expect(evs.some((e) => e.event === "HttpConnected")).toBe(true);
    for (const e of evs) {
      expect({ event: e.event, phase: e.data.phase, agent_id: e.data.agent_id }).toEqual({
        event: e.event,
        phase: e.data.phase,
        agent_id: "fork:x",
      });
      expect(e.data.caller).toBe("agent:fork");
      // index 用的是 RequestContext 的号段，不是主循环的轮次
      expect(e.data.index).toBe(20_001);
    }
  });

  test("来源标注不进快照 key：provider 侧无 agentId 的 key 仍能读到这条流的快照", async () => {
    mockOpenAiFetch();
    const provider = new OpenAIProvider("k", "deepseek-v4-pro");
    await drain(
      streamInRequestContext(
        { turnIndex: 20_002, agentId: "fork:y" },
        () => provider.sendMessageStream(params) as AsyncGenerator<StreamEvent>,
      ),
    );
    // 若把 agentId 当第 4 参传，快照会落在 `loop:fork:y:20002`，这里读到 undefined
    expect(getStreamSnapshot(20_002)).toBeDefined();
    expect(getStreamSnapshot(20_002, undefined, "fork:y")).toBeUndefined();
  });

  test("主循环（无 RequestContext）：事件里不出现 agent_id / caller 这两个 key", async () => {
    mockOpenAiFetch();
    const provider = new OpenAIProvider("k", "deepseek-v4-pro");
    await drain(provider.sendMessageStream(params));
    const evs = streamEvents();
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) {
      expect(Object.keys(e.data)).not.toContain("agent_id");
      expect(Object.keys(e.data)).not.toContain("caller");
    }
  });
});

describe("S10 · anthropic：流内事件来源标注", () => {
  function makeProvider(): AnthropicProvider {
    const provider = new AnthropicProvider("k", "claude-opus-4-8");
    const controller = new AbortController();
    const raw = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const rawStream = {
      controller,
      async *[Symbol.asyncIterator]() {
        for (const ev of raw) yield ev;
      },
    };
    const response = {
      status: 200,
      headers: new Headers(),
      body: { cancel: () => Promise.resolve() },
    };
    (provider as any).client.messages.create = () => ({
      withResponse: async () => ({ data: rawStream, response }),
    });
    return provider;
  }

  const aParams: SendParams = { ...params, model: "claude-opus-4-8" };

  test("子代理的流：headers_received / first_content / HttpConnected 带 agent_id", async () => {
    await drain(
      streamInRequestContext(
        { turnIndex: 10_003, agentId: "sess-sub-t1", callerLabel: "agent:builtin" },
        () => makeProvider().sendMessageStream(aParams) as AsyncGenerator<StreamEvent>,
      ),
    );
    const evs = streamEvents();
    const phases = evs.filter((e) => e.event === "StreamPhase").map((e) => e.data.phase);
    expect(phases).toEqual(expect.arrayContaining(["headers_received", "first_content"]));
    expect(evs.some((e) => e.event === "HttpConnected")).toBe(true);
    for (const e of evs) {
      expect(e.data.agent_id).toBe("sess-sub-t1");
      expect(e.data.caller).toBe("agent:builtin");
    }
  });

  test("主循环：不出现 agent_id / caller", async () => {
    await drain(makeProvider().sendMessageStream(aParams));
    const evs = streamEvents();
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) {
      expect(Object.keys(e.data)).not.toContain("agent_id");
      expect(Object.keys(e.data)).not.toContain("caller");
    }
  });
});
