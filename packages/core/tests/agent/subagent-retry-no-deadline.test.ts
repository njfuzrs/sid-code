/**
 * 卡 B1（2026-10-14）：子代理不再给漏斗传 deadlineAt —— 次数听 maxRetries 的，不听墙钟。
 *
 * 事故 20261014-110202-8c0ffb30：子代理墙钟 300s 被休眠吃光后，第一次 `Connection error.`
 * 就 `recovery_give_up giveUpReason=deadline attempts=1`；同一个漏斗主循环能重试 10 次。
 *
 * PR-B（2026-10-17）起子代理已无墙钟；本测试锁住「重试次数听 maxRetries」这条不变量。
 * 退避压 0，测试不真睡。
 * 变异自证：把 `deadlineAt: startTime + timeout` 加回 buildBaseLoopConfig，本测试红。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent, SendParams } from "@sid-code/core/llm/types.ts";
import {
  setRetryTelemetryObserver,
  type RetryTelemetryEvent,
} from "@sid-code/core/llm/retry-telemetry.ts";

const ENV_KEYS = ["SID_CODE_RETRY_BACKOFF_BASE_MS", "SID_CODE_RETRY_BACKOFF_MAX_MS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "0";
  process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "1";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setRetryTelemetryObserver(null);
});

async function* ok(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "交付" },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 1 },
  } as any;
}

function flakyProvider(failures: number) {
  let calls = 0;
  const provider = {
    name: () => "openai",
    defaultModel: () => "m",
    sendMessageStream: (_p: SendParams) => {
      calls += 1;
      if (calls <= failures) {
        return (async function* () {
          throw new Error("Connection error.");
        })();
      }
      return ok();
    },
  } as unknown as Provider;
  return { provider, calls: () => calls };
}

describe("B1 — 子代理重试不被墙钟截断", () => {
  test("前 4 次 Connection error、第 5 次成功：仍交付，且无 giveUpReason=deadline", async () => {
    const events: RetryTelemetryEvent[] = [];
    setRetryTelemetryObserver((e: RetryTelemetryEvent) => events.push(e));
    const { provider, calls } = flakyProvider(4);
    const agent = new SubAgent(provider, "test-model", new Registry());

    const result = await agent.execute({
      type: "explore",
      description: "B1",
      prompt: "x",
    });

    expect(result.success).toBe(true);
    expect(calls()).toBe(5);
    expect(
      events.filter((e) => (e as { giveUpReason?: string }).giveUpReason === "deadline"),
    ).toHaveLength(0);
  });
});

describe("PR-B — 用户中止能打断退避中的 sleep", () => {
  // 原「硬 kill 打断退避」：硬 kill 已删（PR-B），打断退避的唯一出口是外层 signal（ESC / task_stop）。
  test("永远失败 + 退避 base 60s：外层 abort 后很快结束，不会睡满退避", async () => {
    process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "60000";
    process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "120000";
    const { provider } = flakyProvider(Number.POSITIVE_INFINITY);
    const agent = new SubAgent(provider, "test-model", new Registry());
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const t0 = Date.now();
    const result = await agent.execute(
      { type: "explore", description: "B1-abort", prompt: "x" },
      ctrl.signal,
    );
    const elapsed = Date.now() - t0;
    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);
});
