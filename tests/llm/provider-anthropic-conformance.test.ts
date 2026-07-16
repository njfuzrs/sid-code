/**
 * Anthropic Provider 端到端一致性测试 — provider-anthropic-conformance.test.ts
 *
 * 覆盖方案 §8.2 要求的 provider 全链路解析场景（raw stream 模式）：
 * - 纯文本响应正确解析
 * - tool_use 响应正确解析（含 index 不连续 / 跳跃场景）
 * - 多工具并行响应正确解析
 * - 空文本 + 纯 tool_use 不崩溃
 * - abort signal 能中断流式请求
 * - thinking 块正确透传
 * - usage 统计正确（含 cache 字段、PARSE-2 增量）
 * - guardOutgoingMessages 在发送前执行（orphan tool_use 拦截）
 *
 * 实现方式：mock SDK 的 messages.create().withResponse()，注入受控的 raw event 流。
 * 不发真实网络请求，验证 anthropic.ts 自建状态机的解析正确性。
 */

import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "../../src/llm/anthropic.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";
import { initStreamObserver, resetStreamObserver } from "../../src/trace/stream-observer.ts";

// ─── 测试脚手架 ──────────────────────────────────────────────────────────

/** 构造一个 mock raw event 的 async iterable，附带 controller（对齐 SDK Stream 形状） */
function makeRawStream(events: any[], opts: { delayMs?: number } = {}) {
  const controller = new AbortController();
  const iterable = {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (controller.signal.aborted) return;
        yield ev;
      }
    },
  };
  return iterable;
}

/**
 * 创建一个注入了 mock raw stream 的 AnthropicProvider。
 * 替换内部 client.messages.create 为返回 mock 流的函数。
 */
function makeProviderWithEvents(
  events: any[],
  opts: { delayMs?: number; responseHeaders?: Record<string, string> } = {},
): AnthropicProvider {
  const provider = new AnthropicProvider("test-key", "claude-opus-4-8");
  const rawStream = makeRawStream(events, opts);
  const response = {
    status: 200,
    headers: new Headers(opts.responseHeaders ?? {}),
    body: { cancel: () => Promise.resolve() },
  };
  (provider as any).client.messages.create = () => ({
    withResponse: async () => ({ data: rawStream, response }),
  });
  return provider;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const BASE_PARAMS: SendParams = {
  model: "claude-opus-4-8",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};

// ─── 1. 纯文本响应 ──────────────────────────────────────────────────────

describe("Anthropic conformance — 纯文本响应", () => {
  test("纯文本流正确解析为 text_delta 序列", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));

    const texts = out
      .filter((e) => e.type === "content_block_delta" && (e as any).delta.type === "text_delta")
      .map((e) => (e as any).delta.text);
    expect(texts.join("")).toBe("Hello world");

    const stop = out.find((e) => e.type === "message_delta") as any;
    expect(stop.delta.stop_reason).toBe("end_turn");
    expect(out.at(-1)!.type).toBe("message_stop");
  });
});

// ─── 2. tool_use 响应（含 index 不连续）─────────────────────────────────

describe("Anthropic conformance — tool_use 解析", () => {
  test("tool_use 的 partial_json 自管拼接 + 一次性 parse", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"/tmp/a.txt"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));

    // content_block_start 应透传 tool_use 块
    const startEv = out.find((e) => e.type === "content_block_start") as any;
    expect(startEv.content_block.type).toBe("tool_use");
    expect(startEv.content_block.name).toBe("read_file");

    // partial_json 增量应被透传（供下游 stream-processor 拼接）
    const jsonDeltas = out
      .filter((e) => e.type === "content_block_delta" && (e as any).delta.type === "input_json_delta")
      .map((e) => (e as any).delta.partial_json);
    expect(jsonDeltas.join("")).toBe('{"path":"/tmp/a.txt"}');
  });

  test("index 不连续（跳过 0 直接给 1）不崩溃，delta 引用缺失 index 被 fail-safe 跳过", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      // 直接 index=1，没有 index=0
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      // 引用一个从未 start 的 index=5 → 应被 fail-safe 跳过而非抛错
      { type: "content_block_delta", index: 5, delta: { type: "text_delta", text: "ghost" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));

    const texts = out
      .filter((e) => e.type === "content_block_delta" && (e as any).delta.type === "text_delta")
      .map((e) => (e as any).delta.text);
    // index=1 的 "ok" 被解析，index=5 的 "ghost" 被跳过
    expect(texts.join("")).toBe("ok");
    expect(out.at(-1)!.type).toBe("message_stop");
  });
});

