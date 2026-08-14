/**
 * 作废尝试的用量入账 —— 回归 + 门禁（P0-2 C 组）
 *
 * 事故（2026-08-11 实测）：`HttpConnected(status=200)` **254** 次（全部成功建连、
 * prompt 已完整发到服务端），而记账（`AfterModel`）只有 **153** 次。
 * 差额 101 次 ≈ 12M token 从未入账 —— 轨迹自报 22.4M，用户真实账单对应 30.6M（少记 26.2%）。
 *
 * ── 归因（与修复方案原文不同，这里以源码为准）──
 *
 * 方案 §2.9-C 第 6 条建议"由 fallback 累加本轮所有尝试的总发出量"。**照字面实现会双计**：
 * `fallback.ts` 里根本没有 usage（全文 0 次 `usage`），流**内部**重开的量早已在
 * stream-processor 层累加进同一个 `response`，且 `stream-restart.ts` 明确规定
 * 「作废时刻意不动 usage」（types.ts 的 `stream_restart` 契约第 2 条），
 * `stream-restart-contract.test.ts` 还钉了 `90090 + 93663` 这个断言。
 *
 * 真实缺口在**另一层**：流**整体**抛错时（超时 / 流内 error），`processStream` 把
 * 累加好的 `response` 连同 usage 一起丢掉，只抛出一个 Error；`loop.ts` 的 catch
 * 拿到 Error 后走三条 `continue` 重试出口，而 `updateUsage` 那句在 try/catch **之后**
 * —— 于是这一整次尝试的用量凭空消失。
 *
 * 修法：`processStream` 抛错前把已累加的 usage 挂到 error 上（`discardedUsage`），
 * `loop.ts` catch 的**最前面**统一入账（三条 continue 出口共用一处，避免将来新增
 * 第四条出口时漏掉）。
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { StreamEvent, Usage } from "@sid-code/core/llm/types.ts";
import { SessionState } from "@sid-code/core/session/state.ts";

/** 把事件数组包成流；可选在末尾抛错（模拟超时/流内 error 打断）。 */
async function* streamOf(events: StreamEvent[], throwAtEnd?: Error): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
  if (throwAtEnd) throw throwAtEnd;
}

describe("C 组 · processStream 抛错时把已累加 usage 交给调用方", () => {
  test("流中途抛错 → error 上带 discardedUsage（已发出的量不再凭空消失）", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 90090, outputTokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半截回答" } },
    ];
    let caught: (Error & { discardedUsage?: Usage }) | null = null;
    try {
      await processStream(streamOf(events, new Error("socket hang up")));
    } catch (e) {
      caught = e as Error & { discardedUsage?: Usage };
    }
    expect(caught).not.toBeNull();
    expect(caught!.discardedUsage).toBeTruthy();
    // 这次尝试的 prompt 已完整发到服务端，厂商按收到的 prompt 计费。
    expect(caught!.discardedUsage!.inputTokens).toBe(90090);
  });

  test("未累加到任何量时不挂 discardedUsage（不制造空记账）", async () => {
    let caught: (Error & { discardedUsage?: Usage }) | null = null;
    try {
      await processStream(streamOf([], new Error("connect ECONNREFUSED")));
    } catch (e) {
      caught = e as Error & { discardedUsage?: Usage };
    }
    expect(caught).not.toBeNull();
    expect(caught!.discardedUsage).toBeUndefined();
  });

  test("正常完成不受影响：usage 照常随返回值给出，不走旁路", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 1000, outputTokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完整回答" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 42 },
      },
      { type: "message_stop" },
    ];
    const res = await processStream(streamOf(events));
    expect(res.usage.inputTokens).toBe(1000);
    expect(res.usage.outputTokens).toBe(42);
  });
});

