/**
 * PR2 回归：`fallback.ts` 的流超时改为**感知内容进展**，且续命时**不得重建 AbortController**。
 *
 * 事故形态（轨迹 `20260817-135824-fcf863e1`，GLM-5.3 经公司网关）：
 * 24 次 `TimeoutFired` 100% 是 `fallback_stream_timeout`，`elapsed_ms` 全部精确落在
 * 300000±300 —— 这是**绝对计时器**的指纹（"多久没进展就杀"不会这么齐平）。
 * 一条持续吐 `reasoning_content` 的健康流被无差别掐断，已累积思考内容全部作废、
 * 被迫从零重来；上下文越大思考越慢 → 越容易触顶 → 恶性循环。
 *
 * 本文件三组用例，缺一不可：
 *   ① 正向：慢但**一直有进展**的流不再被杀（这是修复的目标）；
 *   ② 负向对照（**本 PR 的核心**）：真僵死连接仍能被回收 —— 别把防线拆了；
 *   ③ 负向对照：续命路径若重建 `AbortController`，②必须变红。
 *
 * ③ 为什么必须单独钉住：`makeCombinedSignal()` 只在 `openStream` 时**取一次** signal，
 * 在飞的 fetch 持有的是**旧** controller 的 signal。attempt 中途换 controller →
 * 新 controller 的 `abort()` 到不了那个 fetch、旧 timer 又已被 clear →
 * **这一层超时被彻底解除**（退回 0 层状态，比 300s 误杀更坏）。这正是方案文档
 * §5 P0-2 警告的坑：「照字面实现会踩一个更严重的坑」。
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const defaultParams: SendParams = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 1024,
};

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/**
 * 「慢但健康」的流：每 `intervalMs` 吐一个 `content_block_delta`，共 `chunks` 个，
 * 总时长**显著超过** streamTimeoutMs，但**任意相邻两块的间隔都小于**它。
 *
 * 这正是 GLM-5.3 长思考的形态：reasoning token 持续但不快地吐出来。
 * 旧实现（attempt 绝对计时）必杀它；新实现（感知进展）必须放行。
 */
function slowButHealthyProvider(chunks: number, intervalMs: number): Provider {
  return {
    name: () => "mock-slow-healthy",

    async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      for (let i = 0; i < chunks; i++) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Request was aborted."));
          const t = setTimeout(resolve, intervalMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("Request was aborted."));
            },
            { once: true },
          );
        });
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: `chunk-${i}` },
        };
      }
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_stop" };
    },
  };
}

/**
 * 「先有进展、随后僵死」的流：吐几块之后彻底不动，只靠**传入的 combined signal** 逃生。
 *
 * mock 监听 signal 是**必须的**，不是偷懒：本层的超时 abort 走的是
 * `makeCombinedSignal()` → provider → `fetch`，真实 provider 正是这样把 signal
 * 交给 fetch 的（半开连接下 fetch abort 照样生效）。而流循环里那个
 * `Promise.race(abortPromise)` 只覆盖**外层用户 signal**（ESC），不覆盖本层超时
 * —— 那条路径由 `fallback.test.ts` 的「真半开」用例单独钉住，与本文件职责不同。
 *
 * 于是本 mock 恰好构成 PR2 的负向对照：若续命时重建了 controller，abort 会打在
 * 一个**新** controller 上，而 mock 持有的是**旧** signal → 永远等不到 → hang。
 */
function stallsAfterProgressProvider(chunks: number, intervalMs: number): Provider {
  return {
    name: () => "mock-stall-after-progress",

    async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      for (let i = 0; i < chunks; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: `chunk-${i}` },
        };
      }
      // 僵死：只有本层的超时 abort 能救出来（模拟服务端不再发 event 的 SSE 半开）。
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) return reject(new Error("Request was aborted."));
        signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), {
          once: true,
        });
      });
      yield { type: "message_stop" };
    },
  };
}

function successProvider(): Provider {
  return {
    name: () => "mock-fallback",

    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_stop" };
    },
  };
}

