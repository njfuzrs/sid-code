/**
 * P0-1：流进展写入下沉到 lifecycle 唯一咽喉 —— 四条 provider 路径的进展快照回归。
 *
 * § 被测缺陷（GLM-5.3 长思考卡死排查产出，轨迹 20260817-135824-fcf863e1）
 *
 * `query/loop.ts` 的 watchdog 把 `snapshot.lastContentProgressAt` 当作**全 provider
 * 通用**的权威无进展判据，但 `updateStreamStats` 原先全仓只有 2 个调用点、都在
 * `openai.ts` 的 `parseSSE` 内，且**都有写入条件缺陷**：
 *
 * | 路径 | 修复前的形态 |
 * | --- | --- |
 * | openai Chat Completions | `stallLogger` 被 `elapsed >= 30s` 门控 → 一直有进展的慢流永不写快照 |
 * | anthropic | `updateStreamStats` 零调用 → 快照建出来了但字段恒为建快照时刻 |
 * | Responses（GPT-5.x） | 同上；且它的解析器一个定时器都没有，事件级是唯一信号源 |
 * | ollama | `class OllamaProvider extends OpenAIProvider` → 继承上面两条 |
 *
 * 后果不是「诊断弱」而是**隐形硬顶**：`loop.ts:2364` 只对**快照缺失**有兜底
 * （退化用 `headerTimeoutMs + grace`），对「快照存在却字段不刷新」没有任何兜底 →
 * 当成「已收首字节、确实 N 秒无进展」走完整判定后强杀。实测指纹是
 * `WatchdogKill` 报 `total_chunks: 0`，而同一条流的 `RetryTelemetry` 录得 11183 个事件。
 *
 * § 本文件钉住什么
 *
 * **三条 provider 路径各自**断言慢流下快照被真实刷新 —— 只测 openai 等于没测
 * anthropic/Responses 那两条（它们的病因不同：一个是写入条件错，两个是零写入）。
 * 外加咽喉自身的四条语义对照：
 *   - 非进展事件（keep-alive 形态）**不**刷新 —— 否则 ping-only 僵死流被一路续命，
 *     watchdog 永远等不到判定条件，防线反成帮凶；
 *   - 进展事件刷新（同一判据的正向对照）；
 *   - 不传 `progressObsIndex` 的路径完全不碰快照（side-call / 子代理行为不变）；
 *   - 不传 `isContentProgress` 时退化为「所有事件都算进展」—— 覆盖 openai Chat 这条
 *     `contentProgressEnabled` 恒 false 的路径，防止写入被误挂在该开关后面。
 *
 * § 负向对照（已实测，两条变异各跑过一次）
 *
 * | 变异 | 实测结果 |
 * | --- | --- |
 * | 删掉 `stream-lifecycle.ts` 的 `if (isProgressEvent) publishProgressToObserver();` | 5 fail / 3 pass —— 三条 provider 路径 + 两条咽喉语义全红 |
 * | 把 `openai.ts` 的 `updateStreamStats` 挪回 `if (elapsed >= STALL_LOG_MS)` 内部 | 1 fail —— 「字节级不再被 stall 门控」那条红 |
 *
 * 两条变异各自只红该层对应的用例、且都稳定复现，说明两层都被真正钉住，
 * 而不是「其中一层顺带兜住了另一层的测试」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import { createStreamLifecycle } from "@sid-code/core/llm/stream-lifecycle.ts";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
  getStreamSnapshot,
} from "@sid-code/core/trace/stream-observer.ts";
import { currentSseDumpContext } from "@sid-code/core/llm/sse-chunk-dumper.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

// ─── 脚手架 ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

beforeEach(() => {
  // 事件写入器给个空实现：本文件只断言**快照**，不断言 events.jsonl。
  initStreamObserver("test-session", "/tmp/test-session", () => {});
});

afterEach(() => {
  resetStreamObserver();
  globalThis.fetch = realFetch;
});

/** 当前 ambient observer index —— 生产侧 provider 取的就是这个（不带 agentId）。 */
function obsIndex(): number {
  return currentSseDumpContext().turnIndex;
}

