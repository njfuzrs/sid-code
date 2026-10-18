/**
 * 遗留清单 R1 / R5 / R6 / R10：思考观测字段从 provider 真实出口落进 BilledRequest。
 *
 * 只测 digest 纯函数会漏掉「provider 没接上」这一类死接线（R5 修前 Responses 两条路径正是这样：
 * digest 写对了，但它们根本不带 thinking_wire，整段静默缺席）。所以这里走真实 provider 代码
 * （mock fetch / SDK），断言观察者收到的 BilledRequest。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import {
  addBillingObserver,
  resetBillingSink,
  type BilledRequest,
} from "@sid-code/core/llm/billing-sink.ts";
import { wireThinks } from "@sid-code/core/llm/thinking-observation.ts";
import { SIDE_CALL_NO_THINK } from "@sid-code/core/llm/side-call-timeout.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const origFetch = globalThis.fetch;
const origProto = process.env.SID_CODE_OPENAI_PROTOCOL;
let billed: BilledRequest[];

beforeEach(() => {
  resetBillingSink();
  billed = [];
  addBillingObserver((r) => billed.push(r));
});
afterEach(() => {
  globalThis.fetch = origFetch;
  if (origProto === undefined) delete process.env.SID_CODE_OPENAI_PROTOCOL;
  else process.env.SID_CODE_OPENAI_PROTOCOL = origProto;
  resetBillingSink();
});

const base = (over: Partial<SendParams>): SendParams => ({
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 64,
  ...over,
});

async function drain(it: AsyncIterable<StreamEvent>) {
  for await (const _ of it) {
    /* 只要副作用 */
  }
}

