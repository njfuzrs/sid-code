/**
 * PR4 + PR6 回归：「用户到底丢了多少内容」的度量口径
 *
 * ## 这组测试要钉住的事实（实测，不是推演）
 *
 * 会话 `20260817-135824-fcf863e1`：24 次超时重开，消费方侧的丢弃日志只留下 **2** 条。
 * 差额不是漏记，是**竞态**：`fallback.ts` 要先睡 4.3~5.7s 退避才 `yield stream_restart`，
 * 而 `loop.ts` 的 watchdog 在 56~163ms 内就把生成器杀了 —— 那句作废广播根本执行不到。
 * 所以「消费方视角」结构性地只能看到 8%，必须再有一个**传输层视角**做对照。
 *
 * 于是丢弃量有两个互补口径，本文件两边都锁：
 *   - 消费方（PR4）：`StreamRestart` 事件 —— 无条件发，含零丢弃，**分母**由它成立
 *   - 传输层（PR6）：`retry` 遥测的 `discardedChars` —— 在退避**之前**发，不被 watchdog 抢掉
 *
 * ## 为什么必须区分"思考字符"
 *
 * GLM/DeepSeek 的 `reasoning_content` 在 provider 层被转成
 * `content_block_start{type:"text", _raw_block:{type:"thinking"}}` + text_delta，
 * 只有 `content_block_stop` 到达后才被就地转型成 thinking 块。
 * **流被掐死在思考中途时那个 stop 永远不会来** —— 只看 `block.type` 会把它算成普通文本。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { resetOnStreamRestart, recordStreamRestart } from "@sid-code/core/llm/stream-restart.ts";
import { initStreamObserver, resetStreamObserver } from "@sid-code/core/trace/stream-observer.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";

import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";

const RESTART: Extract<StreamEvent, { type: "stream_restart" }> = {
  type: "stream_restart",
  reason: "fallback_stream_timeout",
  attempt: 1,
};

describe("PR4 消费方口径：思考字符必须与普通文本分开计", () => {
  test("被掐死在思考中途（无 content_block_stop，块的 type 仍停在 text）也能算出思考字符", () => {
    // 这正是 GLM 线上 23/24 次掐断的形态：块还没成形，type 是 "text"。
    // 唯一能证明"它是思考"的是 thinkingIndexes —— 光看 block.type 必然算错。
    const content: unknown[] = [{ type: "text", text: "思".repeat(1000) }];
    const out = resetOnStreamRestart({
      content,
      indexToPosition: new Map([[0, 0]]),
      thinkingIndexes: new Set([0]),
    });

    expect(out.discardedTextLength).toBe(1000);
    expect(out.discardedThinkingLength).toBe(1000); // 改造前恒 0（这个字段不存在）
  });

  test("思考 + 可见文本混合：思考量是总量的子集，可见文本量 = 差", () => {
    const content: unknown[] = [
      { type: "text", text: "think".repeat(100) }, // 500 字符思考（未成形）
      { type: "text", text: "hello" }, // 5 字符可见文本
    ];
    const out = resetOnStreamRestart({
      content,
      indexToPosition: new Map([
        [0, 0],
        [1, 1],
      ]),
      thinkingIndexes: new Set([0]),
    });

    expect(out.discardedTextLength).toBe(505);
    expect(out.discardedThinkingLength).toBe(500);
    expect(out.discardedTextLength - out.discardedThinkingLength).toBe(5); // 用户屏幕上真被撤回的
  });

  test("已成形的 thinking 块（自描述 type）无需 thinkingIndexes 也能识别", () => {
    const out = resetOnStreamRestart({ content: [{ type: "thinking", thinking: "ab" }] });
    expect(out.discardedThinkingLength).toBe(2);
  });

  test("被截断的工具入参 JSON 残片纳入统计（改造前完全不可观测）", () => {
    // 改造前的形态：discardedBlocks=1 / discardedTextLength=0，看起来像"没丢什么"，
    // 实际丢的是一串已经拼了一半的工具入参。
    const frag = '{"file_path":"/a/b.ts","old_str';
    const out = resetOnStreamRestart({
      content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }],
      jsonAccumulators: new Map([[0, frag]]),
    });

    expect(out.discardedTextLength).toBe(0);
    expect(out.discardedToolJsonLength).toBe(frag.length);
    expect(out.discardedToolJsonLength).toBeGreaterThan(0); // 改造前恒不可见
  });

  test("负向对照：没传 thinkingIndexes 的消费者拿到 0 —— 是'无区分能力'，不是'没丢思考'", () => {
    // 子代理 / forked / 无头三条路径都只传 content + jsonAccumulators。
    // 锁死这个行为是为了让读数字的人知道 0 的含义（注释里已写明，这里用测试钉住）。
    const out = resetOnStreamRestart({ content: [{ type: "text", text: "x".repeat(50) }] });
    expect(out.discardedTextLength).toBe(50);
    expect(out.discardedThinkingLength).toBe(0);
  });
});

describe("PR4 分母：StreamRestart 事件必须无条件落盘", () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];

  afterEach(() => resetStreamObserver());

  function startCapture() {
    events.length = 0;
    initStreamObserver("test-session", "/tmp/nonexistent", (e) =>
      events.push(e as { event: string; data: Record<string, unknown> }),
    );
  }

  test("零丢弃的重开也发事件 —— 没有它就没有分母", () => {
    // 铁律「分母比分子重要」：只有分子时，"丢弃变少了"既可能是修复生效，
    // 也可能只是重开次数变少了，两者结论完全相反。
    startCapture();
    recordStreamRestart(RESTART, resetOnStreamRestart({}), "main");

    const restarts = events.filter((e) => e.event === "StreamRestart");
    expect(restarts.length).toBe(1);
    expect(restarts[0]!.data.discarded_chars).toBe(0);
    expect(restarts[0]!.data.discarded_blocks).toBe(0);
  });

  test("有丢弃时字段完整，且按消费者归因", () => {
    startCapture();
    const out = resetOnStreamRestart({
      content: [{ type: "text", text: "z".repeat(700) }],
      indexToPosition: new Map([[0, 0]]),
      thinkingIndexes: new Set([0]),
      jsonAccumulators: new Map([[1, '{"a"']]),
    });
    recordStreamRestart(RESTART, out, "subagent");

    const d = events.find((e) => e.event === "StreamRestart")!.data;
    expect(d.reason).toBe("fallback_stream_timeout");
    expect(d.attempt).toBe(1);
    expect(d.discarded_chars).toBe(700);
    expect(d.discarded_thinking_chars).toBe(700);
    expect(d.discarded_tool_json_chars).toBe(4);
    expect(d.consumer).toBe("subagent");
  });

  test("未初始化观察者时不抛（可观测性绝不能影响流处理主流程）", () => {
    resetStreamObserver();
    expect(() => recordStreamRestart(RESTART, resetOnStreamRestart({}), "main")).not.toThrow();
  });
});

// ─── PR6：传输层口径 ───

const BASE_PARAMS: SendParams = {
  model: "glm-5.3",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

function mockProvider(
  impl: (params: SendParams, signal?: AbortSignal) => AsyncIterable<StreamEvent>,
): Provider {
  return {
    name: () => "mock",
    sendMessageStream: impl,
  } as unknown as Provider;
}

/** 第一次尝试吐 N 字符思考后被超时切断，第二次尝试正常完成 */
function thinkingThenTimeoutProvider(thinkingChars: number) {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    if (calls === 1) {
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
        _raw_block: { type: "thinking" },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "思".repeat(thinkingChars) },
      } as StreamEvent;
      throw new Error(`响应头超时：300s 未收到响应头（model=glm-5.3）`);
    }
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { inputTokens: 1, outputTokens: 1 },
    } as StreamEvent;
    yield { type: "message_stop" } as StreamEvent;
  });
  return { provider, callCount: () => calls };
}

