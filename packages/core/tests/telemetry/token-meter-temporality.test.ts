/**
 * 缺陷 33：input_tokens counter 的 DELTA 求和语义 = 累计计费 prompt（flow）。
 *
 * 钉住两件事：① 每点值是单次请求的 promptTotal（两族同口径，含命中与写入）；
 * ② 按 DELTA 把同名点求和 = Σ promptTotal = collector 的 total_cumulative_prompt_tokens 口径。
 * 若有人把单点值改成「上下文增量」或「末次 stock」，① 或 ② 会红。
 */
import { describe, test, expect } from "bun:test";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import type { MetricPoint } from "@sid-code/core/telemetry/types.ts";

const INPUT = "gen_ai.client.inference.usage.input_tokens";

function meterWithSink() {
  const bus = new TelemetryBus({ enabled: true });
  const points: MetricPoint[] = [];
  const orig = bus.recordMetric.bind(bus);
  bus.recordMetric = (p: MetricPoint) => {
    points.push(p);
    orig(p);
  };
  return { meter: new TokenMeter(bus, () => 0), points };
}

describe("缺陷 33：input_tokens counter 的累加语义", () => {
  test("OpenAI 族：单点 = prompt_tokens，Σ = 累计计费 prompt", () => {
    const { meter, points } = meterWithSink();
    // 三轮对话，prompt 随历史增长：1000 / 1500 / 2100（其中命中 0 / 900 / 1400）
    const rounds = [
      { inputTokens: 1000, cacheReadInputTokens: 0 },
      { inputTokens: 1500, cacheReadInputTokens: 900 },
      { inputTokens: 2100, cacheReadInputTokens: 1400 },
    ];
    for (const r of rounds)
      meter.record({
        model: "deepseek-v4-pro",
        provider: "openai",
        usage: { ...r, outputTokens: 10 },
        costUSD: 0,
      });
    const inputs = points.filter((p) => p.name === INPUT);
    expect(inputs.map((p) => p.value)).toEqual([1000, 1500, 2100]);
    expect(inputs.every((p) => p.type === "counter")).toBe(true);
    expect(inputs.reduce((a, p) => a + p.value, 0)).toBe(4600);
  });

  test("Anthropic 族：单点 = 未命中 + 命中 + 写入（与 OpenAI 族同口径）", () => {
    const { meter, points } = meterWithSink();
    meter.record({
      model: "claude-opus-5",
      provider: "anthropic",
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 300,
      },
      costUSD: 0,
    });
    expect(points.find((p) => p.name === INPUT)!.value).toBe(1200);
  });
});
