/**
 * D1（P0）：一轮结束后的辅助调用入账必须推到状态栏。
 *
 * 这是本次修复唯一跨层的缺陷：core（SessionState 入账通知）→ cli（cost-bridge 订阅）→
 * UI（StateBridge 状态）。之前只有五处固定时机（tool_end / done / 轮末 finally / 中断
 * catch / 首帧）重新读费用，而辅助调用（后台记忆 fork、标题生成、SessionEnd 前的收尾）
 * 全部发生在一轮结束之后 —— 那五个时机都已经过去了。
 *
 * 实测后果：一次会话 Footer 停在 $0.0856（只有主循环），真实总花费 $0.1501，
 * 少报 43%；用户不再输入就永不更新，要等下一轮第一个工具结束才一次性跳上去。
 *
 * 本文件用**真实的 SessionState + StateBridge + 生产订阅函数**复刻 app.ts 的接线，
 * 而不是在测试里把同样的字段抄一遍 —— 抄件测不到接线本身。
 *
 * 变异自证（CLAUDE.md：新增回归必须先把代码改坏看断言变红）：
 * - 去掉 `app.ts` 里的 subscribeCostToBridge 调用 → 第二个用例的 costUSD 断言变红；
 * - 在 cost-bridge.ts 的 patch 里加 stockInputTokens → 第三个用例变红。
 */

import { describe, expect, test } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { StateBridge } from "@sid-code/cli/ui/state-bridge.ts";
import { subscribeCostToBridge } from "@sid-code/cli/ui/cost-bridge.ts";

/** updateStreaming 的合帧窗口是 32ms，等两倍窗口 + 余量，避免慢 runner 上抖 */
const FLUSH_WAIT_MS = 80;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 复刻 app.ts 的接线：真实 SessionState + 真实 StateBridge 首帧字段。
 * `getOutputTps` 与生产同形（app.ts 传的是 `() => traceCollector?.getOutputTps()`），
 * 这里传假 getter 是为了单测不必拉起整个 trace 层——接线测的是「有没有推」，不是「怎么算」。
 */
function wire(getOutputTps?: () => number | undefined) {
  const sessionState = new SessionState("d1-bridge");
  const bridge = new StateBridge({
    costUSD: sessionState.getEffectiveTotalCostUSD(),
    cacheSavingsUSD: sessionState.getTotalCacheSavings(),
    usage: { ...sessionState.getTotalUsage() },
    totalRequests: sessionState.getTotalRequests(),
    discardedRequests: sessionState.getDiscardedRequests(),
    // 主循环入账才会变的字段，订阅不应推它
    stockInputTokens: sessionState.getStockPromptTokens(),
  } as any);
  const frames: number[] = [];
  bridge.on("change", (s: any) => frames.push(s.costUSD));
  const off = subscribeCostToBridge(sessionState, bridge, getOutputTps);
  return { sessionState, bridge, frames, off };
}

