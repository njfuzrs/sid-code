/**
 * T14.7：流式全链路 Trace + TTFT 持久化单测
 * 覆盖：
 *  - StreamLifecycle onFirstContentProgress 回调（T14.6 统一层内置 first_content）
 *  - stream-observer first_content StreamPhase emit（T14.3）
 *  - digest TTFT P50/P95/P99 聚合 + >30s warning（T14.5）
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { streamLifecycle } from "@sid-code/core/llm/stream-lifecycle.ts";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
} from "@sid-code/core/trace/stream-observer.ts";
import { aggregateProviderStats } from "@sid-code/core/trace/digest.ts";

// ─── 辅助：把数组转成异步流，可注入首事件延迟 ───
async function* asyncFrom<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
  for (const item of items) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}

describe("T14.6: StreamLifecycle onFirstContentProgress 回调", () => {
  test("首个 first-content 事件触发回调一次（幂等）", async () => {
    const ttfts: number[] = [];
    const events = [
      { type: "message_start" },
      { type: "content_block_start" },
      { type: "content_block_delta" }, // ← 首个真实内容
      { type: "content_block_delta" }, // 第二个不应再触发
      { type: "message_delta" },
    ];

    const out: any[] = [];
    for await (const ev of streamLifecycle(asyncFrom(events), {
      idleTimeoutMs: 10_000,
      label: "TEST",
      isFirstContent: (e: any) => e.type === "content_block_delta",
      onFirstContentProgress: (ttft) => ttfts.push(ttft),
    })) {
      out.push(ev);
    }

    // 全部事件都被 yield（行为等价）
    expect(out.length).toBe(5);
    // first-content 回调只触发一次
    expect(ttfts.length).toBe(1);
    expect(ttfts[0]).toBeGreaterThanOrEqual(0);
  });

  test("isFirstContent 不传则回退 isContentProgress", async () => {
    const ttfts: number[] = [];
    const events = [
      { type: "message_start" },
      { type: "content_block_delta" },
    ];

    for await (const _ of streamLifecycle(asyncFrom(events), {
      idleTimeoutMs: 10_000,
      contentProgressTimeoutMs: 10_000,
      label: "TEST",
      isContentProgress: (e: any) => e.type === "content_block_delta",
      onFirstContentProgress: (ttft) => ttfts.push(ttft),
    })) {
      // consume
    }

    expect(ttfts.length).toBe(1);
  });

  test("requestStartTimeMs 作为 TTFT 基准（含首事件延迟）", async () => {
    const ttfts: number[] = [];
    const baseTime = Date.now();
    // 首事件延迟 50ms
    const events = [{ type: "content_block_delta" }];

    for await (const _ of streamLifecycle(asyncFrom(events, 50), {
      idleTimeoutMs: 10_000,
      label: "TEST",
      isFirstContent: (e: any) => e.type === "content_block_delta",
      requestStartTimeMs: baseTime,
      onFirstContentProgress: (ttft) => ttfts.push(ttft),
    })) {
      // consume
    }

    expect(ttfts.length).toBe(1);
    // TTFT 应至少覆盖 50ms 延迟
    expect(ttfts[0]).toBeGreaterThanOrEqual(45);
  });

  test("无 first-content 事件时回调不触发", async () => {
    const ttfts: number[] = [];
    const events = [{ type: "message_start" }, { type: "ping" }];

    for await (const _ of streamLifecycle(asyncFrom(events), {
      idleTimeoutMs: 10_000,
      label: "TEST",
      isFirstContent: (e: any) => e.type === "content_block_delta",
      onFirstContentProgress: (ttft) => ttfts.push(ttft),
    })) {
      // consume
    }

    expect(ttfts.length).toBe(0);
  });
});

describe("T14.3: stream-observer first_content StreamPhase emit", () => {
  let captured: Array<{ event: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    captured = [];
    initStreamObserver("test-session", "/tmp/test-session", (ev) => {
      captured.push({ event: ev.event, data: ev.data });
    });
  });

  afterEach(() => {
    resetStreamObserver();
  });

  test("emitStreamPhase first_content 写入 events + ttft_ms", () => {
    emitStreamPhase(42, "first_content", { ttft_ms: 1234, model: "deepseek-chat" });

    const phases = captured.filter((e) => e.event === "StreamPhase");
    const firstContent = phases.find((e) => e.data.phase === "first_content");
    expect(firstContent).toBeDefined();
    expect(firstContent!.data.index).toBe(42);
    expect(firstContent!.data.ttft_ms).toBe(1234);
    expect(firstContent!.data.model).toBe("deepseek-chat");
  });

  test("end-to-end: lifecycle 回调驱动 emitStreamPhase", async () => {
    const events = [{ type: "message_start" }, { type: "content_block_delta" }];
    const obsIndex = 7;

    for await (const _ of streamLifecycle(asyncFrom(events), {
      idleTimeoutMs: 10_000,
      label: "TEST",
      isFirstContent: (e: any) => e.type === "content_block_delta",
      onFirstContentProgress: (ttft) => {
        emitStreamPhase(obsIndex, "first_content", { ttft_ms: ttft, model: "test-model" });
      },
    })) {
      // consume
    }

    const firstContent = captured
      .filter((e) => e.event === "StreamPhase")
      .find((e) => e.data.phase === "first_content" && e.data.index === obsIndex);
    expect(firstContent).toBeDefined();
    expect(typeof firstContent!.data.ttft_ms).toBe("number");
  });
});

describe("T14.5: digest TTFT P50/P95/P99 聚合", () => {
  test("按 provider 分组输出 TTFT 分位数", () => {
    // P0-1：TTFT 现取自 StreamPhase("first_content")（纯净首内容延迟），不再从 AfterModelRaw.ttft_ms 取
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      { event: "AfterModelRaw", data: { provider: "openai", model: "deepseek-chat", elapsed_ms: 2000 } },
    ];
    for (let i = 0; i < 100; i++) {
      events.push({
        event: "StreamPhase",
        data: { phase: "first_content", model: "deepseek-chat", ttft_ms: (i + 1) * 100 },
      });
    }

    const stats = aggregateProviderStats(events);
    const openai = stats.find((s) => s.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.ttft_p50).toBeGreaterThan(0);
    expect(openai!.ttft_p95).toBeGreaterThan(openai!.ttft_p50!);
    expect(openai!.ttft_p99).toBeGreaterThanOrEqual(openai!.ttft_p95!);
  });

  test("TTFT P95 > 30s 标记 warning", () => {
    // 全部 40s TTFT（first_content 源）
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      { event: "AfterModelRaw", data: { provider: "anthropic", model: "claude-3.5-sonnet", elapsed_ms: 45000 } },
    ];
    for (let i = 0; i < 10; i++) {
      events.push({
        event: "StreamPhase",
        data: { phase: "first_content", model: "claude-3.5-sonnet", ttft_ms: 40000 },
      });
    }

    const stats = aggregateProviderStats(events);
    const anthropic = stats.find((s) => s.provider === "anthropic");
    expect(anthropic!.warning).toBeDefined();
    expect(anthropic!.warning).toContain("TTFT P95");
    expect(anthropic!.warning).toContain("> 30s");
  });

  test("无 TTFT 数据时分位数为 undefined", () => {
    const events = [
      { event: "AfterModelRaw", data: { provider: "ollama", elapsed_ms: 1000 } },
    ];
    const stats = aggregateProviderStats(events);
    const ollama = stats.find((s) => s.provider === "ollama");
    expect(ollama!.ttft_p50).toBeUndefined();
    expect(ollama!.ttft_p99).toBeUndefined();
  });

  // P0-1 回归（排查报告 Bug A）：TTFT 必须来自 first_content，AfterModelRaw.ttft_ms 被彻底忽略。
  // 固化"不再被可视文本延迟 + 重试双重污染"这一修复，防止回退。
  test("AfterModelRaw.ttft_ms 被忽略，TTFT 只认 first_content（Bug A 回归）", () => {
    const events = [
      // AfterModelRaw 携带被污染的巨大 ttft_ms（模拟 idx=15 的 102s 合成值）——必须被忽略
      { event: "AfterModelRaw", data: { provider: "openai", model: "glm-5.2", elapsed_ms: 104000, ttft_ms: 102300 } },
      // first_content 携带真实首 token 延迟 6.7s——这才是应被采纳的值
      { event: "StreamPhase", data: { phase: "first_content", model: "glm-5.2", ttft_ms: 6700 } },
    ];
    const stats = aggregateProviderStats(events);
    const openai = stats.find((s) => s.provider === "openai");
    expect(openai).toBeDefined();
    // TTFT 取自 first_content（6700），绝不是 AfterModelRaw 的 102300
    expect(openai!.ttft_p50).toBe(6700);
    expect(openai!.ttft_p50).not.toBe(102300);
    // 整轮均耗仍来自 AfterModelRaw.elapsed_ms（104s）——两个口径分离
    expect(openai!.avgLatencyMs).toBe(104000);
  });

  // P0-1：新增生成耗时分位（RetryTelemetry.stream_completed.elapsedMs），让"慢在生成"显式可见
  test("生成耗时分位取自 RetryTelemetry stream_completed", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      { event: "AfterModelRaw", data: { provider: "openai", model: "glm-5.2", elapsed_ms: 60000 } },
    ];
    for (let i = 0; i < 20; i++) {
      events.push({
        event: "RetryTelemetry",
        data: { type: "stream_completed", provider: "openai", model: "glm-5.2", elapsedMs: (i + 1) * 5000 },
      });
    }
    const stats = aggregateProviderStats(events);
    const openai = stats.find((s) => s.provider === "openai");
    expect(openai!.gen_p50).toBeGreaterThan(0);
    expect(openai!.gen_p95).toBeGreaterThan(openai!.gen_p50!);
    expect(openai!.gen_p99).toBeGreaterThanOrEqual(openai!.gen_p95!);
  });
});

/**
 * P2-3：TTFT 按缓存命中分桶。
 *
 * 为什么需要分桶：总体 ttft_p50 把命中与未命中混在一起平均，"缓存让首字快了多少"
 * 在里面看不出来 —— 而这正是博客要引用的核心数字。
 *
 * 为什么配对必须保守：TTFT 是 per-fetch、usage 是 per-turn，共享的 index 是 1:N
 *（实测同会话 index=3 有 6 条 first_content 但只有 1 条 AfterModelRaw）。
 * 按 index 硬关联会把一次命中的 usage 摊给同轮所有 fetch，得出的"命中组 TTFT"是假的。
 */
