/**
 * 多 Provider 层审计（顺着 sc-21 核出的缺陷）D4–D7 / D9 回归。
 *
 * 每条都锁**行为**（喂生产函数、看产出），不锁实现形态：
 *   D4  Responses `response.failed` 读 usage，且仍以 error 收尾（不伪装成 end_turn）
 *   D5  跨族降级后 usage 的 provider 身份随事件走，主循环按它归一化
 *   D6  按名推 provider 只有一份实现：配置 > 真名锚定；事件自带 provider 优先
 *   D7  compat `thinkingAlwaysOn` 对未注册的改名模型可达
 *   D9  非流式 Responses 返回 failed 时计费收口拿到的是真实 usage，不是 0
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseResponsesStream } from "@sid-code/core/llm/openai-responses.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { setModelCompat, resetModelCompat } from "@sid-code/core/llm/model-compat.ts";
import { inferProviderByModelName } from "@sid-code/core/llm/provider-infer.ts";
import { inferPricingProvider } from "@sid-code/core/api/cost-tracker.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  createProviderResolver,
  resolveEventProvider,
  inferProviderFromModel,
} from "@sid-code/core/trace/provider-resolver.ts";
import { aggregateProviderStats } from "@sid-code/core/trace/digest.ts";
import {
  addBillingObserver,
  resetBillingSink,
  type BilledRequest,
} from "@sid-code/core/llm/billing-sink.ts";
import {
  normalizeCacheUsage,
  type SendParams,
  type StreamEvent,
} from "@sid-code/core/llm/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

const terminalUsage = {
  input_tokens: 5000,
  output_tokens: 200,
  input_tokens_details: { cached_tokens: 4000 },
  output_tokens_details: { reasoning_tokens: 150 },
};

describe("D4：response.failed 读 usage", () => {
  test("failed 终态产出带 usage 的 message_delta，且仍以 error 收尾", async () => {
    const payload = {
      type: "response.failed",
      response: { id: "r", status: "failed", usage: terminalUsage },
      error: { message: "server_error" },
    };
    const events: StreamEvent[] = [];
    for await (const e of parseResponsesStream(
      sse([`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`]),
    )) {
      events.push(e);
    }
    const delta = events.find((e) => e.type === "message_delta") as any;
    expect(delta).toBeDefined();
    expect(delta.usage.inputTokens).toBe(5000);
    expect(delta.usage.outputTokens).toBe(200);
    expect(delta.usage.cacheReadInputTokens).toBe(4000);
    // 不能把真失败伪装成正常结束
    expect(delta.delta.stop_reason).toBeNull();
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
    expect(events[events.length - 1]!.type).toBe("error");
  });

  test("failed 不带 usage 时行为与修前一致（只发 error）", async () => {
    const payload = { type: "response.failed", response: { status: "failed" } };
    const events: StreamEvent[] = [];
    for await (const e of parseResponsesStream(
      sse([`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`]),
    )) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });
});

/** 只吐 error 的 provider（让漏斗走到 fallback） */
function failingProvider(name: string): Provider {
  return {
    name: () => name,
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "error", error: { message: "401 Unauthorized" } };
    },
  };
}

/** Anthropic 口径的 usage：input 是未命中余量（50），命中 9500 */
function anthropicLikeProvider(): Provider {
  return {
    name: () => "anthropic",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        message: {
          usage: { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 9500 },
        },
      };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 5 },
      };
      yield { type: "message_stop" };
    },
  };
}

const params: SendParams = {
  model: "primary-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 64,
};

describe("D5：跨族降级后 usage 的 provider 身份随数据走", () => {
  test("主 openai 降级到 anthropic：response.usageProvider = anthropic，promptTotal 按 anthropic 口径", async () => {
    const fb = new ModelFallback({
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
      fallbackProvider: anthropicLikeProvider(),
      fallbackModel: "fallback-claude",
    });
    const response = await processStream(fb.executeWithFallback(failingProvider("openai"), params));
    expect(response.usageProvider).toBe("anthropic");
    // 用身份归一化：50 + 9500 = 9550（修前用 config.provider=openai ⇒ 50，差 191 倍）
    const right = normalizeCacheUsage(response.usage, response.usageProvider!);
    const wrong = normalizeCacheUsage(response.usage, "openai");
    expect(right.promptTotal).toBe(9550);
    expect(wrong.promptTotal).toBe(50);
  });

  test("provider 没实现 name()（测试替身 / 插件）时不盖章、不抛错", async () => {
    const { name: _drop, ...noName } = anthropicLikeProvider();
    const fb = new ModelFallback({ retryBackoffBaseMs: 0, retryBackoffMaxMs: 0 });
    const response = await processStream(
      fb.executeWithFallback(noName as unknown as Provider, params),
    );
    expect(response.usageProvider).toBeUndefined();
    expect(response.usage.cacheReadInputTokens).toBe(9500);
  });

  test("未降级：身份就是主 provider", async () => {
    const fb = new ModelFallback({ retryBackoffBaseMs: 0, retryBackoffMaxMs: 0 });
    const response = await processStream(fb.executeWithFallback(anthropicLikeProvider(), params));
    expect(response.usageProvider).toBe("anthropic");
  });
});