/**
 * 消费流，并在**每个** `content_block_delta` 到达时采一次
 * `snapshot.lastContentProgressAt`（即 watchdog 每 5s tick 读的那个字段）。
 *
 * § 判据为什么是「流内多点采样比较推进量」，而不是「消费完读一次」
 *
 * 踩过两次，两次都是**判据本身不成立**而非实现不对，都由变异测试暴露：
 *
 * 1. **不能消费完再读**：openai Chat Completions 在 `[DONE]` 时有一次兜底写
 *    （`openai.ts` 的 `[DONE]` 分支），缺陷版本上「消费完再断言」照样是绿的。
 *    而 watchdog 开枪发生在 `[DONE]` **之前** —— 那个兜底一次也帮不上。
 * 2. **不能拿「晚于流开始时刻」当判据**：快照是流开始后由 `emitStreamPhase` 建的，
 *    `lastContentProgressAt` 初值就是建快照那一刻，天然晚于流开始。这种判据在
 *    缺陷版本上时绿时红（取决于两个 `Date.now()` 是否落在同一毫秒）—— 假判据。
 *
 * 成立的判据只有一个：**这个字段在流进行期间被反复推进**。
 * 缺陷形态（冻结在建快照时刻）下多点采样值恒等 → 差值 0 → 稳定变红。
 */
async function drainSamplingProgress(
  it: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; progressSamples: number[] }> {
  const events: StreamEvent[] = [];
  const progressSamples: number[] = [];
  for await (const ev of it) {
    events.push(ev);
    if (ev.type === "content_block_delta") {
      const at = getStreamSnapshot(obsIndex())?.lastContentProgressAt;
      if (at !== undefined) progressSamples.push(at);
    }
  }
  return { events, progressSamples };
}

/**
 * 断言「进展字段在流进行期间被真实推进」。见 {@link drainSamplingProgress} 的判据说明。
 * 只断言字段非空 / 晚于某个基准都不成立（[[metric-exists-but-value-is-junk]]：
 * 过①有调用点②有字段，却挂在③值有区分度上）。
 */
