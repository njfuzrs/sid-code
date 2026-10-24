/**
 * 重试次数与看门狗解耦（2026-10-12）—— 取代 2026-08-29 的「两层预算共享」门禁
 *
 * ## 用户看到的症状
 *
 * 上游 429 饱和时报「已尝试 6 次 … 证据：transient/deadline … 时间预算不足」，
 * 重试 5 次就结束，而 `maxTimeoutRetries` 配的是 10。
 *
 * ## 根因
 *
 * 主循环看门狗判「单次请求卡死」，却把 fallback 漏斗里的**重试退避**也算成「无进展」。
 * 2026-08-29 为避免「内层退避中被外层杀掉、外层再从 1 数起」的两层相乘，
 * 把看门狗阈值（315s）当 `deadlineAt` 交给内层 —— 于是次数上限被时间上限架空：
 * 5s→120s 的指数退避在 315s 内最多 5–6 次。
 *
 * ## 修法：各管各的
 *
 * - 漏斗在退避前后发 `retry_backoff` start/end；
 * - 看门狗（loop.ts）与心跳/整体超时（stream-processor.ts）退避期不判、退避后从零起算；
 * - 主循环不再给漏斗传 `deadlineAt`，次数只由 `maxRetries` 决定。
 *
 * 每条正向断言都配一条负向对照（去掉 `retry_backoff` 信号同样场景必被杀），
 * 防止「看门狗本来就没开枪」那种空集全绿。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import { trackRetryBackoff } from "@sid-code/core/query/retry-backoff-window.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function endTurnResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 模拟漏斗：先退避 backoffMs（可选择是否发信号），再给出正常响应 */
function backoffThenOk(backoffMs: number, signalled: boolean) {
  return async function* (): AsyncGenerator<StreamEvent> {
    if (signalled) yield { type: "retry_backoff", phase: "start", delayMs: backoffMs, attempt: 1 };
    await sleep(backoffMs);
    if (signalled) yield { type: "retry_backoff", phase: "end", delayMs: backoffMs, attempt: 1 };
    yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as any;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    } as any;
    yield { type: "content_block_stop", index: 0 } as any;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as any;
    yield { type: "message_stop" } as any;
  };
}

function setup(sendWithRetry: QueryDeps["sendWithRetry"]) {
  const signals: AbortSignal[] = [];
  const optsSeen: unknown[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

  const deps: QueryDeps = {
    sendWithRetry: (params: any, signal?: AbortSignal, opts?: any) => {
      if (signal) signals.push(signal);
      optsSeen.push(opts);
      return sendWithRetry(params, signal, opts);
    },
    // 真正消费流（包裹后的流），让退避信号经过 trackRetryBackoff
    processStream: async (stream: AsyncIterable<StreamEvent>) => {
      for await (const _ of stream) {
        /* drain */
      }
      return endTurnResp();
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    uuid: () => "u1",
    maxTurnDurationMs: 60_000,
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "m",
      provider: "anthropic",
      maxTurns: 1,
      maxTokens: 8000,
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-retry-decoupled"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, signals, optsSeen };
}

async function drain(loopConfig: QueryLoopConfig) {
  const events: any[] = [];
  for await (const ev of queryLoop(loopConfig)) events.push(ev);
  return events;
}

const watchdogKilled = (signals: AbortSignal[]) =>
  signals.some((s) => s.aborted && String(s.reason) === "watchdog-timeout");

describe("主循环：不再给漏斗设时间上限", () => {
  test("sendWithRetry 不带 deadlineAt（带了 = 次数又被时间截断）", async () => {
    const { loopConfig, optsSeen } = setup(() => backoffThenOk(0, false)());
    await drain(loopConfig);
    expect(optsSeen.length).toBeGreaterThanOrEqual(1);
    for (const o of optsSeen) expect((o as any)?.deadlineAt).toBeUndefined();
  });
});

describe("看门狗：退避期不判，退避后从零起算", () => {
  beforeEach(() => {
    // 看门狗阈值压到 ~60ms，退避 400ms —— 远超阈值
    process.env.SID_CODE_WATCHDOG_CHECK_INTERVAL_MS = "10";
    process.env.SID_CODE_WATCHDOG_NO_PROGRESS_MS = "60";
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "40";
    process.env.SID_CODE_WATCHDOG_HEADER_GRACE_MS = "20";
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "0";
    process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "1";
    process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "1";
  });
  afterEach(() => {
    for (const k of [
      "SID_CODE_WATCHDOG_CHECK_INTERVAL_MS",
      "SID_CODE_WATCHDOG_NO_PROGRESS_MS",
      "SID_CODE_RESPONSE_HEADER_TIMEOUT_MS",
      "SID_CODE_WATCHDOG_HEADER_GRACE_MS",
      "SID_CODE_MAX_TIMEOUT_RETRIES",
      "SID_CODE_RETRY_BACKOFF_BASE_MS",
      "SID_CODE_RETRY_BACKOFF_MAX_MS",
    ])
      delete process.env[k];
  });

  test("退避远超看门狗阈值 → 不被杀，正常拿到响应", async () => {
    const { loopConfig, signals } = setup(() => backoffThenOk(400, true)());
    const events = await drain(loopConfig);
    expect(watchdogKilled(signals)).toBe(false);
    expect(events.some((e) => e.kind === "assistant_message")).toBe(true);
  }, 15_000);

  test("负向对照：同样的静默但没有 retry_backoff 信号 → 看门狗照常开枪", async () => {
    const { loopConfig, signals } = setup(() => backoffThenOk(400, false)());
    await drain(loopConfig);
    // 变异自证：若看门狗本来就不会在 400ms 内开枪，上一条的「没被杀」毫无意义
    expect(watchdogKilled(signals)).toBe(true);
  }, 15_000);

  test("退避结束后请求真卡死 → 看门狗仍然开枪（只豁免退避，不豁免卡死）", async () => {
    const { loopConfig, signals } = setup(() =>
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "retry_backoff", phase: "start", delayMs: 200 };
        await sleep(200);
        yield { type: "retry_backoff", phase: "end", delayMs: 200 };
        await new Promise<never>(() => {
          /* 新一次请求永不返回 */
        });
      })(),
    );
    await drain(loopConfig);
    expect(watchdogKilled(signals)).toBe(true);
  }, 15_000);
});