describe("C 组 · 与 stream_restart 的分工：流内重开不得双计", () => {
  test("流内重开（stream_restart）正常返回时，usage 已累加且不挂 discardedUsage", async () => {
    // 这是"照方案字面在 fallback 层再加一次汇总"会双计的直接证据：
    // 流内两次尝试的量已经在这里累加进同一个 response 了。
    const events: StreamEvent[] = [
      { type: "message_start", message: { usage: { inputTokens: 90090, outputTokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "作废的半截" } },
      { type: "stream_restart", reason: "network_error", attempt: 1 },
      { type: "message_start", message: { usage: { inputTokens: 93663, outputTokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完整回答" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: 248 },
      },
      { type: "message_stop" },
    ];
    const res = await processStream(streamOf(events));
    // 两次尝试的 input 都计入（契约：作废内容清空，但 usage 不回退）
    expect(res.usage.inputTokens).toBe(90090 + 93663);
    // 内容只保留第二次（作废语义），证明这确实走的是 stream_restart 路径
    const texts = res.content.filter((b) => b.type === "text").map((b: any) => b.text);
    expect(texts).toEqual(["完整回答"]);
  });
});

describe("C 组 · billable / effective 两个口径必须并存", () => {
  const MODEL = "deepseek-v4-pro";

  test("作废量计入 flow（cumulative/cost），但不覆盖 stock（当前上下文）", () => {
    const st = new SessionState();
    // 一次正常调用：stock = 10000
    st.updateUsage(MODEL, { inputTokens: 10000, outputTokens: 100 }, 0, "openai");
    const afterOk = st.modelUsage[MODEL];
    expect(afterOk.stockPromptTokens).toBe(10000);
    expect(afterOk.cumulativePromptTokens).toBe(10000);

    // 一次作废尝试：cumulative 累加，stock 不动
    st.updateUsage(MODEL, { inputTokens: 8000, outputTokens: 0 }, 0, "openai", undefined, true);
    const afterDiscard = st.modelUsage[MODEL];
    // effective（当前上下文）不受作废影响 —— 否则状态栏会显示一个已不存在的幽灵值
    expect(afterDiscard.stockPromptTokens).toBe(10000);
    expect(afterDiscard.inputTokens).toBe(10000);
    // billable（对账账单）含作废量
    expect(afterDiscard.cumulativePromptTokens).toBe(18000);
  });

  test("作废量单独留痕，可直接回答“重试白烧了多少”", () => {
    const st = new SessionState();
    st.updateUsage(MODEL, { inputTokens: 5000, outputTokens: 50 }, 0, "openai");
    st.updateUsage(MODEL, { inputTokens: 5000, outputTokens: 0 }, 0, "openai", undefined, true);
    st.updateUsage(MODEL, { inputTokens: 5000, outputTokens: 0 }, 0, "openai", undefined, true);
    const s = st.modelUsage[MODEL];
    expect(s.discardedRequests).toBe(2);
    expect(s.discardedPromptTokens).toBe(10000);
    // 总记账次数含作废（3 次真实发出）
    expect(s.requests).toBe(3);
  });

  test("作废尝试的费用计入总成本（否则 costLimit 守卫晚触发）", () => {
    const st = new SessionState();
    st.updateUsage(MODEL, { inputTokens: 1_000_000, outputTokens: 0 }, 0, "openai");
    const costAfterOk = st.totalCostUSD;
    expect(costAfterOk).toBeGreaterThan(0);
    st.updateUsage(
      MODEL,
      { inputTokens: 1_000_000, outputTokens: 0 },
      0,
      "openai",
      undefined,
      true,
    );
    // 作废量同样花钱 —— 费用必须涨，不能当不存在
    expect(st.totalCostUSD).toBeGreaterThan(costAfterOk);
    expect(st.totalCostUSD).toBeCloseTo(costAfterOk * 2, 6);
  });

  test("默认不传 discarded 时行为与修复前一致（向后兼容）", () => {
    const st = new SessionState();
    st.updateUsage(MODEL, { inputTokens: 7777, outputTokens: 7 }, 0, "openai");
    const s = st.modelUsage[MODEL];
    expect(s.stockPromptTokens).toBe(7777);
    expect(s.discardedRequests).toBeUndefined();
  });
});
