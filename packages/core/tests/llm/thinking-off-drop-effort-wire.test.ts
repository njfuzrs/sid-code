/**
 * 遗留清单 R2：「发 disabled 时剥 effort」必须在**实际请求体**上锁住，不能只测 `dropEffort` 标志位。
 *
 * Opus 5 上 `thinking:{type:"disabled"}` + `output_config.effort:"max"` 实测 400（原方案 §4.5 / §8.11）。
 * `buildThinkingWire` 只返回标志，真正拼请求体的是 anthropic.ts 流式 / 非流式两处调用点；
 * 修前把任一处改回无条件带 effort，`thinking-off-wire.test.ts` 仍全绿。
 * 这里 mock `client.messages.create` 捕获实发 body，两条路径各一条。
 */

import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

function streamResult() {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return {
    data: {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev;
      },
    },
    response: { status: 200, headers: new Headers(), body: { cancel: async () => {} } },
  };
}

function capture(model: string) {
  const provider = new AnthropicProvider("k", model, "https://gw.example.com");
  const bodies: any[] = [];
  (provider as any).client.messages.create = (body: any) => {
    bodies.push(body);
    if (body.stream) return { withResponse: async () => streamResult() };
    return Promise.resolve({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {},
    });
  };
  return { provider, bodies };
}

/** off + 残留 effort max：fallback / 调用方残留字段的真实形态 */
const offWithMaxEffort = (model: string): SendParams => ({
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 16,
  thinking: { enabled: false, budgetTokens: 0 },
  outputConfig: { effort: "max" },
});

const MODELS = ["claude-opus-5", "claude-sonnet-5"];

describe("R2：thinking disabled 时请求体不带 output_config.effort", () => {
  for (const model of MODELS) {
    test(`${model} 流式`, async () => {
      const { provider, bodies } = capture(model);
      for await (const _ of provider.sendMessageStream(offWithMaxEffort(model))) {
        /* drain */
      }
      expect(bodies).toHaveLength(1);
      expect(bodies[0].thinking).toEqual({ type: "disabled" });
      expect(bodies[0].output_config).toBeUndefined();
    });

    test(`${model} 非流式`, async () => {
      const { provider, bodies } = capture(model);
      await provider.sendMessageNonStreaming(offWithMaxEffort(model));
      expect(bodies).toHaveLength(1);
      expect(bodies[0].thinking).toEqual({ type: "disabled" });
      expect(bodies[0].output_config).toBeUndefined();
    });
  }

  test("对照：thinking 开启时 effort 照常下发（防「一律不发」把断言做成恒绿）", async () => {
    const { provider, bodies } = capture("claude-opus-5");
    await provider.sendMessageNonStreaming({
      ...offWithMaxEffort("claude-opus-5"),
      thinking: { enabled: true, budgetTokens: 0 },
      outputConfig: { effort: "max", thinkingType: "adaptive" },
    });
    expect(bodies[0].output_config).toEqual({ effort: "max" });
  });
});
