/**
 * P2-1（PR #566 review 发现）：真实 ModelFallback 集成 —— 消费方放弃后，
 * provider 生成器的 finally 必须执行、BilledRequest 必须写出、活跃 lifecycle 计数回基线。
 *
 * ## 为什么必须用**真实** ModelFallback
 *
 * `stream-lifecycle-abandon.test.ts` 的形态 B 用的是手写 `raceIterate(provider())` 模拟漏斗，
 * 它只证明「raceIterate + throw」这条链自洽，**不证明 `fallback.ts` 自己的接线
 *（`raceIterate(stream, {...})`）真的走了这条路**。方案 §1.6 第 3 条明确要求
 * 「集成：fallback.ts + 假 provider」。
 *
 * ## 断言口径
 *
 * 不是「没报错」，而是四个可证伪的事实：
 *   - provider 生成器 finally 执行（每次 attempt 一次）
 *   - 源头生成器 finally 执行（lifecycle 的 return() 一路传到底）
 *   - lifecycle 自己收尾（stream_completed 与 provider finally 次数一致）
 *   - BilledRequest 写出且 usage 等于流内 message_delta 带的值（不是 0）
 *   - 活跃 lifecycle 计数回到基线（没有生成器被永久丢弃）
 *
 * fix_type: regression
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import {
  createStreamLifecycle,
  getActiveStreamLifecycleCount,
} from "@sid-code/core/llm/stream-lifecycle.ts";
import {
  recordBilledRequest,
  addBillingObserver,
  nextFetchId,
} from "@sid-code/core/llm/billing-sink.ts";
import type { BilledRequest } from "@sid-code/core/llm/billing-sink.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent, Usage } from "@sid-code/core/llm/types.ts";

const BASE_PARAMS: SendParams = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

describe("P2-1 真实漏斗集成：消费方放弃后 provider finally 与计费必须执行", () => {
  let billed: BilledRequest[];
  let unregisterBillingObserver: () => void;
  beforeEach(() => {
    billed = [];
    unregisterBillingObserver = addBillingObserver((r) => billed.push(r));
  });
  afterEach(() => unregisterBillingObserver());

  test("假 provider yield error 后挂住：ModelFallback 放弃，provider/lifecycle finally 执行、BilledRequest 写出、活跃计数回基线", async () => {
    const baseline = getActiveStreamLifecycleCount();
    const failedUsage: Usage = { inputTokens: 1000, outputTokens: 50 };
    const counters = { providerFinalized: 0, sourceFinalized: 0, streamCompleted: 0 };

    // 假 provider：内部建真实 lifecycle（与 openai.ts / anthropic.ts 同构）。
    // 先给 content + 带 usage 的 message_delta（真实链路 response.failed 也先发这个），
    // 再给 error 事件，然后永不产出（SSE 半开）。finally 里做计费收口 ——
    // 与真实 provider 的 finally 同一位置，这是 F5 成立的前提。
    const provider: Provider = {
      name: () => "mock",
      sendMessageStream: () => {
        const source = async function* (): AsyncGenerator<StreamEvent> {
          try {
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hello" },
            };
            yield {
              type: "message_delta",
              delta: { stop_reason: null },
              usage: failedUsage,
            };
            yield { type: "error", error: { message: "Response failed" } };
            await new Promise(() => {});
          } finally {
            counters.sourceFinalized++;
          }
        };
        const lc = createStreamLifecycle<StreamEvent>({
          idleTimeoutMs: 60_000,
          label: "MOCK-PROVIDER",
          cancelSource: () => {},
          onTelemetry: (e) => {
            if (e.type === "stream_completed") counters.streamCompleted++;
          },
        });
        return (async function* (): AsyncGenerator<StreamEvent> {
          let accumulatedUsage: Usage | undefined;
          try {
            for await (const ev of lc.guard(source())) {
              if (ev.type === "message_delta") accumulatedUsage = ev.usage;
              yield ev;
            }
          } finally {
            counters.providerFinalized++;
            recordBilledRequest({
              fetchId: nextFetchId(),
              model: "test-model",
              provider: "mock",
              usage: accumulatedUsage ?? { inputTokens: 0, outputTokens: 0 },
              index: 1,
              accounted: true,
            });
          }
        })();
      },
    };

    const fallback = new ModelFallback({
      maxRetries: 1,
      maxRetriesPerCall: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
      availability: new ModelAvailabilityService(),
      // 关掉非流式降级：假 provider 没有实现它，且本用例只验证流式路径的收尾。
      allowNonStreamingFallback: false,
    });

    // 消费漏斗：两次 attempt 都失败后放弃。放弃出口允许 throw，本用例只断言资源收尾。
    try {
      for await (const _ev of fallback.executeWithFallback(provider, BASE_PARAMS)) {
        /* drain */
      }
    } catch {
      /* 放弃出口（无 fallbackProvider 时 tryFallback 抛错） */
    }
    // return() 是「发出但不 await」的（见 race-iterate.ts 文件头），让微任务跑干。
    await new Promise((r) => setTimeout(r, 0));

    // ① 每次 attempt 的 provider 生成器 finally 都执行了（不是「一次都没跑」）。
    expect(counters.providerFinalized).toBeGreaterThanOrEqual(1);
    // ② 源头生成器的 finally 也执行了（lifecycle 的 return() 一路传到底）。
    expect(counters.sourceFinalized).toBe(counters.providerFinalized);
    // ③ lifecycle 自己收尾（stream_completed 次数与 provider finally 一致）。
    expect(counters.streamCompleted).toBe(counters.providerFinalized);
    // ④ 计费写出，且 usage 等于流内 message_delta 带的值 —— 写成 0 等于「记了一条但金额丢了」。
    expect(billed.length).toBe(counters.providerFinalized);
    expect(billed[0]!.usage).toEqual(failedUsage);
    // ⑤ 活跃 lifecycle 计数回到基线（没有生成器被永久丢弃）。
    expect(getActiveStreamLifecycleCount()).toBe(baseline);
  });
});