// ─── 3. 多工具并行 ──────────────────────────────────────────────────────

describe("Anthropic conformance — 多工具并行", () => {
  test("两个并行 tool_use 块各自管理 input 拼接", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "list_dir", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"dir":"/"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));

    const starts = out.filter((e) => e.type === "content_block_start") as any[];
    expect(starts.length).toBe(2);
    expect(starts[0].content_block.name).toBe("read_file");
    expect(starts[1].content_block.name).toBe("list_dir");
    expect(starts[0].index).toBe(0);
    expect(starts[1].index).toBe(1);
  });
});

// ─── 4. 空文本 + 纯 tool_use ───────────────────────────────────────────

describe("Anthropic conformance — 边界场景", () => {
  test("空文本 + 纯 tool_use（无 text 块）不崩溃", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "noop", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));
    expect(out.find((e) => e.type === "content_block_start")).toBeDefined();
    expect(out.at(-1)!.type).toBe("message_stop");
  });

  test("tool input 非法 JSON 不崩溃（兜底空对象）", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "x", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{not valid json" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    // 不应抛错
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));
    expect(out.at(-1)!.type).toBe("message_stop");
  });
});

// ─── 5. abort 中断 ─────────────────────────────────────────────────────

describe("Anthropic conformance — abort 中断", () => {
  test("已 aborted 的 signal 让流式提前结束（抛 error 事件而非崩溃）", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" }, delayMs: 50 },
    ];
    const ctl = new AbortController();
    ctl.abort(); // 预先 abort
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS, ctl.signal));
    // signal.aborted 会在循环内抛错 → 转成 error 事件
    const err = out.find((e) => e.type === "error") as any;
    expect(err).toBeDefined();
    expect(String(err.error.message)).toContain("abort");
  });

  test("P0-2 §7.3 回归：真半开 raw stream（yield 一个事件后永不 settle、不感知 signal）→ abort 后 <2s 内退出，不 hang", async () => {
    // 区别于上面的"预先 aborted"用例：此 mock raw stream yield 一个事件后挂在一个
    // **永不 resolve、不监听 signal** 的 Promise 上（SSE 半开：TCP 在、服务端不再发 event）。
    // 若 anthropic.ts 的消费循环仍是旧 for-await（无 Promise.race(abortPromise)），
    // 流的 signal.aborted 检查永远执行不到 → hang。此处 mid-stream abort，验证 race 生效。
    let neverSettles: () => void = () => {};
    const provider = new AnthropicProvider("test-key", "claude-opus-4-8");
    const hangingRaw = {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
        // 挂起：不监听 signal、不 resolve、不 reject —— 唯一出路是消费循环外层的 abort race。
        await new Promise<void>((_resolve, _reject) => {
          neverSettles = () => { /* 有意留空：该 Promise 本就设计为永不 settle */ };
        });
        yield { type: "message_stop" };
      },
    };
    const response = { headers: new Headers(), body: { cancel: () => Promise.resolve() } };
    (provider as any).client.messages.create = () => ({
      withResponse: async () => ({ data: hangingRaw, response }),
    });

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);

    const start = Date.now();
    const out = await drain(provider.sendMessageStream(BASE_PARAMS, ctl.signal));
    const elapsed = Date.now() - start;

    // 必须远早于任何分钟级超时兜底，证明是消费循环外层 abort race 生效
    expect(elapsed).toBeLessThan(2_000);
    // abort 被转成 error 事件（sendMessageStream 的最外层 catch 语义）。
    // 消费循环的 abortPromise race 主动 reject 的是 RequestAbortedError("请求已中止（anthropic consume race）")，
    // 证明退出走的是外层 race 而非流自身感知 signal（后者文案为 "Request aborted"）。
    const err = out.find((e) => e.type === "error") as any;
    expect(err).toBeDefined();
    expect(String(err.error.message)).toContain("请求已中止");
    neverSettles(); // 语义标记：该 promise 本就设计为不 settle
  }, 10_000);
});

// ─── 6. thinking 块透传 ────────────────────────────────────────────────