function sseResponse(lines: unknown[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(enc.encode(`data: ${JSON.stringify(l)}\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const responsesUsage = {
  input_tokens: 10,
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 3 },
};

describe("R5：Responses API 两条路径带思考埋点", () => {
  test("流式：thinking_wire=omitted、control=none、reasoning token>0 记为思考", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
    globalThis.fetch = (async () =>
      sseResponse([
        { type: "response.created", response: { id: "r" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: responsesUsage } },
      ])) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "gpt-5.6", "https://example.invalid/v1");
    await drain(
      p.sendMessageStream(base({ model: "gpt-5.6", thinking: { ...SIDE_CALL_NO_THINK } })),
    );
    expect(billed).toHaveLength(1);
    expect(billed[0]!.thinkingWire).toBe("omitted");
    expect(billed[0]!.thinkingInResponse).toBe(true);
    expect(billed[0]!.thinkingSetting).toBe("off");
    expect(billed[0]!.thinkingControl).toBe("none");
  });

  test("非流式：同口径", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "gpt-5.6", "https://example.invalid/v1");
    await p.sendMessageNonStreaming(
      base({ model: "gpt-5.6", thinking: { ...SIDE_CALL_NO_THINK } }),
    );
    expect(billed).toHaveLength(1);
    expect(billed[0]!.thinkingWire).toBe("omitted");
    expect(billed[0]!.thinkingInResponse).toBe(false);
    expect(billed[0]!.thinkingSetting).toBe("off");
    expect(billed[0]!.thinkingControl).toBe("none");
  });
});

describe("R1：OpenAI 族恒思考的 off 落 control=locked-on（不再被 digest 当成泄漏）", () => {
  test("GLM-5.3 Chat Completions 流式：线上 omitted + control locked-on", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "chat";
    let body: any;
    globalThis.fetch = (async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return sseResponse([
        { id: "x", choices: [{ index: 0, delta: { reasoning_content: "想" } }] },
        { id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "glm-5.3", "https://example.invalid/v1");
    await drain(
      p.sendMessageStream(base({ model: "glm-5.3", thinking: { ...SIDE_CALL_NO_THINK } })),
    );
    expect(body.thinking).toBeUndefined();
    expect(billed[0]!.thinkingWire).toBe("omitted");
    expect(billed[0]!.thinkingControl).toBe("locked-on");
    expect(billed[0]!.thinkingInResponse).toBe(true);
  });
});

describe("Anthropic：观测字段与 R10 展示/实发", () => {
  function provider(model: string) {
    const p = new AnthropicProvider("k", model, "https://gw.example.com");
    (p as any).client.messages.create = () => ({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return p;
  }

  test("主循环写的 thinkingObservation 原样落盘；Sonnet 5 off → disabled，实发不思考", async () => {
    await provider("claude-sonnet-5").sendMessageNonStreaming(
      base({
        model: "claude-sonnet-5",
        thinking: { enabled: false, budgetTokens: 0 },
        thinkingIntent: { thinking: false },
        thinkingObservation: { setting: "off", control: "toggle", shown: false },
      }),
    );
    expect(billed[0]).toMatchObject({
      thinkingWire: "disabled",
      thinkingSetting: "off",
      thinkingControl: "toggle",
      thinkingShown: false,
      thinkingWireThinks: false,
    });
  });

  test("side-call 不经 loop：control / shown 按真名现算；auto 不会被写成 off", async () => {
    await provider("claude-opus-5-5").sendMessageNonStreaming(
      base({ model: "claude-opus-5-5", thinking: { ...SIDE_CALL_NO_THINK } }),
    );
    expect(billed[0]).toMatchObject({
      thinkingSetting: "off",
      thinkingControl: "locked-on",
      thinkingShown: true,
    });
    billed.length = 0;
    // 调用方完全没表达意图 → setting 缺省（不推断成 auto，也不推断成 off）
    await provider("claude-sonnet-5").sendMessageNonStreaming(base({ model: "claude-sonnet-5" }));
    expect(billed[0]!.thinkingSetting).toBeUndefined();
    expect(billed[0]!.thinkingControl).toBe("toggle");
  });
});

describe("wireThinks（R10 判定，与 thinking-state 不变量测试同一份）", () => {
  test("disabled 否；enabled/adaptive 是；omitted 看 locked-on / omitMeans，给不出就 undefined", () => {
    expect(wireThinks("disabled", "toggle", "on")).toBe(false);
    expect(wireThinks("adaptive", "toggle", "off")).toBe(true);
    expect(wireThinks("omitted", "locked-on", undefined)).toBe(true);
    expect(wireThinks("omitted", "toggle", "on")).toBe(true);
    expect(wireThinks("omitted", "toggle", "off")).toBe(false);
    expect(wireThinks("omitted", "toggle", undefined)).toBeUndefined();
  });
});

/**
 * E9（20261018 effort 排查 PR-A）：线上实发 effort 档位进 BilledRequest.effortWire。
 * 判据是「与最终请求体一致」，不是「与 params 一致」——关思考的 dropEffort、能力门控都会让两者分叉。
 */
describe("E9：effortWire 记的是线上实发档", () => {
  function anthropicCapture(model: string) {
    const bodies: any[] = [];
    const p = new AnthropicProvider("k", model, "https://gw.example.com");
    (p as any).client.messages.create = (body: any) => {
      bodies.push(body);
      return {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    return { p, bodies };
  }

  test("Anthropic 开思考：output_config.effort 原样落盘", async () => {
    const { p, bodies } = anthropicCapture("claude-opus-5");
    await p.sendMessageNonStreaming(
      base({
        model: "claude-opus-5",
        thinking: { enabled: true, budgetTokens: 0 },
        outputConfig: { effort: "high" },
      }),
    );
    expect(bodies[0].output_config?.effort).toBe("high");
    expect(billed[0]!.effortWire).toBe("high");
  });

  test("Anthropic 关思考（disabled 吞掉 effort）：params 有 effort，线上没发 → omitted", async () => {
    const { p, bodies } = anthropicCapture("claude-sonnet-5");
    await p.sendMessageNonStreaming(
      base({
        model: "claude-sonnet-5",
        thinking: { enabled: false, budgetTokens: 0 },
        outputConfig: { effort: "high" },
      }),
    );
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[0].output_config).toBeUndefined();
    expect(billed[0]!.effortWire).toBe("omitted");
  });

  test("Chat Completions 流式：读请求体的 reasoning_effort", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "chat";
    let body: any;
    globalThis.fetch = (async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return sseResponse([
        { id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "deepseek-v4-pro", "https://example.invalid/v1");
    await drain(
      p.sendMessageStream(
        base({
          model: "deepseek-v4-pro",
          thinking: { enabled: true, budgetTokens: 0 },
          reasoningEffort: "max",
        }),
      ),
    );
    expect(body.reasoning_effort).toBe("max");
    expect(billed[0]!.effortWire).toBe("max");
  });

  test("Chat Completions 没发 effort → omitted（不是缺省）", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "chat";
    let body: any;
    globalThis.fetch = (async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return sseResponse([
        { id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "kimi-k3", "https://example.invalid/v1");
    await drain(p.sendMessageStream(base({ model: "kimi-k3" })));
    expect(body.reasoning_effort).toBeUndefined();
    expect(billed[0]!.effortWire).toBe("omitted");
  });

  test("Responses 流式：读嵌套 reasoning.effort", async () => {
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
    let body: any;
    globalThis.fetch = (async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return sseResponse([
        { type: "response.created", response: { id: "r" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: responsesUsage } },
      ]);
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "gpt-5.6", "https://example.invalid/v1");
    await drain(p.sendMessageStream(base({ model: "gpt-5.6", reasoningEffort: "xhigh" })));
    expect(body.reasoning?.effort).toBe("xhigh");
    expect(billed[0]!.effortWire).toBe("xhigh");
  });
});
