/**
 * 卡 C1（2026-10-14）：唤醒后主动回收跨越休眠的在飞请求。
 *
 * 事故 20261014-110202-8c0ffb30：请求在休眠前 0–15s 发出，休眠中 socket 被杀，唤醒后
 * 43–69s 才报 `Connection error`。修法：观测器确认休眠 → 只中断「发起早于休眠」的 attempt →
 * 固定 2s 后重开，不计重试次数、不退避、availability 不记失败。
 *
 * 休眠用「把系统时钟拨快 181s 再记账」模拟：账本的 sleepStartedAt = 现在 − 休眠时长，
 * 与真实唤醒时观测器看到的挂钟形态一致。
 */

import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import { getSleepLedger, __resetSleepLedgerForTest } from "@sid-code/shared/utils/sleep-detect.ts";

const PARAMS = { model: "m1", messages: [], maxTokens: 500 } as unknown as SendParams;
const SLEPT_MS = 181_000;

async function* okStream(): AsyncGenerator<StreamEvent> {
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield { type: "message_stop" } as any;
}

/** 首次 attempt 永不返回（只响应 abort），之后正常 */
function hangThenOk(onFirstStarted: () => void) {
  const starts: number[] = [];
  const provider: any = {
    name: () => "openai",
    sendMessageStream: (_p: SendParams, signal?: AbortSignal) => {
      // performance.now：setSystemTime 会冻结 Date.now，量真实等待只能用单调时钟
      starts.push(performance.now());
      if (starts.length > 1) return okStream();
      return (async function* (): AsyncGenerator<StreamEvent> {
        onFirstStarted();
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })();
    },
  };
  return { provider, starts };
}

function makeFb(events: RetryTelemetryEvent[], availability: ModelAvailabilityService) {
  return new ModelFallback({
    availability,
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    maxRetries: 3,
    streamTimeoutMs: 300_000,
    onTelemetry: (e) => events.push(e),
  });
}

async function drain(fb: ModelFallback, provider: any): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
    querySource: "agent:builtin",
    switchMode: "auto",
  } as any))
    out.push(e);
  return out;
}

afterEach(() => {
  setSystemTime();
  __resetSleepLedgerForTest();
});

describe("C1 — 唤醒回收跨越休眠的在飞请求", () => {
  test("attempt 发起于休眠前：被 host_sleep_reopen 中断，约 2s 后重开成功，重试计数 0", async () => {
    const events: RetryTelemetryEvent[] = [];
    const availability = new ModelAvailabilityService();
    const { provider, starts } = hangThenOk(() => {
      setTimeout(() => {
        // 唤醒：挂钟跳 181s，观测器记账（tick 迟到 = 休眠）
        setSystemTime(new Date(Date.now() + SLEPT_MS));
        getSleepLedger().record(SLEPT_MS + 5_000, 5_000);
      }, 20);
    });

    const out = await drain(makeFb(events, availability), provider);

    expect(starts.length).toBe(2);
    // 固定 2s「网络就绪」等待（不是指数退避，也不是 0）
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_950);
    expect(starts[1]! - starts[0]!).toBeLessThan(4_000);
    const reopen = events.filter((e) => e.type === "host_sleep_reopen");
    expect(reopen).toHaveLength(1);
    expect(reopen[0]!.sleptMs).toBe(SLEPT_MS);
    expect(reopen[0]!.reopenReason).toBe("host_sleep");
    // 不计重试、不放弃、availability 无失败记录
    expect(events.filter((e) => e.type === "retry")).toHaveLength(0);
    expect(events.filter((e) => e.type === "recovery_give_up")).toHaveLength(0);
    expect(availability.isSuspect("m1")).toBe(false);
    expect(availability.getCooldownRemaining("m1")).toBe(0);
    expect(out.some((e) => e.type === "stream_restart" && e.reason === "host_sleep")).toBe(true);
    expect(out.some((e) => e.type === "content_block_delta")).toBe(true);
  }, 10_000);

  test("反例：attempt 发起于休眠之后 → 唤醒回调不中断它", async () => {
    const events: RetryTelemetryEvent[] = [];
    let release!: () => void;
    const provider: any = {
      name: () => "openai",
      sendMessageStream: (_p: SendParams, signal?: AbortSignal) =>
        (async function* (): AsyncGenerator<StreamEvent> {
          // 本次 attempt 刚发起；此刻记一笔「181s 前开始、刚刚结束」的休眠 ——
          // sleepStartedAt = now − 181s，早于 attempt，故不得中断。
          getSleepLedger().record(SLEPT_MS + 5_000, 5_000);
          // record 内同步回调可能已 abort —— 先查 aborted，否则下面的 listener 永远等不到
          if (signal?.aborted) throw signal.reason;
          // 必须响应 abort：否则误中断也看不出来（变异自证曾因此空集全绿）
          await new Promise<void>((r, reject) => {
            release = r;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          yield* okStream();
        })(),
    };
    const p = drain(makeFb(events, new ModelAvailabilityService()), provider);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const out = await p;
    expect(events.filter((e) => e.type === "host_sleep_reopen")).toHaveLength(0);
    expect(out.some((e) => e.type === "stream_restart")).toBe(false);
  });
});