describe("stream-processor：心跳 / 整体超时同样剔除退避", () => {
  const opts = (overallTimeoutMs = 60_000) => ({
    heartbeatTimeoutMs: 60,
    firstByteTimeoutMs: 60,
    overallTimeoutMs,
    heartbeatCheckIntervalMs: 10,
  });

  test("退避 300ms 远超首字节/心跳 60ms → 不超时", async () => {
    const resp = await processStream(backoffThenOk(300, true)(), undefined, undefined, opts());
    expect(resp.content.some((b: any) => b.type === "text" && b.text === "ok")).toBe(true);
  }, 10_000);

  test("负向对照：无信号的 300ms 静默 → 首字节超时", async () => {
    let thrown: unknown = null;
    try {
      await processStream(backoffThenOk(300, false)(), undefined, undefined, opts());
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain("timeout");
  }, 10_000);

  test("整体超时扣除退避时长（退避 300ms > 整体 200ms 仍完成）", async () => {
    const resp = await processStream(backoffThenOk(300, true)(), undefined, undefined, opts(200));
    expect(resp.stopReason).toBe("end_turn");
  }, 10_000);

  // 2026-10-15（事故 20261015-114502）：整体超时管「单次尝试」。
  // 只扣退避不够：两次各 150ms 的尝试（各自 < 200ms）合计 300ms 仍会被砍。
  test("整体超时按尝试重新起表：两次尝试各 150ms（合计 > 整体 200ms）→ 完成", async () => {
    async function* twoAttempts(): AsyncGenerator<StreamEvent> {
      yield {
        type: "message_start",
        message: { usage: { inputTokens: 1, outputTokens: 0 } },
      } as any;
      await sleep(150);
      yield { type: "retry_backoff", phase: "start", delayMs: 5, attempt: 1 };
      await sleep(5);
      yield { type: "retry_backoff", phase: "end", delayMs: 5, attempt: 1 };
      yield { type: "stream_restart", reason: "rate_limit", attempt: 1 };
      await sleep(150);
      yield* backoffThenOk(0, false)();
    }
    const resp = await processStream(twoAttempts(), undefined, undefined, {
      ...opts(200),
      heartbeatTimeoutMs: 5_000,
      firstByteTimeoutMs: 5_000,
    });
    expect(resp.stopReason).toBe("end_turn");
  }, 10_000);

  test("新尝试回到首字节档：退避后排队 200ms（> 心跳 60ms、< 首字节 500ms）→ 完成", async () => {
    async function* queuedAfterBackoff(): AsyncGenerator<StreamEvent> {
      yield {
        type: "message_start",
        message: { usage: { inputTokens: 1, outputTokens: 0 } },
      } as any;
      yield { type: "retry_backoff", phase: "start", delayMs: 5, attempt: 1 };
      await sleep(5);
      yield { type: "retry_backoff", phase: "end", delayMs: 5, attempt: 1 };
      await sleep(200);
      yield* backoffThenOk(0, false)();
    }
    const resp = await processStream(queuedAfterBackoff(), undefined, undefined, {
      ...opts(),
      firstByteTimeoutMs: 500,
    });
    expect(resp.stopReason).toBe("end_turn");
  }, 10_000);

  test("负向对照：单次尝试本身超整体上限 → 照样超时", async () => {
    async function* slowAttempt(): AsyncGenerator<StreamEvent> {
      yield { type: "retry_backoff", phase: "start", delayMs: 5, attempt: 1 };
      await sleep(5);
      yield { type: "retry_backoff", phase: "end", delayMs: 5, attempt: 1 };
      for (let i = 0; i < 30; i++) {
        await sleep(20);
        yield {
          type: "message_start",
          message: { usage: { inputTokens: 1, outputTokens: 0 } },
        } as any;
      }
      yield* backoffThenOk(0, false)();
    }
    let thrown: unknown = null;
    try {
      await processStream(slowAttempt(), undefined, undefined, {
        ...opts(200),
        heartbeatTimeoutMs: 5_000,
        firstByteTimeoutMs: 5_000,
      });
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain("overall timeout");
  }, 10_000);
});

describe("漏斗：每次退避成对发信号，次数只由 maxRetries 决定", () => {
  function errStream(): AsyncGenerator<StreamEvent> {
    return (async function* () {
      yield {
        type: "error",
        error: {
          message: "当前分组上游负载已饱和",
          type: "rate_limit_error",
          statusCode: 429,
          streamLevel: true,
        },
      } as unknown as StreamEvent;
    })();
  }

  test("429 持续 → 跑满 1+10 次，10 对 retry_backoff，无 deadline 放弃", async () => {
    let calls = 0;
    const provider: any = {
      name: () => "anthropic",
      sendMessageStream: () => {
        calls++;
        return errStream();
      },
    };
    const telemetry: any[] = [];
    const fb = new ModelFallback({
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 2,
      maxRetries: 10,
      respectSharedCooldown: false,
      allowNonStreamingFallback: false,
      onTelemetry: (e) => telemetry.push(e),
    });
    const out: StreamEvent[] = [];
    try {
      for await (const e of fb.executeWithFallback(
        provider,
        { model: "m1", messages: [], maxTokens: 10 } as any,
        undefined,
        {
          querySource: "main_thread",
          switchMode: "off",
        },
      ))
        out.push(e);
    } catch {
      /* 耗尽后抛错或发 error 事件均可 */
    }
    expect(calls).toBe(11);
    const starts = out.filter(
      (e) => e.type === "retry_backoff" && (e as any).phase === "start",
    ).length;
    const ends = out.filter((e) => e.type === "retry_backoff" && (e as any).phase === "end").length;
    expect(starts).toBe(10);
    expect(ends).toBe(10);
    expect(telemetry.filter((e) => e.type === "retry_budget_exhausted").length).toBe(0);
  }, 15_000);
});

describe("trackRetryBackoff 单元", () => {
  test("start/end 计时、透传全部事件", async () => {
    let t = 1000;
    const src = (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "retry_backoff", phase: "start", delayMs: 5 };
      t = 1500;
      yield { type: "retry_backoff", phase: "end", delayMs: 5 };
      yield { type: "message_stop" } as any;
    })();
    const { stream, window } = trackRetryBackoff(src, () => t);
    const seen: string[] = [];
    for await (const e of stream) {
      seen.push(e.type);
      if (seen.length === 1) expect(window.active).toBe(true);
    }
    expect(seen).toEqual(["retry_backoff", "retry_backoff", "message_stop"]);
    expect(window.active).toBe(false);
    expect(window.totalMs).toBe(500);
    expect(window.lastEndedAt).toBe(1500);
  });
});