describe("Anthropic conformance — thinking 透传", () => {
  test("thinking_delta 作为 text_delta 透传", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));
    const texts = out
      .filter((e) => e.type === "content_block_delta" && (e as any).delta.type === "text_delta")
      .map((e) => (e as any).delta.text);
    expect(texts.join("")).toBe("let me think");
  });
});

// ─── 7. usage 统计（PARSE-2 增量 + cache 字段）──────────────────────────

describe("Anthropic conformance — usage 统计", () => {
  test("message_start 给全量 input，message_delta 给 output 增量", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 80 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const out = await drain(provider.sendMessageStream(BASE_PARAMS));

    const startEv = out.find((e) => e.type === "message_start") as any;
    expect(startEv.message.usage.inputTokens).toBe(100);
    expect(startEv.message.usage.cacheReadInputTokens).toBe(80);

    // message_delta 只发本次 output 增量（下游累加）
    const deltaEv = out.find((e) => e.type === "message_delta") as any;
    expect(deltaEv.usage.outputTokens).toBe(42);
    expect(deltaEv.usage.inputTokens).toBe(0);
  });
});

// ─── 缺口分析补全：TTFB 可观测性（headers_received / HttpConnected）────────

describe("Anthropic conformance — TTFB 可观测性（缺口分析一类）", () => {
  test("收到响应头后 emit headers_received + HttpConnected（与 openai 同口径）", async () => {
    const captured: any[] = [];
    initStreamObserver("sess-ttfb", "/tmp", (ev) => captured.push(ev));
    try {
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ];
      const provider = makeProviderWithEvents(events, {
        responseHeaders: { "content-type": "text/event-stream" },
      });
      await drain(provider.sendMessageStream(BASE_PARAMS));

      const headersReceived = captured.find(
        (e) => e.event === "StreamPhase" && e.data?.phase === "headers_received",
      );
      expect(headersReceived).toBeDefined();
      expect(headersReceived.data.http_status).toBe(200);
      expect(headersReceived.data.content_type).toBe("text/event-stream");
      expect(typeof headersReceived.data.ttfb_ms).toBe("number");
      expect(headersReceived.data.ttfb_ms).toBeGreaterThanOrEqual(0);

      const httpConnected = captured.find((e) => e.event === "HttpConnected");
      expect(httpConnected).toBeDefined();
      expect(httpConnected.data.status).toBe(200);
    } finally {
      resetStreamObserver();
    }
  });
});

// ─── 9. 流内遥测转发（P0 接线验证）────────────────────────────────────

describe("Anthropic conformance — 流内遥测转发", () => {
  test("stream_completed 信号通过 params.onStreamTelemetry 转发出来", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const provider = makeProviderWithEvents(events);
    const signals: any[] = [];
    const params: SendParams = {
      ...BASE_PARAMS,
      onStreamTelemetry: (sig) => signals.push(sig),
    };
    await drain(provider.sendMessageStream(params));

    const completed = signals.find((s) => s.type === "stream_completed");
    expect(completed).toBeDefined();
    expect(completed.provider).toBe("anthropic");
    expect(completed.totalEvents).toBe(events.length);
  });
});


describe("Anthropic conformance — guardOutgoingMessages", () => {
  test("strict 模式下 orphan tool_result（无匹配 tool_use）在发送前被拦截抛错", async () => {
    const provider = makeProviderWithEvents([{ type: "message_stop" }]);
    const badParams: SendParams = {
      model: "claude-opus-4-8",
      maxTokens: 1024,
      messages: [
        // tool_result 引用了不存在的 tool_use_id → guardOutgoingMessages 应拦截
        { role: "user", content: [{ type: "tool_result", tool_use_id: "nonexistent", content: "x" }] },
      ],
    };
    // anthropic.ts 调用 guardOutgoingMessages 时未显式传 strict → 由环境变量决定。
    // 开启 strict 验证"发送前校验"确实在流式起步前执行（违例时抛错）。
    const prev = process.env.SID_CODE_PROTOCOL_STRICT;
    process.env.SID_CODE_PROTOCOL_STRICT = "1";
    let threw = false;
    try {
      await drain(provider.sendMessageStream(badParams));
    } catch {
      threw = true;
    } finally {
      if (prev === undefined) delete process.env.SID_CODE_PROTOCOL_STRICT;
      else process.env.SID_CODE_PROTOCOL_STRICT = prev;
    }
    // guardOutgoingMessages 在 yield 任何事件前抛出（同步校验）
    expect(threw).toBe(true);
  });

  test("非 strict 模式下 orphan tool_result 不阻断流（仅告警，向后兼容）", async () => {
    const provider = makeProviderWithEvents([{ type: "message_stop" }]);
    const badParams: SendParams = {
      model: "claude-opus-4-8",
      maxTokens: 1024,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "nonexistent", content: "x" }] },
      ],
    };
    const prev = process.env.SID_CODE_PROTOCOL_STRICT;
    delete process.env.SID_CODE_PROTOCOL_STRICT;
    let threw = false;
    try {
      const out = await drain(provider.sendMessageStream(badParams));
      expect(out.at(-1)!.type).toBe("message_stop");
    } catch {
      threw = true;
    } finally {
      if (prev !== undefined) process.env.SID_CODE_PROTOCOL_STRICT = prev;
    }
    expect(threw).toBe(false);
  });
});