function expectProgressAdvancedDuringStream(samples: number[]): void {
  // 至少两点，否则「没有推进」与「没采到」分不开。
  expect(samples.length).toBeGreaterThanOrEqual(2);
  expect(samples.at(-1)!).toBeGreaterThan(samples[0]!);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── 1. openai Chat Completions（字节级 + 事件级两层都要生效）────────────

describe("P0-1 · openai Chat Completions：慢流的进展被写进快照", () => {
  /** 把若干 SSE chunk 按给定间隔喂出去（模拟"一直有进展但很慢"的思考流）。 */
  function slowSseStream(chunks: object[], gapMs: number): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          await sleep(gapMs);
          controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  test("持续吐 reasoning_content 的慢流：lastContentProgressAt 被真实推进", async () => {
    // 每块都带 reasoning_content —— 这正是 GLM/DeepSeek 思考阶段的形态。
    const chunks = Array.from({ length: 6 }, (_, i) => ({
      id: "x",
      choices: [{ index: 0, delta: { reasoning_content: `思考${i}` } }],
    }));
    globalThis.fetch = (async () =>
      new Response(slowSseStream(chunks, 15), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const provider = new OpenAIProvider("test-key", "glm-5.3");
    const params: SendParams = {
      model: "glm-5.3",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 64,
    };
    // 逐个思考增量采样快照 —— 模拟 watchdog 在流**还在飞**时反复读同一个字段。
    const { events, progressSamples } = await drainSamplingProgress(
      provider.sendMessageStream(params),
    );

    // 前提：流真的产出了思考增量（否则下面的断言是在测空气）。
    expect(
      events.filter((e: StreamEvent) => e.type === "content_block_delta").length,
    ).toBeGreaterThan(0);
    // 判据：进展字段在流进行期间被反复推进。
    //
    // 修复前这条会红：本路径的两个写入方，一个被 `elapsed >= 30s` 门控
    // （一直有进展的慢流永远进不去），另一个只在 `[DONE]` 时兜底 —— 而
    // watchdog 开枪发生在 [DONE] **之前**，那个兜底一次也帮不上。
    expectProgressAdvancedDuringStream(progressSamples);
    // chunksReceived 不再是初始的 0（WatchdogKill 报 total_chunks=0 就是读到它）。
    expect(getStreamSnapshot(obsIndex())!.chunksReceived).toBeGreaterThan(0);
  });

  test("字节级写入不再被 stall 门控：stallLogger 每 tick 无条件写快照", () => {
    // 静态钉住那条因果链（行为侧的 30s tick 在单测里等不起）：
    // `updateStreamStats` 必须在 `if (elapsed >= STALL_LOG_MS)` **之外**。
    // 这是本 PR 修的原始 bug，删掉这条断言就等于允许它悄悄回退。
    const src = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "../../src/llm/openai.ts"),
      "utf8",
    ) as string;
    const start = src.indexOf("const stallLogger = setInterval(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("}, STALL_LOG_MS);", start));
    const updateAt = body.indexOf("updateStreamStats(");
    const gateAt = body.indexOf("if (elapsed >= STALL_LOG_MS)");
    expect(updateAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(0);
    // 写快照必须早于 stall 门控（即不在门控块内）。
    expect(updateAt).toBeLessThan(gateAt);
  });
});

// ─── 2. anthropic（修复前 updateStreamStats 零调用）──────────────────────

describe("P0-1 · anthropic：慢流的进展被写进快照", () => {
  /** mock SDK 的 messages.create().withResponse()，注入受控 raw event 流。 */
  function makeProvider(events: any[], gapMs: number): AnthropicProvider {
    const provider = new AnthropicProvider("test-key", "claude-opus-4-8");
    const controller = new AbortController();
    const rawStream = {
      controller,
      async *[Symbol.asyncIterator]() {
        for (const ev of events) {
          await sleep(gapMs);
          if (controller.signal.aborted) return;
          yield ev;
        }
      },
    };
    const response = {
      status: 200,
      headers: new Headers(),
      body: { cancel: () => Promise.resolve() },
    };
    (provider as any).client.messages.create = () => ({
      withResponse: async () => ({ data: rawStream, response }),
    });
    return provider;
  }

  test("content_block_delta 持续到达：lastContentProgressAt 被真实推进", async () => {
    const raw = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ...Array.from({ length: 5 }, () => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "x" },
      })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];

    const { events: out, progressSamples } = await drainSamplingProgress(
      makeProvider(raw, 12).sendMessageStream({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxTokens: 64,
      }),
    );

    expect(out.filter((e: StreamEvent) => e.type === "content_block_delta").length).toBe(5);
    // 修复前必红：本路径 `updateStreamStats` 零调用，快照由
    // emitStreamPhase("headers_received") 建出来后 lastContentProgressAt 再没被写过
    // （恒等于建快照时刻）→ 多点采样值全等 → 推进量 0。
    expectProgressAdvancedDuringStream(progressSamples);
    expect(getStreamSnapshot(obsIndex())!.chunksReceived).toBeGreaterThan(0);
  });
});

// ─── 3. Responses 路径（事件级是唯一信号源）────────────────────────────

describe("P0-1 · Responses：事件级是唯一进展信号源", () => {
  test("Responses 流式路径把进展写进快照", async () => {
    // 走真实的 sendMessageStream → shouldUseResponsesAPI 分派（env 强制 responses，
    // 优先级 1），确保被测的是**生产分派后的那条路径**，不是手搭的 lifecycle。
    const prevProtocol = process.env.SID_CODE_OPENAI_PROTOCOL;
    process.env.SID_CODE_OPENAI_PROTOCOL = "responses";
    try {
      const enc = new TextEncoder();
      const sse = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"},"sequence_number":0}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message","role":"assistant"},"sequence_number":1}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"m1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""},"sequence_number":2}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":"He","sequence_number":3}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":"llo","sequence_number":4}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":2}},"sequence_number":5}\n\n',
      ];
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const s of sse) {
                await sleep(12);
                controller.enqueue(enc.encode(s));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch;

      const { events: out, progressSamples } = await drainSamplingProgress(
        new OpenAIProvider("test-key", "gpt-5.6").sendMessageStream({
          model: "gpt-5.6",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxTokens: 64,
        }),
      );

      // 前提：确实走到了 Responses 解析器并产出了 text delta。
      expect(
        out.filter((e: StreamEvent) => e.type === "content_block_delta").length,
      ).toBeGreaterThan(0);
      // 修复前必红：本路径的解析器（parseResponsesStream → readSSEEvents）
      // 全文零定时器、也不调 updateStreamStats，快照字段恒为建快照时刻。
      expectProgressAdvancedDuringStream(progressSamples);
    } finally {
      // 存/恢复而非无条件 delete —— 同批多文件跑在同一进程里。
      if (prevProtocol === undefined) delete process.env.SID_CODE_OPENAI_PROTOCOL;
      else process.env.SID_CODE_OPENAI_PROTOCOL = prevProtocol;
    }
  });
});

