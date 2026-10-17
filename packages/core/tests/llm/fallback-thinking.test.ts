/**
 * D9：fallback 降级时按备用模型重下 thinking / effort（20261016 思考开关排查 §8.2）。
 *
 * 判据是「备用模型实收的 params 形态」，含 §9 变异表里 fallback 的三行：
 *   - 不清空 outputConfig → Sonnet 5 adaptive → DeepSeek 残留 thinkingType
 *   - thinking 输入改取主模型 thinking.enabled / 用户 /think → side-call 降级后开思考
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { reapplyThinkingForFallback } from "@sid-code/core/llm/fallback-thinking.ts";
import { buildThinkingWire } from "@sid-code/core/llm/anthropic.ts";
import { SIDE_CALL_NO_THINK } from "@sid-code/core/llm/side-call-timeout.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const base = (over: Partial<SendParams>): SendParams => ({
  model: "primary",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
  ...over,
});

// 真实路径里 streamFromFallback 先把 model 换成备用模型再调本函数，单测按同形态构造。
const reapply = (p: SendParams, fallbackModel: string, providerName: string) => {
  p.model = fallbackModel;
  reapplyThinkingForFallback(p, { fallbackModel, providerName });
};

describe("reapplyThinkingForFallback", () => {
  test("DeepSeek off → Sonnet 5：备用请求线上为 disabled（修前不发字段 = 照常思考）", () => {
    const p = base({
      thinking: { enabled: false, budgetTokens: 0 },
      thinkingIntent: { thinking: false },
    });
    reapply(p, "claude-sonnet-5", "anthropic");
    expect(p.thinking?.enabled).toBe(false);
    expect(buildThinkingWire(p, "claude-sonnet-5").param).toEqual({
      thinking: { type: "disabled" },
    });
  });

  test("DeepSeek on(max) → Sonnet 5：丢 OpenAI 族 reasoningEffort，改写 adaptive + outputConfig", () => {
    const p = base({
      thinking: { enabled: true, budgetTokens: 10000 },
      reasoningEffort: "max",
      thinkingIntent: { thinking: true, effort: "max" },
    });
    reapply(p, "claude-sonnet-5", "anthropic");
    expect(p.reasoningEffort).toBeUndefined();
    expect(p.outputConfig?.thinkingType).toBe("adaptive");
  });

  test("Sonnet 5 adaptive → DeepSeek：不残留 Claude 专属 outputConfig.thinkingType", () => {
    const p = base({
      thinking: { enabled: true, budgetTokens: 0 },
      outputConfig: { effort: "high", thinkingType: "adaptive" },
      thinkingIntent: { thinking: true, effort: "high" },
    });
    reapply(p, "deepseek-v4-pro", "openai");
    expect(p.outputConfig).toBeUndefined();
    expect(p.thinking?.enabled).toBe(true);
    expect(p.reasoningEffort).toBe("high");
  });

  test("意图取 thinkingIntent，不取被恒思考模型强制成 true 的 thinking.enabled", () => {
    // 主模型 Opus 5.5（恒思考）：applier 把 off 强制成 enabled:true；意图仍是 off。
    const p = base({
      thinking: { enabled: true, budgetTokens: 0 },
      outputConfig: { effort: "low", thinkingType: "adaptive" },
      thinkingIntent: { thinking: false },
    });
    reapply(p, "claude-sonnet-5", "anthropic");
    expect(p.thinking?.enabled).toBe(false);
    expect(p.outputConfig).toBeUndefined();
  });

  test("side-call（SIDE_CALL_NO_THINK、无 thinkingIntent）降级到 Sonnet 5 仍是 disabled", () => {
    const p = base({ thinking: { ...SIDE_CALL_NO_THINK } });
    reapply(p, "claude-sonnet-5", "anthropic");
    expect(buildThinkingWire(p, "claude-sonnet-5").param).toEqual({
      thinking: { type: "disabled" },
    });
  });

  test("备用模型不支持 max 时 effort 钳到 high（与主循环 resolveAppliedEffort 同口径）", () => {
    let seen: unknown;
    const p = base({ thinkingIntent: { thinking: true, effort: "max" } });
    reapplyThinkingForFallback(p, {
      fallbackModel: "x",
      providerName: "openai",
      resolveCapability: () =>
        ({
          supportsMaxEffort: false,
          applyToSendParams: (_p: SendParams, e: unknown) => {
            seen = e;
          },
        }) as never,
    });
    expect(seen).toBe("high");
  });

  test("调用方从未表达思考意图时不动 params（不凭空改变请求形状）", () => {
    const p = base({});
    reapply(p, "claude-sonnet-5", "anthropic");
    expect(p.thinking).toBeUndefined();
    expect(p.outputConfig).toBeUndefined();
  });
});

describe("ModelFallback.streamFromFallback 接线", () => {
  test("主 provider 失败 → 备用 provider 实收的是按备用模型重下的参数", async () => {
    let received: SendParams | undefined;
    const fbProvider: Provider = {
      name: () => "openai",
      async *sendMessageStream(p: SendParams): AsyncIterable<StreamEvent> {
        received = p;
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        yield { type: "message_stop" };
      },
    };
    const failing: Provider = {
      name: () => "anthropic",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: "error", error: { message: "401 Unauthorized" } };
      },
    };
    const fallback = new ModelFallback({
      fallbackProvider: fbProvider,
      fallbackModel: "deepseek-v4-pro",
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
    });
    const params = base({
      model: "claude-sonnet-5",
      thinking: { enabled: true, budgetTokens: 0 },
      outputConfig: { effort: "high", thinkingType: "adaptive" },
      thinkingIntent: { thinking: true, effort: "high" },
    });
    for await (const _ of fallback.executeWithFallback(failing, params)) {
      // drain
    }
    expect(received?.model).toBe("deepseek-v4-pro");
    expect(received?.outputConfig).toBeUndefined();
    expect(received?.reasoningEffort).toBe("high");
    // 主请求的 params 不被原地改写（fallbackParams 是浅拷贝）
    expect(params.outputConfig?.thinkingType).toBe("adaptive");
  });
});
