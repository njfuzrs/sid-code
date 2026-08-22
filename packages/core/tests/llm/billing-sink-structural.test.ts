/**
 * 计费发生侧收口 —— 结构性验收（方案 §6 判据 1/3/5/6）
 *
 * ## 这个文件里最重要的一条：判据 6
 *
 * > 新增一条走 provider 的调用链、**故意不加任何上报代码**，
 * > 断言它的 usage 依然出现在账本里。
 *
 * 它是**唯一**能区分"根治"与"打补丁"的断言。其余判据都只能证明
 * *这一次的* fork 被修好了；只有它能证明**机制本身**变了 ——
 * 因为它模拟的正是「将来某个作者新增调用链且什么都不记得做」这个场景，
 * 而那恰恰是本次漏 22 次记账的根因形态。
 *
 * ⚠ 若这条测试需要被改成"新链要先注册一下"才能过，说明落地时退回成了
 * 补一次上报 —— 此时应当停下来重新评估，而不是改测试。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  recordBilledRequest,
  addBillingObserver,
  resetBillingSink,
  nextFetchId,
  type BilledRequest,
} from "../../src/llm/billing-sink.ts";
import {
  withRequestContext,
  getRequestContext,
  streamInRequestContext,
} from "../../src/llm/request-context.ts";

describe("billing-sink：发生侧收口", () => {
  let seen: BilledRequest[];

  beforeEach(() => {
    resetBillingSink();
    seen = [];
    addBillingObserver((r) => seen.push(r));
  });

  afterEach(() => resetBillingSink());

  test("判据 6（最重要）：新增调用链不写任何上报代码，用量仍然入账", () => {
    // 模拟一条**全新的**调用链：它只做一件事 —— 走 provider 发流。
    // 它不 import side-call-sink、不调 recordSideCall、不碰 SessionState。
    // 这正是「新作者什么都不记得做」的形态。
    function brandNewCallChainThatForgetsEverything(): void {
      // provider 内部（openai.ts / anthropic.ts 的 finally）会做这件事，
      // 调用链本身对此**一无所知**。这里直接调 provider 侧的收口函数来代表那一步。
      recordBilledRequest({
        fetchId: nextFetchId(),
        model: "deepseek-v4-pro",
        provider: "openai",
        baseURL: "https://api.deepseek.com",
        usage: { inputTokens: 100_000, outputTokens: 2_000, cacheReadInputTokens: 90_000 },
        index: 900_001,
        callerLabel: "some-brand-new-feature",
        accounted: false,
      });
    }

    brandNewCallChainThatForgetsEverything();

    // 断言：它的用量出现在计费通道里，且被标记为"尚未入账"（= 需要消费侧记账）。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.usage.inputTokens).toBe(100_000);
    expect(seen[0]!.accounted).toBe(false);
    expect(seen[0]!.callerLabel).toBe("some-brand-new-feature");
  });

  test("主循环的流标记为已入账，消费侧据此不重复记账（双记去重）", () => {
    // 主循环那条链经 updateUsage + AfterModelRaw 入账，且它上报的 usage 是
    // **跨 attempt 累加**的。所以本通道对它只做归因、不再加钱。
    recordBilledRequest({
      fetchId: nextFetchId(),
      model: "deepseek-v4-pro",
      provider: "openai",
      usage: { inputTokens: 50_000, outputTokens: 1_000 },
      index: 17,
      accounted: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.accounted).toBe(true);
  });

  test("同一个 fetchId 重复上报只生效一次（幂等）", () => {
    // provider 的正常路径与异常路径都可能走到收口点，必须幂等 ——
    // 否则一条流被记两次钱，那是比漏记更难发现的错（数字看着"合理"）。
    const id = nextFetchId();
    const req: BilledRequest = {
      fetchId: id,
      model: "m",
      provider: "openai",
      usage: { inputTokens: 10, outputTokens: 1 },
      index: 1,
      accounted: false,
    };
    recordBilledRequest(req);
    recordBilledRequest(req);
    recordBilledRequest({ ...req });
    expect(seen).toHaveLength(1);
  });

  test("fetchId 是单次 fetch 粒度：两次 fetch 各自入账，不被去重吃掉", () => {
    // 去重键若做成"单轮"粒度，同一轮的 N 次 attempt 会被压成 1 次 → 漏记。
    for (let i = 0; i < 3; i++) {
      recordBilledRequest({
        fetchId: nextFetchId(),
        model: "m",
        provider: "openai",
        usage: { inputTokens: 1_000, outputTokens: 10 },
        index: 5, // 同一个 index（同一轮），三次不同的 fetch
        accounted: false,
      });
    }
    expect(seen).toHaveLength(3);
  });

  test("观察者抛异常不影响其余观察者与上报本身", () => {
    addBillingObserver(() => {
      throw new Error("boom");
    });
    const tail: BilledRequest[] = [];
    addBillingObserver((r) => tail.push(r));
    recordBilledRequest({
      fetchId: nextFetchId(),
      model: "m",
      provider: "openai",
      usage: { inputTokens: 1, outputTokens: 1 },
      index: 1,
      accounted: false,
    });
    expect(seen).toHaveLength(1);
    expect(tail).toHaveLength(1);
  });
});

describe("request-context：请求级身份（判据 3/5 的前提）", () => {
  test("未包上下文时读到 undefined，消费侧据此回落旧全局量", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  test("包住后内部任意深度（含 await）都能读到同一身份", async () => {
    const ctx = { turnIndex: 900_007, agentId: "fork:x", callerLabel: "agent:fork" };
    await withRequestContext(ctx, async () => {
      expect(getRequestContext()?.agentId).toBe("fork:x");
      await new Promise((r) => setTimeout(r, 1));
      // await 之后仍在 store 里 —— 这是 ALS 相对"逐层传参"的全部价值所在。
      expect(getRequestContext()?.turnIndex).toBe(900_007);
    });
    expect(getRequestContext()).toBeUndefined();
  });

  test("惰性 generator 的 body 全程可见身份（这条防的是最容易写错的形态）", async () => {
    // sendMessageStream 是惰性 async generator 工厂：只调用它 body 一行都不执行。
    // 若实现写成 `withRequestContext(ctx, () => makeStream())`，body 在下游 pull 时
    // 跑在**调用方**的 async context 里 —— 等于什么都没包。这条测试就是为了钉死它。
    const observedInsideBody: Array<string | undefined> = [];
    async function* provider(): AsyncGenerator<number> {
      observedInsideBody.push(getRequestContext()?.agentId);
      yield 1;
      await new Promise((r) => setTimeout(r, 1));
      observedInsideBody.push(getRequestContext()?.agentId);
      yield 2;
    }

    const ctx = { turnIndex: 900_008, agentId: "fork:lazy" };
    const out: number[] = [];
    for await (const v of streamInRequestContext(ctx, () => provider())) {
      // 注意：这个 for-await 体本身**不在** store 里（它是调用方代码），
      // 身份只需在 provider body 内可见 —— 那才是发计费事件的地方。
      out.push(v);
    }
    expect(out).toEqual([1, 2]);
    expect(observedInsideBody).toEqual(["fork:lazy", "fork:lazy"]);
  });

  test("下游提前 break 时 generator 的 finally 仍在身份内跑（计费挂在 finally）", async () => {
    // 这条是上一条的延伸，且更容易漏：计费收口挂在 provider 的 finally。
    // 若 `.return()` 不在 store 里调，提前 break 的流会丢掉身份，
    // 被误判成主循环的流（accounted=true）→ 那笔钱永远不入账。
    let idInFinally: string | undefined = "NOT_SET";
    async function* provider(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        idInFinally = getRequestContext()?.agentId;
      }
    }

    const ctx = { turnIndex: 900_009, agentId: "fork:break" };
    for await (const v of streamInRequestContext(ctx, () => provider())) {
      void v;
      break; // 提前退出 → 触发 provider 的 finally
    }
    expect(idInFinally).toBe("fork:break");
  });
});
