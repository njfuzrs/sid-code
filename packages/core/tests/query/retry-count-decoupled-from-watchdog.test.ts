/**
 * 两层重试预算相乘 —— 缺陷 2 的门禁（Harbor A11 第五棒实测，2026-08-29）
 *
 * ## 拦的是什么
 *
 * 内层 `fallback.ts` 有 11 次重试预算；外层 `loop.ts` 的 watchdog 在
 * 「无首字节 `headerTimeoutMs + grace`」或「无内容进展 `watchdogNoProgressMs`」时
 * 强杀整个调用。上游饱和时实测形态（`regex-log` 的第一次调用）：
 *
 * | watchdog 周期 | 内层 attempt 最高用到 | 内层退避累计 | 被杀于 |
 * | --- | --- | --- | --- |
 * | 1 | **5 / 11** | 154s | 315,788ms |
 * | 2–6 | **4 / 11** | 75–78s | ~315,500ms |
 *
 * 内层永远用不完那 11 次预算，外层 `TimeoutRetry` 又从 attempt 1 重新数 ——
 * **两层预算不是共享，是相乘**。7 个周期 ≈ 37 分钟、零内容产出（`chunk_count: 0`）。
 *
 * ## 这个缺陷的形态：修复代码早就在，只是从没被接上
 *
 * `fallback.ts` 的 S3 时间预算钳制（`perCall.deadlineAt`）**早就实现且有测试**
 * （`tests/llm/resilience-b6-gates.test.ts`），但主循环调的是不带
 * `perCallOptions` 的三参版本 —— 于是那套钳制**在生产路径上一次都没跑过**。
 * 本仓「伪配置 / 死功能」的同型：代码在、测试绿、真实路径不经过。
 *
 * ⛔ 所以本门禁**不测 S3 钳制本身**（那边已经测了），只测**接线**：
 * 主循环发请求时到底有没有把截止时刻交给 fallback。这正是那个缺陷所在的那一层。
 *
 * ## 不是「把 315s 改大」
 *
 * 记忆里两条相关教训：「多层超时同为 300s → 单点修复只换杀手」「抬阈值治不了」。
 * 本修复**一个阈值都没动**，动的是两层之间要不要交换「还剩多少时间」这个事实。
 * 第 3 个 test 把这条钉住：deadline 必须取两条防线里**先开枪的那个**（min），
 * 取 max 会让内层以为自己还有时间、继续睡退避，然后照样被先到的那层杀掉 = 没修。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { resolveLoopTimeouts } from "@sid-code/core/config/network-profile.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

function endTurnResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 捕获主循环每次调 sendWithRetry 时传进来的第三个参数 */
function setup(network?: Record<string, number>) {
  const seen: { opts: { deadlineAt?: number } | undefined }[] = [];

  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

  const deps: QueryDeps = {
    sendWithRetry: (
      _params: unknown,
      _signal: AbortSignal | undefined,
      opts: { deadlineAt?: number } | undefined,
    ) => {
      seen.push({ opts });
      return emptyStream();
    },
    processStream: async () => endTurnResp(),
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "u1",
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "claude-opus-4-8",
      provider: "anthropic",
      maxTurns: 1,
      maxTokens: 8000,
      ...(network ? { network } : {}),
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-shared-retry-budget"),
    fallback: new ModelFallback(),
    deps,
  };

  return { loopConfig, seen };
}

async function drain(loopConfig: QueryLoopConfig) {
  const events: any[] = [];
  for await (const ev of queryLoop(loopConfig)) events.push(ev);
  return events;
}