describe("D1 · 入账 → 状态栏接线", () => {
  test("主循环入账：costUSD 经合帧推成状态（基线行为不被破坏）", async () => {
    const { sessionState, bridge, frames, off } = wire();

    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);

    const expected = sessionState.getEffectiveTotalCostUSD();
    expect(expected).toBeGreaterThan(0);
    expect(bridge.current.costUSD).toBeCloseTo(expected, 12);
    expect(frames.length).toBeGreaterThan(0);
    off();
    bridge.detach();
  });

  test("一轮结束后才发生的辅助调用入账，同样推到状态（D1 核心）", async () => {
    const { sessionState, bridge, off } = wire();

    // 一轮结束：主循环最后一次入账之后，app.ts 的 done / 轮末 finally 已经跑完
    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);
    const mainOnly = bridge.current.costUSD;
    expect(mainOnly).toBeGreaterThan(0);

    // 用户不再输入，后台记忆 fork / 标题生成在这之后入账（本次会话真实数字 $0.0645）
    sessionState.addSideCost(0.0645);
    await sleep(FLUSH_WAIT_MS);

    // 修复前：没有任何一条路径会推 UI，Footer 永远停在 mainOnly
    expect(bridge.current.costUSD).toBeCloseTo(sessionState.getEffectiveTotalCostUSD(), 12);
    expect(bridge.current.costUSD).toBeGreaterThan(mainOnly);
    off();
    bridge.detach();
  });

  test("辅助入账不改「当前上下文大小」：subscription 不推 stockInputTokens", async () => {
    const { sessionState, bridge, off } = wire();
    const stockBefore = bridge.current.stockInputTokens;

    sessionState.addSideCost(0.0645);
    await sleep(FLUSH_WAIT_MS);

    expect(bridge.current.costUSD).toBeCloseTo(0.0645, 12);
    expect(bridge.current.stockInputTokens).toBe(stockBefore);
    off();
    bridge.detach();
  });

  test("反注册后不再推状态（TUI 卸载后不往没人消费的状态里写）", async () => {
    const { sessionState, bridge, off } = wire();

    off();
    sessionState.addSideCost(0.0645);
    await sleep(FLUSH_WAIT_MS);

    expect(bridge.current.costUSD).toBe(0);
    bridge.detach();
  });

  test("同一 SessionState 上账本落盘的旧单槽位观察者不会被挤掉", () => {
    const sessionState = new SessionState("d1-ledger-coexist");
    const ledger: number[] = [];
    sessionState.setCostChangeListener((cost) => ledger.push(cost));

    const bridge = new StateBridge({ costUSD: 0, stockInputTokens: 0 } as any);
    const off = subscribeCostToBridge(sessionState, bridge);

    sessionState.addSideCost(0.01);

    // 账本那条线（旧接口）与 UI 这条线（新接口）都收到
    expect(ledger).toEqual([0.01]);
    expect(bridge.current.costUSD).toBeCloseTo(0.01, 12);
    off();
    bridge.detach();
  });

  /**
   * D18（P1）：Footer ⚡ 命中率必须按**每个模型自己的 provider** 归一化后加总，
   * 不能用「全会话合计 usage + 当前模型推断的 provider」。
   *
   * 变异自证：把 cost-bridge 改回「合计 usage + 当前模型 provider」→ 本用例红
   * （11000 被当成 openai 的 prompt_tokens、命中 15500 比它还大 → 141%，不是 78%）。
   */
  test("D18：命中率按每个模型自己的协议族归一化（跨族会话算对）", async () => {
    const { sessionState, bridge, off } = wire();

    // 主模型 openai（input 含命中）+ 子代理 anthropic（input 是未命中余量）
    sessionState.updateUsage(
      "claude-3-5-sonnet",
      { inputTokens: 1000, outputTokens: 0, cacheReadInputTokens: 9000 },
      1,
      "anthropic",
    );
    sessionState.updateUsage(
      "gpt-4o",
      { inputTokens: 10000, outputTokens: 0, cacheReadInputTokens: 6500 },
      1,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);

    // anthropic: promptTotal = 1000(未命中) + 9000(命中) = 10000，命中 9000
    // openai:    promptTotal = 10000(含命中)，命中 6500
    // 合计: 命中 15500 / promptTotal 20000 = 77.5% → 78%
    expect(sessionState.getCacheHitRate()).toBe(78);
    expect(bridge.current.cacheHitRate).toBe(78);
    off();
    bridge.detach();
  });
});

describe("吞吐列 · 入账 → 状态栏接线", () => {
  test("每笔入账都重读 tps getter，并推进 outputTps", async () => {
    let tps: number | undefined;
    const { sessionState, bridge, off } = wire(() => tps);

    // 首轮生成结束：collector 已累加样本 → getter 开始有值
    tps = 41.2;
    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);
    expect(bridge.current.outputTps).toBeCloseTo(41.2, 6);

    // 下一轮生成更慢，累计均值被拉低 —— 入账时再读一次，UI 跟着变
    tps = 30;
    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);
    expect(bridge.current.outputTps).toBeCloseTo(30, 6);
    off();
    bridge.detach();
  });

  test("getter 返回 undefined（无样本 / trace 关闭）→ outputTps 落 undefined，不落 0", async () => {
    const { sessionState, bridge, off } = wire(() => undefined);

    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);

    // 关键区分：undefined = 「没样本，Footer 隐藏该列」；0 会被渲染成 `⇢0/s`
    expect(bridge.current.outputTps).toBeUndefined();
    off();
    bridge.detach();
  });

  test("读数回落：先有值 41 → getter 再返回 undefined → outputTps 归 undefined", async () => {
    // /clear 重建 trace（gen_samples 归 0）或 trace 中途关闭时，入账拿到的是 undefined。
    // 若不覆盖旧值，状态栏会一直停在上一会话的 `⇢41/s`。
    // 这条卡的是「回退」——上一条（getter 恒返回 undefined）在「完全不推送」时同样通过，
    // 区分不出「推了 undefined」与「压根没推」，所以两者都要有。
    let tps: number | undefined = 41;
    const { sessionState, bridge, off } = wire(() => tps);

    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);
    expect(bridge.current.outputTps).toBeCloseTo(41, 6);

    tps = undefined;
    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);
    expect(bridge.current.outputTps).toBeUndefined();
    off();
    bridge.detach();
  });

  test("省略 getter（未接 trace 的旧调用方）→ 不推该字段，其余照常", async () => {
    const { sessionState, bridge, off } = wire();

    sessionState.updateUsage(
      "deepseek-v4-pro",
      { inputTokens: 1000, outputTokens: 100 },
      10,
      "openai",
    );
    await sleep(FLUSH_WAIT_MS);

    expect(bridge.current.outputTps).toBeUndefined();
    expect(bridge.current.costUSD).toBeGreaterThan(0);
    off();
    bridge.detach();
  });
});