// ─── 4. 唯一咽喉自身的语义对照 ──────────────────────────────────────────

describe("P0-1 · lifecycle 咽喉的写入语义", () => {
  type Evt = { type: string };

  /**
   * 直接驱动 lifecycle，隔离 provider 变量。快照需先建出来（生产由 emitStreamPhase 建）。
   * 返回逐事件采到的 `lastContentProgressAt` 序列 —— 判据同
   * {@link drainSamplingProgress}：看它在流进行期间有没有被推进。
   */
  async function runLifecycle(
    events: Evt[],
    opts: {
      gapMs: number;
      isContentProgress?: (e: Evt) => boolean;
      withObsIndex: boolean;
    },
  ): Promise<number[]> {
    emitStreamPhase(obsIndex(), "fetch_sent", { model: "test" });
    const lc = createStreamLifecycle<Evt>({
      idleTimeoutMs: 10_000,
      overallTimeoutMs: 10_000,
      stallWarnMs: 10_000,
      label: "TEST",
      ...(opts.isContentProgress ? { isContentProgress: opts.isContentProgress } : {}),
      ...(opts.withObsIndex ? { progressObsIndex: obsIndex() } : {}),
    });
    async function* src(): AsyncGenerator<Evt> {
      for (const e of events) {
        await sleep(opts.gapMs);
        yield e;
      }
    }
    const samples: number[] = [];
    for await (const _ of lc.guard(src())) {
      const at = getStreamSnapshot(obsIndex())?.lastContentProgressAt;
      if (at !== undefined) samples.push(at);
    }
    return samples;
  }

  const isDelta = (e: Evt) => e.type === "content_block_delta";

  test("非进展事件（keep-alive 形态）不刷新快照", async () => {
    // 这条是防「把咽喉写成对任何事件都刷新」—— 那样 ping-only 的僵死流会被
    // 快照一路续命，watchdog 永远等不到判定条件，比不写还糟（防线变成了帮凶）。
    const samples = await runLifecycle(
      Array.from({ length: 5 }, () => ({ type: "ping" })),
      { gapMs: 12, isContentProgress: isDelta, withObsIndex: true },
    );
    // 全等 = 一次都没被推进（值仍是建快照那一刻）。
    expect(new Set(samples).size).toBe(1);
  });

  test("进展事件刷新快照（同一判据的正向对照）", async () => {
    const samples = await runLifecycle(
      Array.from({ length: 5 }, () => ({ type: "content_block_delta" })),
      { gapMs: 12, isContentProgress: isDelta, withObsIndex: true },
    );
    expectProgressAdvancedDuringStream(samples);
  });

  test("不传 progressObsIndex 的路径完全不碰快照（side-call / 子代理行为不变）", async () => {
    const samples = await runLifecycle(
      Array.from({ length: 5 }, () => ({ type: "content_block_delta" })),
      { gapMs: 12, isContentProgress: isDelta, withObsIndex: false },
    );
    // 快照仍在（上面 emitStreamPhase 建的），但字段一个都没被本层写过。
    expect(new Set(samples).size).toBe(1);
    expect(getStreamSnapshot(obsIndex())!.chunksReceived).toBe(0);
  });

  test("未传 isContentProgress 时退化为「所有事件都算进展」", async () => {
    // 与 isContentProgress 选项自身的文档语义一致；也覆盖 openai Chat 路径
    // （它不传该回调、且 contentProgressTimeoutMs 也不传 → 整层未启用）。
    // ⚠️ 若把写快照挂在 `contentProgressEnabled &&` 后面，这条会红 ——
    // 那正是「修了三条路径、漏掉主循环最常用那条」的形状。
    const samples = await runLifecycle(
      Array.from({ length: 4 }, () => ({ type: "whatever" })),
      { gapMs: 12, withObsIndex: true },
    );
    expectProgressAdvancedDuringStream(samples);
  });
});