describe("fallback 流超时：感知内容进展", () => {
  // ─── ① 正向：慢但一直有进展的流不被杀 ───
  test("总时长远超阈值、但块间隔小于阈值的健康流 → 不被掐断，完整跑完", async () => {
    // 8 块 × 40ms ≈ 320ms 总时长，是 100ms 阈值的 3 倍多；
    // 但任意相邻两块间隔 40ms < 100ms → 感知进展的实现必须放行。
    const fallback = new ModelFallback({ streamTimeoutMs: 100 });
    const events = await collectEvents(
      fallback.executeWithFallback(slowButHealthyProvider(8, 40), defaultParams),
    );

    // 全部 8 个 delta 都到齐，且正常收尾
    const deltas = events.filter((e) => e.type === "content_block_delta");
    expect(deltas.length).toBe(8);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    // 关键：没有发生重开 —— 有 stream_restart 就说明流被杀过一次
    expect(events.some((e) => e.type === "stream_restart")).toBe(false);
  }, 15_000);

  // ─── ② 负向对照（核心）：真僵死连接仍能被回收 ───
  //
  // 这条是本 PR 的**主判据**。若 `renewStreamTimeout` 里写成
  // `streamTimeoutCtl = new AbortController()`（即照 §5 P0-2 字面实现），
  // 本用例会 hang 到 bun 的用例超时才失败 —— 那正是"超时被彻底解除"的形态。
  test("先有进展、随后僵死 → 仍被超时回收并转 fallback（别把防线拆了）", async () => {
    const fallback = new ModelFallback({
      streamTimeoutMs: 150,
      fallbackProvider: successProvider(),
      fallbackModel: "fallback-model",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const started = Date.now();
    const events = await collectEvents(
      // 先吐 3 块（每块 40ms，均在 150ms 阈值内 → 三次续命），随后彻底僵死
      fallback.executeWithFallback(stallsAfterProgressProvider(3, 40), defaultParams),
    );
    const elapsed = Date.now() - started;

    // 最终拿到结果（重试耗尽后由 fallback provider 兜底）
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    // 发生过重开 → 证明超时确实开过枪，不是"防线被拆了还恰好通过"
    expect(events.some((e) => e.type === "stream_restart")).toBe(true);
    // 兜个上界，防止"靠 bun 用例超时兜底"这种假通过悄悄溜过去
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  // ─── ③ 零进展流：一次续命都没有 → 按阈值准时开枪 ───
  test("从头到尾零进展的流 → 在阈值附近被回收（续命逻辑不影响无进展判定）", async () => {
    const neverYieldsProvider: Provider = {
      name: () => "mock-never-yields",
      async *sendMessageStream(_p: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Request was aborted."));
          signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), {
            once: true,
          });
        });
        yield { type: "message_stop" };
      },
    };

    const fallback = new ModelFallback({
      streamTimeoutMs: 120,
      fallbackProvider: successProvider(),
      fallbackModel: "fallback-model",
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
    });

    const started = Date.now();
    const events = await collectEvents(
      fallback.executeWithFallback(neverYieldsProvider, defaultParams),
    );
    const elapsed = Date.now() - started;

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});

describe("fallback 流超时：续命不得重建 AbortController（防漂移哨兵）", () => {
  /**
   * 静态哨兵：源码级钉住"续命路径只重排定时器，不 new AbortController"。
   *
   * 为什么需要**静态**哨兵而不只靠上面的行为测试：上面②的失败形态是 **hang 到
   * 用例超时**，在 CI 上表现为一条慢测试，容易被误判成 flake 而加 `--timeout` 绕过。
   * 静态哨兵失败时消息明确、零耗时，直接指出改错了哪一行。
   *
   * ⚠️ 这类防漂移哨兵红了要**补清单/改实现，而不是删断言**（CLAUDE.md 已记该教训）。
   */
  test("renewStreamTimeout 函数体内不得出现 new AbortController", async () => {
    const src = await Bun.file(
      new URL("../../src/llm/fallback.ts", import.meta.url).pathname,
    ).text();

    // 取 `const renewStreamTimeout = () => {` 到其闭合 `};` 之间的函数体
    const startMarker = "const renewStreamTimeout = () => {";
    const startIdx = src.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    const bodyStart = startIdx + startMarker.length;
    const endIdx = src.indexOf("\n    };", bodyStart);
    expect(endIdx).toBeGreaterThan(bodyStart);
    const body = src.slice(bodyStart, endIdx);

    expect(body).not.toContain("new AbortController");
    // 正向：它确实在重排定时器
    expect(body).toContain("startStreamTimeout()");
  });

  test("换 controller 只发生在 attempt 边界（resetStreamTimeout），且它仍然存在", async () => {
    const src = await Bun.file(
      new URL("../../src/llm/fallback.ts", import.meta.url).pathname,
    ).text();

    // `streamTimeoutCtl = new AbortController()` 应恰好出现两次，且各有明确职责：
    //   ① `let streamTimeoutCtl = ...`（初始声明）
    //   ② `resetStreamTimeout` 里的**重新赋值**（attempt 边界换流）
    // 多出第三处 = 有人在别的地方换了 controller，正是本 PR 要防的形态。
    const all = src.match(/streamTimeoutCtl = new AbortController\(\)/g) ?? [];
    expect(all.length).toBe(2);
    const declarations = src.match(/let streamTimeoutCtl = new AbortController\(\)/g) ?? [];
    expect(declarations.length).toBe(1);

    const resetMarker = "const resetStreamTimeout = () => {";
    const resetIdx = src.indexOf(resetMarker);
    expect(resetIdx).toBeGreaterThan(-1);
    const resetBody = src.slice(resetIdx, src.indexOf("\n    };", resetIdx));
    expect(resetBody).toContain("streamTimeoutCtl = new AbortController()");
  });
});
