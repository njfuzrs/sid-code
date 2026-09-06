/**
 * 回归门禁：`tryFallback` 的 **ask → abort** 出口必须把真实根因拼进错误文案。
 *
 * 缺陷本体（轨迹 20260905-215535-664d3239）：`fallback.ts` 有四条「重试耗尽」出口，
 * 其中三条都拼了 `rootCause`（重试次数 + 最后一次失败原因），
 * **只有 ask/abort 这条漏了** —— 而它恰好是生产默认路径：
 * `fallbackSwitchMode` 默认 "ask"，钩子返回 abort（用户选「不切换」，或无交互通道
 * 且没配 fallbackModel）。于是用户看到的就是那句没有信息量的
 * 「主模型请求失败，已终止本轮。可重新发送消息重试，或用 /model 切换模型。」
 *
 * 变异自证：把 fallback.ts 该出口的 `${rootCause}` 删掉 → 本文件第一条断言立刻红。
 * （已实测：删掉后 `toContain("负载已饱和")` 失败。）
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 每次调用都以「流内 error 事件」形式回一个限流错误（网关的真实形态）。 */
function rateLimitedProvider(errorMsg: string): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "error", error: { message: errorMsg, type: "rate_limit_error" } };
    },
  };
}

const params: SendParams = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 128,
};

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** 取流里最后一个 error 事件的文案。 */
function lastErrorMessage(events: StreamEvent[]): string {
  const errs = events.filter((e) => e.type === "error");
  expect(errs.length).toBeGreaterThan(0);
  return (errs[errs.length - 1] as Extract<StreamEvent, { type: "error" }>).error.message;
}

// 网关真实文案（含 request id，故意保留——它同时验证根因是整句透出而非被截断）。
const REAL = "当前分组上游负载已饱和，请稍后再试 (request id: 2026090519422733007594196e93ae3)";

describe("ask/abort 出口必须透出真实根因", () => {
  test("用户选「不切换」时，错误文案含真实网关报错与重试次数", async () => {
    const fallback = new ModelFallback({
      maxRetries: 2,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 2,
      fallbackSwitchMode: "ask",
      // 钩子直接 abort —— 等价于用户在弹窗里选「不切换，终止本轮」。
      onFallbackDecision: async () => ({ action: "abort" }),
    });

    const events = await collect(
      fallback.executeWithFallback(rateLimitedProvider(REAL), params, undefined, {
        source: "user",
      } as never),
    );

    const msg = lastErrorMessage(events);
    // 核心：真实根因必须在文案里，而不是只有那句通用引导。
    expect(msg).toContain("负载已饱和");
    // 重试次数一并透出（回答「到底试了几次」）。
    expect(msg).toMatch(/重试 \d+ 次/);
    // 原有引导语保留（不是把旧文案换掉，而是在其后追加根因）。
    expect(msg).toContain("/model");
  });

  test("四条耗尽出口无一遗漏：ask/abort 与 auto/无可用 fallback 都带根因", async () => {
    // auto 且没有可用 fallback → 走「无可用 fallback」那条出口（此前就带 rootCause，
    // 一并锁住，防止将来重构时把两条出口的行为again弄成一边有一边没有）。
    const autoNoTarget = new ModelFallback({
      maxRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 2,
      fallbackSwitchMode: "auto",
    });
    const events = await collect(
      autoNoTarget.executeWithFallback(rateLimitedProvider(REAL), params, undefined, {
        source: "user",
      } as never),
    );
    expect(lastErrorMessage(events)).toContain("负载已饱和");
  });

  test("fallbackSwitchMode=off 也带根因", async () => {
    const off = new ModelFallback({
      maxRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 2,
      fallbackSwitchMode: "off",
    });
    const events = await collect(
      off.executeWithFallback(rateLimitedProvider(REAL), params, undefined, {
        source: "user",
      } as never),
    );
    expect(lastErrorMessage(events)).toContain("负载已饱和");
  });
});

describe("ask 弹窗的 reason 必须是真实根因，不是常量", () => {
  test("onFallbackDecision 收到的 reason 含网关原文", async () => {
    let seenReason = "";
    const fallback = new ModelFallback({
      maxRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 2,
      fallbackSwitchMode: "ask",
      onFallbackDecision: async (ctx) => {
        seenReason = ctx.reason;
        return { action: "abort" };
      },
    });

    await collect(
      fallback.executeWithFallback(rateLimitedProvider(REAL), params, undefined, {
        source: "user",
      } as never),
    );

    // 变异自证：把 fallback.ts 那里改回 reason: "主模型重试耗尽" → 本条红。
    // 判据：限流(该等)与配额耗尽(必须换模型)的正确动作相反，这个弹窗正是决策点。
    expect(seenReason).toContain("负载已饱和");
    expect(seenReason).not.toBe("主模型重试耗尽");
  });
});