describe("D6：按名推 provider 收口为一份", () => {
  const models = [
    { name: "gw-fast", modelId: "claude-sonnet-5" },
    { name: "gw-explicit", modelId: "whatever", provider: "anthropic" },
  ];

  test("计费两份入口与兜底函数在两组反例上给出同一答案", () => {
    const cases: Array<[string, string]> = [
      ["claude-sonnet-5", "anthropic"],
      ["gw-fast", "anthropic"], // 别名不含 claude，靠真名
      ["gw-explicit", "anthropic"], // 配置 provider 优先
      ["my-claude-clone-v2", "openai"], // 第三方模型不被 /claude/i 误伤
      ["deepseek-v4", "openai"],
    ];
    for (const [m, want] of cases) {
      expect(inferProviderByModelName(m, models)).toBe(want);
      expect(inferPricingProvider(m, models)).toBe(want);
      expect(SessionState.inferProvider(m, models)).toBe(want);
    }
  });

  test("可观测侧兜底不再用不锚定的 /claude/i", () => {
    expect(inferProviderFromModel("my-claude-clone-v2")).toBe("openai");
    expect(inferProviderFromModel("claude-opus-5")).toBe("anthropic");
    expect(inferProviderFromModel("")).toBe("unknown");
  });

  test("事件自带 provider 优先于按名推断", () => {
    const resolve = createProviderResolver([]);
    expect(resolveEventProvider({ model: "gw-fast", provider: "anthropic" }, resolve)).toBe(
      "anthropic",
    );
    // 老轨迹（无 provider）回落 resolver
    expect(resolveEventProvider({ model: "glm-5.3" }, resolve)).toBe("openai");
    expect(resolveEventProvider({}, resolve)).toBe("unknown");
  });

  test("digest：带 provider 的 TimeoutFired 落进它自己的桶，而不是按名猜", () => {
    const stats = aggregateProviderStats([
      {
        event: "TimeoutFired",
        data: { index: 1, layer: "idle_timeout", model: "gw-fast", provider: "anthropic" },
      },
    ]);
    const byName = Object.fromEntries(stats.map((s: any) => [s.provider, s]));
    expect(byName.anthropic?.timedOut).toBe(1);
    expect(byName.openai).toBeUndefined();
  });

  test("provider 内的 TimeoutFired / first_content emit 点都带 provider 字段", () => {
    // 结构断言：防止新增 emit 点又漏掉身份（漏了就退回按名猜）
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    for (const f of ["openai.ts", "anthropic.ts"]) {
      const src = readFileSync(`${import.meta.dir}/../../src/llm/${f}`, "utf-8");
      const calls = src.split(/emitTimeoutFired\(|"first_content", \{/).slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.slice(0, 400)).toContain("provider: this.name()");
    }
  });
});

describe("D7：thinkingAlwaysOn 对改名模型可达", () => {
  afterEach(() => resetModelCompat());

  function wireBody(model: string, thinking: SendParams["thinking"]): any {
    const p = new OpenAIProvider("k", model, "https://gw.example.invalid/v1");
    const body: any = {};
    (p as any).applyDeepSeekThinking(body, { model, thinking }, model);
    return body;
  }

  test("改名模型（未知族）声明 thinkingAlwaysOn：关思考 → 不下发；开思考 → enabled", () => {
    setModelCompat([{ name: "corp-glm-alias", compat: { thinkingAlwaysOn: true } }]);
    expect(wireBody("corp-glm-alias", { enabled: false } as any).thinking).toBeUndefined();
    expect(wireBody("corp-glm-alias", { enabled: true } as any).thinking).toEqual({
      type: "enabled",
    });
  });

  test("supportsThinkingToggle:true 声明让未知族下发 type-enum 开关", () => {
    setModelCompat([{ name: "corp-reasoner", compat: { supportsThinkingToggle: true } }]);
    expect(wireBody("corp-reasoner", { enabled: false } as any).thinking).toEqual({
      type: "disabled",
    });
  });

  test("无声明的未知族照旧不发 thinking（不推翻「不猜结构」的论证）", () => {
    expect(wireBody("corp-glm-alias", { enabled: true } as any).thinking).toBeUndefined();
  });
});

describe("D9：非流式 Responses 返回 failed 时计费拿到真实 usage", () => {
  const origFetch = globalThis.fetch;
  const origEnv = process.env.SID_CODE_OPENAI_PROTOCOL;
  let billed: BilledRequest[];

  beforeEach(() => {
    resetBillingSink();
    billed = [];
    addBillingObserver((r) => billed.push(r));
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origEnv === undefined) delete process.env.SID_CODE_OPENAI_PROTOCOL;
    else process.env.SID_CODE_OPENAI_PROTOCOL = origEnv;
    resetBillingSink();
  });

  test("status=failed 仍抛错，但 BilledRequest 带 5000 input", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "failed",
          error: { message: "boom" },
          output: [],
          usage: terminalUsage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const p = new OpenAIProvider("k", "gpt-5.5", "https://example.invalid/v1");
    await expect(p.sendMessageNonStreaming({ ...params, model: "gpt-5.5" })).rejects.toThrow(
      /failed/,
    );
    expect(billed).toHaveLength(1);
    expect(billed[0]!.usage.inputTokens).toBe(5000);
  });
});
