/**
 * §8 C 组：跨轮恢复（I4 用户意图优先）。
 *
 * 装配取舍：设计稿建议经 `engine.ts submitMessage` 驱动。engine 对漏斗的唯一依赖是
 * `sendWithRetry → fallback.executeWithFallback(..., { querySource: "main_thread" })`，
 * 这一条装配由 `recovery-single-exit.test.ts` 静态钉住；本文件在**共享 availability + 同一
 * 漏斗实例**上模拟「多轮 / side-call 穿插」，验证的是那条装配之后的全部行为。
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback, type QuerySource } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARAMS: SendParams = {
  model: "m1",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};
const AUTH_401 = {
  type: "error",
  error: {
    message: "Token已失效，请重试",
    type: "upstream_error",
    statusCode: 401,
    streamLevel: true,
  },
} as StreamEvent;
const OK: StreamEvent[] = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { inputTokens: 1, outputTokens: 1 },
  },
  { type: "message_stop" },
];

/** 可切换健康状态的 provider：down=true 时持续 401 */
function switchable() {
  const state = { down: true, calls: 0 };
  const provider = {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      state.calls++;
      if (state.down) {
        yield AUTH_401;
        return;
      }
      for (const e of OK) yield e;
    },
  } as unknown as Provider;
  return { provider, state };
}

function setup() {
  const availability = new ModelAvailabilityService();
  const fb = new ModelFallback({
    availability,
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    respectSharedCooldown: false,
  });
  const call = async (provider: Provider, querySource: QuerySource) => {
    const out: StreamEvent[] = [];
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource,
      switchMode: "off",
    })) {
      out.push(e);
    }
    return out;
  };
  return { availability, call };
}

const ok = (out: StreamEvent[]) => out.some((e) => e.type === "message_stop");

describe("C：跨轮恢复（I4）", () => {
  test("第 1 轮持续 401 到放弃；第 2 轮 provider 恢复 → 主线程真实发出并成功", async () => {
    const { availability, call } = setup();
    const { provider, state } = switchable();
    await call(provider, "main_thread");
    expect(availability.isSuspect("m1")).toBe(true);

    state.down = false;
    const before = state.calls;
    const out = await call(provider, "main_thread");
    expect(state.calls - before).toBeGreaterThanOrEqual(1); // 修复前为 0
    expect(ok(out)).toBe(true);
    expect(availability.isSuspect("m1")).toBe(false);
  });

  test("顺序变体：第 2 轮先跑 side-call（memory_recall）读 availability，主线程仍真实发出", async () => {
    const { call } = setup();
    const { provider, state } = switchable();
    await call(provider, "main_thread");

    // side-call 在嫌疑期内：第一路是探针（仍失败），第二路被拦
    await call(provider, "memory_recall");
    const sideBlocked = state.calls;
    await call(provider, "memory_recall");
    expect(state.calls).toBe(sideBlocked);

    state.down = false;
    const before = state.calls;
    const out = await call(provider, "main_thread");
    expect(state.calls - before).toBe(1);
    expect(ok(out)).toBe(true);
  });

  test("同轮变体：放弃后同一轮再次调用（loop 层 timeout_retry 形态）真实触达 provider", async () => {
    const { call } = setup();
    const { provider, state } = switchable();
    await call(provider, "main_thread");
    const before = state.calls;
    await call(provider, "main_thread");
    expect(state.calls - before).toBe(3); // 又一份完整的 auth_suspect 预算，未被拦截
  });

  test("子代理路径在嫌疑期内只有一路发出（半开探针）", async () => {
    const { call } = setup();
    const { provider, state } = switchable();
    await call(provider, "main_thread");
    const before = state.calls;
    await Promise.all([
      call(provider, "agent:builtin"),
      call(provider, "agent:builtin"),
      call(provider, "agent:custom"),
    ]);
    // 探针那一路吃满自己的族预算（3 次），其余两路零触达
    expect(state.calls - before).toBe(3);
  });
});
