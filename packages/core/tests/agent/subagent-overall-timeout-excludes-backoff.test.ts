/**
 * 子代理整体超时不得覆盖漏斗的重试退避 —— 事故 20261015-114502-c596be23 回归门禁。
 *
 * 事故现场：主代理并行派 3 个 task 子代理，第 5 轮请求撞网关 429「当前分组上游负载已饱和」，
 * 漏斗按 6s→11s→24s→43s→86s 退避重试；从该轮 fetch_sent 起**正好 180.0s**，
 * `TimeoutFired layer=agent_overall_timeout` 把 3 个子代理全部砍掉
 * （`sub-agent stream overall timeout: 180s 总时长超限`），第 6 次重试还在退避里。
 *
 * 根因：`agent/stream-processor.ts` 的 overall 层包的是整个 `streamWithResilience` 漏斗，
 * 却从流开始绝对计时 —— 实际语义是「本轮全部重试 + 退避」的总上限，于是 `maxRetries`
 * 被时间架空（与 2026-10-12 主循环、2026-10-14 B1 同型，只是换了一个杀手）。
 *
 * 场景构造（等比例缩小）：overall 300ms，4 次 429 的累计退避远超 300ms，第 5 次成功。
 * 修复前：provider 被调 3 次左右、`agent_overall_timeout` 开枪、success=false。
 *
 * 负向对照（防空集全绿）：单次尝试本身跑超 overall → 仍必须开枪。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent, SendParams } from "@sid-code/core/llm/types.ts";
import {
  setRetryTelemetryObserver,
  type RetryTelemetryEvent,
} from "@sid-code/core/llm/retry-telemetry.ts";

/** 事故现场的真实 429 报文（warn.log 03:54:05） */
const SATURATED_429 = "当前分组上游负载已饱和，请稍后再试";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* saturated(): AsyncIterable<StreamEvent> {
  yield {
    type: "error",
    error: { message: SATURATED_429, type: "rate_limit_error", statusCode: 429, streamLevel: true },
  } as any;
}

async function* ok(text: string, delayMs = 0): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  if (delayMs > 0) await sleep(delayMs);
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 5 },
  } as any;
}

/** 持续吐内容、永不结束的单次尝试（idle / content 都续命，只有 overall 能判） */
async function* neverEnding(signal: AbortSignal): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  while (!signal.aborted) {
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "." },
    } as any;
    await sleep(10);
  }
}

function makeProvider(scripted: Array<(p: SendParams) => AsyncIterable<StreamEvent>>) {
  let calls = 0;
  const provider = {
    name: () => "anthropic",
    sendMessageStream: (params: SendParams) => {
      const f = scripted[Math.min(calls, scripted.length - 1)];
      calls += 1;
      return f(params);
    },
  } as unknown as Provider;
  return { provider, calls: () => calls };
}

function noCooldownAvailability(): ModelAvailabilityService {
  // 共享冷却与被测对象无关（见 subagent-rate-limit-retry.test.ts 同名函数注释）。
  const svc = new ModelAvailabilityService();
  svc.markRateLimited = () => {};
  return svc;
}

function config(provider: Provider, overrides: Record<string, unknown> = {}) {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("你是文档分类助手");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "分类 done 文档 chunk-02" }] });
  return {
    provider,
    model: "claude-opus-5-5",
    ctxMgr,
    tools: new ToolRegistry(),
    maxTurns: 3,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    availability: noCooldownAvailability(),
    permissionChecker: undefined,
    maxStreamRetries: 10,
    // 等比例缩小的事故参数：overall 300ms；退避 base 120ms / cap 240ms，
    // 4 次退避累计 ≈ 120+240+240+240 = 840ms ≫ 300ms。
    streamOverallTimeoutMs: 300,
    streamIdleTimeoutMs: 5_000,
    retryBackoffBaseMs: 120,
    retryBackoffMaxMs: 240,
    ...overrides,
  } as any;
}

const telemetry: RetryTelemetryEvent[] = [];
beforeEach(() => {
  telemetry.length = 0;
  setRetryTelemetryObserver((e: RetryTelemetryEvent) => telemetry.push(e));
});
afterEach(() => setRetryTelemetryObserver(null));

describe("事故 20261015-114502 — 子代理 overall 只计单次尝试", () => {
  test("4 次 429、累计退避远超 overall → 第 5 次成功交付，overall 不开枪", async () => {
    const { provider, calls } = makeProvider([
      () => saturated(),
      () => saturated(),
      () => saturated(),
      () => saturated(),
      () => ok("分类完成：chunk-02 共 37 篇"),
    ]);
    const t0 = Date.now();
    const result = await runAgentLoop(config(provider));
    const elapsed = Date.now() - t0;

    // 前提成立：真的退避了足够久（否则这条测试证明不了任何事）
    expect(elapsed).toBeGreaterThan(600);
    expect(calls()).toBe(5);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("分类完成");
    expect(result.errorMessage ?? "").not.toContain("overall timeout");
  }, 20_000);

  test("负向对照：单次尝试本身跑超 overall → 仍开枪（overall 没被关掉）", async () => {
    const ctl = new AbortController();
    const { provider } = makeProvider([() => neverEnding(ctl.signal)]);
    const result = await runAgentLoop(
      config(provider, { maxStreamRetries: 0, retryBackoffBaseMs: 0, retryBackoffMaxMs: 0 }),
    );
    ctl.abort();
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("overall timeout");
  }, 20_000);

  test("退避后的新尝试重新起表：退避前已耗 200ms 的尝试不把余量带进下一次", async () => {
    // 第 1 次尝试 200ms 后 429（< overall 300ms），退避 120ms，第 2 次尝试再跑 200ms 成功。
    // 两次尝试 + 退避合计 520ms > 300ms；若 overall 只停表不重置，第 2 次在 100ms 处被砍。
    async function* slow429(): AsyncIterable<StreamEvent> {
      await sleep(200);
      yield* saturated();
    }
    const { provider, calls } = makeProvider([() => slow429(), () => ok("ok", 200)]);
    const result = await runAgentLoop(config(provider));
    expect(calls()).toBe(2);
    expect(result.success).toBe(true);
  }, 20_000);
});
