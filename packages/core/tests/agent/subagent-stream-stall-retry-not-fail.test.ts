/**
 * 子代理流卡死 → 漏斗重试 → 交付，不得被 processStream 自带的旧超时标志判死。
 *
 * 事故 20261016-224545-2abd6202：3 个 explore 子代理同时撞上游卡顿。
 *   14:52:29 `agent_heartbeat_timeout`(idle 60s) 只置标志、连接没断（getAbortController 零调用方）；
 *   14:54:28 漏斗 180s 真正断流并发起 `attempt=1` 重试；
 *   4–8ms 后 `SubagentStop status=error` × 3。
 * 机理：重试流的首个事件到达 `lifecycle.guard()` 时 `snapshot.timedOut` 早已置位 →
 * `stream-lifecycle.ts` 的 `if (snapshot.timedOut) break` → 循环结束后 `if (timeoutError)`
 * 返回 stopReason="error" → agentic-loop 判 success:false。主循环同一时刻重试成功。
 *
 * 修复：子代理 processStream 不再挂 idle / overall lifecycle，超时只由漏斗负责（漏斗 abort 后重试）。
 *
 * 场景构造（等比例缩小）：第 1 次尝试吐出部分内容后静默 300ms，再以可重试错误结束
 * （等价于漏斗断流），漏斗重试，第 2 次尝试正常交付。旧阈值按比例压到 idle 50ms / overall 100ms，
 * 以 `as any` 传给已删除的 `streamIdleTimeoutMs/streamOverallTimeoutMs`：
 *   - 修复后：这两个字段已无读者 → 不生效 → 交付。
 *   - 变异自证：恢复被删的 lifecycle 包装 + `onTimeout` 置 `timeoutError`（连同这两个字段的透传）
 *     → 静默 300ms 期间 idle 开火置标志 → 重试流被 guard 截断 → 本测试红。
 *     ⛔ 只加回循环体内的 `if (timeoutError)` 不构成有效变异：本路径上事件根本进不了循环体。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { processStream } from "@sid-code/core/agent/stream-processor.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent, SendParams } from "@sid-code/core/llm/types.ts";
import {
  setRetryTelemetryObserver,
  type RetryTelemetryEvent,
} from "@sid-code/core/llm/retry-telemetry.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 第 1 次尝试：吐出部分内容 → 静默 → 断流（与漏斗 abort 后看到的形态一致：可重试连接错误） */
async function* stallThenDrop(silenceMs: number): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "半截" },
  } as any;
  await sleep(silenceMs);
  throw new Error("Connection error.");
}

async function* ok(text: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 5 },
  } as any;
}

function makeProvider(scripted: Array<(p: SendParams) => AsyncIterable<StreamEvent>>) {
  let calls = 0;
  const provider = {
    name: () => "openai",
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

function config(provider: Provider) {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("你是代码核查助手");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "核查 permissions.md" }] });
  return {
    provider,
    model: "glm-5.3-uniapi",
    ctxMgr,
    tools: new ToolRegistry(),
    maxTurns: 3,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    availability: noCooldownAvailability(),
    permissionChecker: undefined,
    maxStreamRetries: 10,
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    // 旧 L6 档位（idle 60s / overall 180s）按比例缩小。修复后无读者，见文件头。
    streamIdleTimeoutMs: 50,
    streamOverallTimeoutMs: 100,
  } as any;
}

const telemetry: RetryTelemetryEvent[] = [];
beforeEach(() => {
  telemetry.length = 0;
  setRetryTelemetryObserver((e: RetryTelemetryEvent) => telemetry.push(e));
});
afterEach(() => setRetryTelemetryObserver(null));

describe("事故 20261016-224545 — 子代理流卡死改为重试而非判死", () => {
  test("T1：第 1 次尝试静默后断流 → 漏斗重试 → 第 2 次交付，子代理 success", async () => {
    const { provider, calls } = makeProvider([
      () => stallThenDrop(300),
      () => ok("核查完成：3 处与源码不符"),
    ]);
    const result = await runAgentLoop(config(provider));

    // 前提成立：真的发生了重试（否则证明不了「重试没被判死」）
    expect(calls()).toBe(2);
    expect(result.retryAttempts ?? 0).toBeGreaterThanOrEqual(1);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("核查完成");
    // 重开前的半截内容必须被 stream_restart 作废，不得拼进交付
    expect(result.lastTextOutput).not.toContain("半截");
    expect(result.errorMessage ?? "").not.toMatch(/heartbeat timeout|overall timeout/);
  }, 20_000);

  test("processStream 自身不再判超时：长静默之后的事件照常消费", async () => {
    async function* slowButAlive(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        message: { usage: { inputTokens: 1, outputTokens: 0 } },
      } as any;
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
      await sleep(200);
      yield* (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "到了" },
        } as any;
        yield { type: "content_block_stop", index: 0 } as any;
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { outputTokens: 1 },
        } as any;
      })();
    }
    const res = await processStream(slowButAlive(), {
      // 旧签名里的超时字段：修复后不再有读者
      heartbeatTimeoutMs: 20,
      firstByteTimeoutMs: 20,
      overallTimeoutMs: 50,
    } as any);
    expect(res.stopReason).toBe("end_turn");
    expect(res.content[0]).toEqual({ type: "text", text: "到了" });
  }, 10_000);

  test("ESC / 父代理取消仍能穿透（B1 纵深防御保留）", async () => {
    const ctl = new AbortController();
    async function* forever(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        message: { usage: { inputTokens: 1, outputTokens: 0 } },
      } as any;
      ctl.abort();
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
    }
    const res = await processStream(forever(), { signal: ctl.signal });
    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toBe("Request aborted");
  });
});