describe("P2-3 TTFT 缓存分桶", () => {
  const afterModel = (provider: string, model: string) =>
    ({ event: "AfterModelRaw", data: { provider, model, elapsed_ms: 1000 } });

  test("Anthropic：first_content 自带 cache_hit，直接分桶（无需配对）", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      afterModel("anthropic", "claude-opus-5"),
      // 命中组明显更快
      { event: "StreamPhase", data: { phase: "first_content", model: "claude-opus-5", ttft_ms: 800, cache_hit: true, cache_read: 17152 } },
      { event: "StreamPhase", data: { phase: "first_content", model: "claude-opus-5", ttft_ms: 900, cache_hit: true, cache_read: 17000 } },
      // 未命中组慢
      { event: "StreamPhase", data: { phase: "first_content", model: "claude-opus-5", ttft_ms: 4000, cache_hit: false, cache_read: 0 } },
    ];
    const s = aggregateProviderStats(events).find((x) => x.provider === "anthropic")!;
    expect(s.ttftByCache).toBeDefined();
    expect(s.ttftByCache!.hit.count).toBe(2);
    expect(s.ttftByCache!.miss.count).toBe(1);
    expect(s.ttftByCache!.hit.p50!).toBeLessThan(s.ttftByCache!.miss.p50!);
    expect(s.ttftBucketDropped).toBeUndefined();
  });

  test("OpenAI 族：ttft 在 first_content、cache_hit 在 completed，同组按序配对", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      afterModel("openai", "gpt-5.6-luna"),
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 700, index: 3, session_id: "s1" } },
      { event: "StreamPhase", data: { phase: "completed", model: "gpt-5.6-luna", index: 3, session_id: "s1", cache_hit: true, cache_read: 17152 } },
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 5000, index: 4, session_id: "s1" } },
      { event: "StreamPhase", data: { phase: "completed", model: "gpt-5.6-luna", index: 4, session_id: "s1", cache_hit: false, cache_read: 0 } },
    ];
    const s = aggregateProviderStats(events).find((x) => x.provider === "openai")!;
    expect(s.ttftByCache!.hit).toEqual({ count: 1, p50: 700, p95: 700 });
    expect(s.ttftByCache!.miss).toEqual({ count: 1, p50: 5000, p95: 5000 });
  });

  test("数量不等的组整组丢弃并计数，绝不猜配（错配会反转结论）", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      afterModel("openai", "gpt-5.6-luna"),
      // 同一 (session,index) 下 3 次 first_content 但只有 1 次 completed
      //（另两次超时/abort，没走到 completed）
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 700, index: 3, session_id: "s1" } },
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 6000, index: 3, session_id: "s1" } },
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 9000, index: 3, session_id: "s1" } },
      { event: "StreamPhase", data: { phase: "completed", model: "gpt-5.6-luna", index: 3, session_id: "s1", cache_hit: true } },
    ];
    const s = aggregateProviderStats(events).find((x) => x.provider === "openai")!;
    // 一条都不进桶：若按序取首条会把 700ms 记成"命中"，凭空造出一个漂亮的提速数字
    expect(s.ttftByCache).toBeUndefined();
    expect(s.ttftBucketDropped).toBe(3);
    // 总体 TTFT 不受影响（分桶失败不该丢掉总体口径）
    expect(s.ttft_p50).toBeGreaterThan(0);
  });

  test("子代理与主循环不混配（分组键含 agent_id）", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      afterModel("openai", "gpt-5.6-luna"),
      // 主循环与子代理共享 index=3，但命中状态相反
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 700, index: 3, session_id: "s1" } },
      { event: "StreamPhase", data: { phase: "completed", model: "gpt-5.6-luna", index: 3, session_id: "s1", cache_hit: true } },
      { event: "StreamPhase", data: { phase: "first_content", model: "gpt-5.6-luna", ttft_ms: 5000, index: 3, session_id: "s1", agent_id: "sub-1" } },
      { event: "StreamPhase", data: { phase: "completed", model: "gpt-5.6-luna", index: 3, session_id: "s1", agent_id: "sub-1", cache_hit: false } },
    ];
    const s = aggregateProviderStats(events).find((x) => x.provider === "openai")!;
    // 不分 agent 的话两组会被合成一个 4 事件的组，配对结果随出现顺序漂移
    expect(s.ttftByCache!.hit).toEqual({ count: 1, p50: 700, p95: 700 });
    expect(s.ttftByCache!.miss).toEqual({ count: 1, p50: 5000, p95: 5000 });
    expect(s.ttftBucketDropped).toBeUndefined();
  });

  test("老轨迹（无 cache_hit 维度）不落空桶结构", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      afterModel("openai", "glm-5.2"),
      { event: "StreamPhase", data: { phase: "first_content", model: "glm-5.2", ttft_ms: 3000 } },
    ];
    const s = aggregateProviderStats(events).find((x) => x.provider === "openai")!;
    // 落一个 count 全 0 的结构会让"数据还没采到"看起来像"命中与未命中一样快"
    expect(s.ttftByCache).toBeUndefined();
    expect(s.ttft_p50).toBe(3000);
  });
});