async function drain(gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeFallback(sink: RetryTelemetryEvent[]) {
  return new ModelFallback({
    maxRetries: 2,
    streamTimeoutMs: 5000,
    // 退避压到 1ms：本用例真会走一次流阶段重试，吃生产 5s 基数会与测试超时打平。
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 5,
    availability: new ModelAvailabilityService(),
    onTelemetry: (e) => sink.push(e),
  });
}

describe("PR6 传输层口径：重试决策必须看得见'已产出多少'", () => {
  test("已吐 N 字符思考后被切断 → retry 遥测带上 discardedChars / discardedThinkingChars", () => {
    // 验收判据①：重试决策**读到**"已产出 N 字符"这个事实。
    // 改造前这一层只有一个 `hasYieldedContent` bool，且只用于空响应校验、
    // 不参与任何重试决策 —— 所以"丢弃"是它的默认行为，且不可能被它自己发现。
    return (async () => {
      const telemetry: RetryTelemetryEvent[] = [];
      const { provider, callCount } = thinkingThenTimeoutProvider(2000);
      await drain(makeFallback(telemetry).executeWithFallback(provider, BASE_PARAMS));

      expect(callCount()).toBe(2); // 确实重试了

      const retry = telemetry.find((e) => e.type === "retry" && e.phase === "stream");
      expect(retry).toBeDefined();
      expect(retry!.discardedChars).toBe(2000);
      // 验收判据②：思考量单独可见 —— 这是"用户丢了多少思考"的唯一答案
      expect(retry!.discardedThinkingChars).toBe(2000);
    })();
  });

  test("负向对照：真正零产出的 attempt 仍照常重试，且不误报丢弃量", async () => {
    // 验收判据③：别把重试关死。零产出重试是**正确**行为（网关空响应正靠它恢复）。
    const telemetry: RetryTelemetryEvent[] = [];
    let calls = 0;
    const provider = mockProvider(async function* () {
      calls++;
      if (calls === 1) throw new Error(`响应头超时：300s 未收到响应头（model=glm-5.3）`);
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      } as StreamEvent;
      yield { type: "message_stop" } as StreamEvent;
    });

    await drain(makeFallback(telemetry).executeWithFallback(provider, BASE_PARAMS));

    expect(calls).toBe(2); // 照常重试
    const retry = telemetry.find((e) => e.type === "retry" && e.phase === "stream");
    expect(retry!.discardedChars).toBe(0);
    expect(retry!.discardedThinkingChars).toBe(0);
  });

  test("计数不跨 attempt 累加（重置漏一个字段就会污染下一次的数字）", async () => {
    // 三个"本次 attempt 产出状态"必须同生同灭。分开重置迟早漏一个，
    // 而漏掉的那个会让下一次 attempt 带着上一次的计数 —— 最难查的那种脏数据。
    const telemetry: RetryTelemetryEvent[] = [];
    let calls = 0;
    const provider = mockProvider(async function* () {
      calls++;
      if (calls <= 2) {
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
          _raw_block: { type: "thinking" },
        } as StreamEvent;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "x".repeat(100) },
        } as StreamEvent;
        throw new Error(`响应头超时：300s 未收到响应头（model=glm-5.3）`);
      }
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      } as StreamEvent;
      yield { type: "message_stop" } as StreamEvent;
    });

    await drain(makeFallback(telemetry).executeWithFallback(provider, BASE_PARAMS));

    const retries = telemetry.filter((e) => e.type === "retry" && e.phase === "stream");
    expect(retries.length).toBe(2);
    // 两次都是 100，不是 100 然后 200 —— 后者说明重置没生效
    expect(retries.map((r) => r.discardedChars)).toEqual([100, 100]);
    expect(retries.map((r) => r.discardedThinkingChars)).toEqual([100, 100]);
  });
});