// ─── tool_choice 透传（OPT-2）────────────────────────────────────────────

/**
 * 创建一个会捕获 messages.create 首个入参（即请求体）的 provider。
 * 用于断言 tool_choice / thinking 等字段是否正确下发到 Anthropic 请求。
 */
function makeCapturingProvider(): { provider: AnthropicProvider; getBody: () => any } {
  const provider = new AnthropicProvider("test-key", "claude-opus-4-8");
  let captured: any = null;
  const minimalStream = makeRawStream([
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "message_stop" },
  ]);
  const response = { headers: new Headers(), body: { cancel: () => Promise.resolve() } };
  (provider as any).client.messages.create = (body: any) => {
    captured = body;
    return { withResponse: async () => ({ data: minimalStream, response }) };
  };
  return { provider, getBody: () => captured };
}

describe("Anthropic conformance — tool_choice 透传（OPT-2）", () => {
  test('toolChoice="none" 下发 { type: "none" }（修复 auto-compact 静默丢弃）', async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({ ...BASE_PARAMS, toolChoice: "none" }));
    expect(getBody().tool_choice).toEqual({ type: "none" });
  });

  test('toolChoice="auto" 下发 { type: "auto" }', async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({ ...BASE_PARAMS, toolChoice: "auto" }));
    expect(getBody().tool_choice).toEqual({ type: "auto" });
  });

  test('toolChoice="required" 映射为 Anthropic 的 { type: "any" }（非 OpenAI 语义）', async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({ ...BASE_PARAMS, toolChoice: "required" }));
    expect(getBody().tool_choice).toEqual({ type: "any" });
  });

  test('toolChoice={ name } 下发 { type: "tool", name }', async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({ ...BASE_PARAMS, toolChoice: { name: "StructuredOutput" } }));
    expect(getBody().tool_choice).toEqual({ type: "tool", name: "StructuredOutput" });
  });

  test("不传 toolChoice 时请求体无 tool_choice 字段", async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({ ...BASE_PARAMS }));
    expect("tool_choice" in getBody()).toBe(false);
  });

  test("thinking 开启 + 强制 tool_choice({name}) → 降级为 auto（Anthropic 约束）", async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({
      ...BASE_PARAMS,
      toolChoice: { name: "StructuredOutput" },
      thinking: { enabled: true, budgetTokens: 1024 },
    }));
    expect(getBody().tool_choice).toEqual({ type: "auto" });
  });

  test('thinking 开启 + toolChoice="none" → 原样透传 none（none 在 thinking 下合法）', async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({
      ...BASE_PARAMS,
      toolChoice: "none",
      thinking: { enabled: true, budgetTokens: 1024 },
    }));
    expect(getBody().tool_choice).toEqual({ type: "none" });
  });

  test('thinking 开启 + toolChoice="required" → 降级为 auto（any 在 thinking 下会 400）', async () => {
    const { provider, getBody } = makeCapturingProvider();
    await drain(provider.sendMessageStream({
      ...BASE_PARAMS,
      toolChoice: "required",
      thinking: { enabled: true, budgetTokens: 1024 },
    }));
    expect(getBody().tool_choice).toEqual({ type: "auto" });
  });
});