describe("缺陷 2：主循环必须把 wall-clock 预算交给内层 fallback", () => {
  test("每次发请求都带 deadlineAt（不带 = 两层预算相乘，那正是缺陷形态）", async () => {
    const { loopConfig, seen } = setup();
    const before = Date.now();
    await drain(loopConfig);
    const after = Date.now();

    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const { opts } of seen) {
      // ⛔ 这一条就是缺陷本身：修复前这里是 undefined，于是 fallback 的 S3
      // 钳制结构性从不生效（`perCall.deadlineAt !== undefined` 恒 false）。
      expect(opts).toBeDefined();
      expect(typeof opts!.deadlineAt).toBe("number");
      // 必须是未来的绝对时刻（与 Date.now() 同轴），不是"剩余毫秒数"。
      // 传成相对值会让 fallback 把 1970 年当截止时刻 → 每次都判"预算不足"立刻停手，
      // 那是把「从不生效」换成「永远生效」，同样是坏的，且同样不报错。
      expect(opts!.deadlineAt!).toBeGreaterThan(before);
    }

    // 默认配置下 deadline = min(headerTimeout+grace, watchdogNoProgress) = 315s
    const nt = resolveLoopTimeouts({});
    const expectedSpan = Math.min(
      nt.headerTimeoutMs + nt.watchdogHeaderGraceMs,
      nt.watchdogNoProgressMs,
    );
    // ⚠️ 方向：`deadlineAt` 是在 `before` **之后**的某一刻算出来的
    // （`Date.now() + span`），所以 `deadlineAt - before >= expectedSpan`，
    // 差额就是"从取 before 到真正发请求"这段。断成 `<=` 会因为几毫秒的执行耗时
    // 随机翻红 —— 那是测试自己的口径错，不是被测代码的问题。
    const span = seen[0].opts!.deadlineAt! - before;
    expect(span).toBeGreaterThanOrEqual(expectedSpan);
    // 上界用真实经过的时间兜：必须仍是同一量级（不能炸成 90min 的单轮硬顶）
    expect(span).toBeLessThanOrEqual(expectedSpan + (after - before) + 1_000);
  });

  test("deadline 随 settings 的超时配置一起走（不是硬编码常量）", async () => {
    // 用户把首字节超时调小 → deadline 必须跟着变小。硬编码一个 315s 会让
    // 「调了配置但预算没跟着动」，形态是配置看起来生效了、实际只生效一半。
    const { loopConfig, seen } = setup({
      headerTimeoutMs: 20_000,
      watchdogHeaderGraceMs: 5_000,
      watchdogNoProgressMs: 600_000,
    });
    const before = Date.now();
    await drain(loopConfig);

    const span = seen[0].opts!.deadlineAt! - before;
    // min(20s + 5s, 600s) = 25s（下界即 25s，上界留执行耗时余量，见上条注释）
    expect(span).toBeGreaterThanOrEqual(25_000);
    expect(span).toBeLessThan(30_000);
  });

  test("取两条防线里先开枪的那个（min，不是 max）", async () => {
    // watchdogNoProgress 比 header+grace 小的配置：deadline 必须跟小的那个。
    // 取 max 的话内层会以为自己还有 315s，继续睡退避，然后被 30s 那层杀掉 = 没修。
    const { loopConfig, seen } = setup({
      headerTimeoutMs: 300_000,
      watchdogHeaderGraceMs: 15_000,
      watchdogNoProgressMs: 30_000,
    });
    const before = Date.now();
    await drain(loopConfig);

    const span = seen[0].opts!.deadlineAt! - before;
    expect(span).toBeGreaterThanOrEqual(30_000);
    // 变异自证：若实现取了 max，这里会是 ~315s，下面这条必然翻转
    expect(span).toBeLessThan(60_000);
  });

  test("刻意不把单轮硬顶（90min）算进 deadline", async () => {
    // maxTurnDurationMs 是「整轮」预算（跨多次 fetch、跨降级切换），
    // 而 deadlineAt 是「这一次调用」的。混进来会让内层以为自己有 90 分钟 ——
    // 那正是本缺陷的形态（内层预算永远用不完）。
    const nt = resolveLoopTimeouts({});
    const { loopConfig, seen } = setup();
    const before = Date.now();
    await drain(loopConfig);

    const span = seen[0].opts!.deadlineAt! - before;
    expect(nt.maxTurnDurationMs).toBeGreaterThan(span);
    expect(span).toBeLessThan(nt.maxTurnDurationMs);
  });
});
