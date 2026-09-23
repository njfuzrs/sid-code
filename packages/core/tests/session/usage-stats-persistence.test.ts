/**
 * 用量统计持久化与恢复测试（修复：`-c` 恢复对话后 footer 状态栏统计全部丢失）
 *
 * 根因：footer 统计（token/费用/缓存节省）只活在内存态 SessionState，此前从未写入
 * 可恢复的会话文件，restoreSession 也从不回灌 → resume 后 SessionState 全新零值 →
 * Footer 按"零值隐藏"规则把整排统计抹掉。
 *
 * 修复三段：
 *  1. SessionState.serializeUsageSnapshot() / hydrateUsage()（本文件覆盖）
 *  2. app.persistUsageStats() 每轮 done 后 appendMetadata("usage_stats", …)
 *  3. app.restoreSession 读取 metadata["usage_stats"] 回灌
 * 这里覆盖 1（round-trip）+ 2 的落盘/读回（通过 SessionStore）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { SessionStore } from "@sid-code/core/session/store.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

describe("用量统计快照 serialize/hydrate round-trip", () => {
  test("累计若干次 API 调用后，snapshot 回灌到新实例，展示口径完全一致", () => {
    const orig = new SessionState("s-round-1");
    const usage1: Usage = {
      inputTokens: 40120,
      outputTokens: 3600,
      cacheReadInputTokens: 20000,
      cacheCreationInputTokens: 5000,
    };
    orig.updateUsage("claude-opus-4-8", usage1, 1200, "anthropic");
    orig.updateUsage("claude-opus-4-8", { inputTokens: 1000, outputTokens: 200 }, 300, "anthropic");
    orig.addSideCost(0.05);
    orig.addToolDuration(800);

    const snap = orig.serializeUsageSnapshot();

    // 模拟 resume：全新零值实例
    const restored = new SessionState("s-round-1-resumed");
    // 回灌前确认确实是零（复现 bug 现象）
    expect(restored.getEffectiveTotalCostUSD()).toBe(0);
    expect(restored.getStockPromptTokens()).toBe(0);

    restored.hydrateUsage(snap);

    // 回灌后 footer 展示所需的全部维度都对得上
    expect(restored.getEffectiveTotalCostUSD()).toBeCloseTo(orig.getEffectiveTotalCostUSD(), 10);
    expect(restored.getStockPromptTokens()).toBe(orig.getStockPromptTokens());
    expect(restored.getTotalCacheSavings()).toBeCloseTo(orig.getTotalCacheSavings(), 10);
    expect(restored.getTotalUsage()).toEqual(orig.getTotalUsage());
    expect(restored.getCumulativePromptTokens()).toBe(orig.getCumulativePromptTokens());
    expect(restored.totalCostUSD).toBeCloseTo(orig.totalCostUSD, 10);
    expect(restored.sideCostUSD).toBeCloseTo(orig.sideCostUSD, 10);
    expect(restored.totalAPIDuration).toBe(orig.totalAPIDuration);
    expect(restored.totalToolDuration).toBe(orig.totalToolDuration);
  });

  test("回灌后继续 updateUsage 在既有基础上累加（续做不断档）", () => {
    const orig = new SessionState("s-cont-1");
    orig.updateUsage(
      "claude-opus-4-8",
      { inputTokens: 10000, outputTokens: 500 },
      100,
      "anthropic",
    );
    const snap = orig.serializeUsageSnapshot();
    const costBefore = orig.getEffectiveTotalCostUSD();

    const restored = new SessionState("s-cont-1-resumed");
    restored.hydrateUsage(snap);
    // resume 后新增一轮
    restored.updateUsage(
      "claude-opus-4-8",
      { inputTokens: 2000, outputTokens: 300 },
      100,
      "anthropic",
    );

    // 输出 token 应是两轮累加（500 + 300），而非从 0 重算
    expect(restored.getTotalUsage().outputTokens).toBe(800);
    // 费用应大于回灌时的基线（在其上继续累加）
    expect(restored.getEffectiveTotalCostUSD()).toBeGreaterThan(costBefore);
  });

  test("hydrateUsage 对脏/空快照容错，不抛错且归零", () => {
    const s = new SessionState("s-dirty");
    expect(() => s.hydrateUsage(undefined)).not.toThrow();
    expect(() => s.hydrateUsage(null)).not.toThrow();
    // 缺字段/类型不符
    expect(() =>
      s.hydrateUsage({ modelUsage: { m: { outputTokens: "bad" } } } as any),
    ).not.toThrow();
    // 脏快照的 NaN 应被兜底成 0
    s.hydrateUsage({ modelUsage: { m: { outputTokens: "bad", provider: 123 } } } as any);
    expect(s.getTotalUsage().outputTokens).toBe(0);
    expect(s.totalCostUSD).toBe(0);
  });
});

describe("usage_stats metadata 落盘 + 读回（SessionStore）", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-code-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("serializeUsageSnapshot → appendMetadata → load 后可回灌，端到端等价", async () => {
    const state = new SessionState("usage-e2e-001");
    state.updateUsage(
      "claude-opus-4-8",
      {
        inputTokens: 40120,
        outputTokens: 3600,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 5000,
      },
      1000,
      "anthropic",
    );

    const store = new SessionStore();
    store.startSession("usage-e2e-001", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    store.appendMetadata("usage_stats", state.serializeUsageSnapshot());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("usage-e2e-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata?.["usage_stats"]).toBeDefined();

    // 模拟 restoreSession 的回灌
    const resumed = new SessionState("usage-e2e-001-resumed");
    resumed.hydrateUsage(loaded!.metadata!["usage_stats"] as any);

    expect(resumed.getEffectiveTotalCostUSD()).toBeCloseTo(state.getEffectiveTotalCostUSD(), 10);
    expect(resumed.getStockPromptTokens()).toBe(state.getStockPromptTokens());
    expect(resumed.getTotalCacheSavings()).toBeCloseTo(state.getTotalCacheSavings(), 10);
  });

  test("多轮 appendMetadata('usage_stats') 取最后一条（覆盖语义，恢复最新累计）", async () => {
    const store = new SessionStore();
    store.startSession("usage-overwrite-001", "m", "anthropic", "/cwd");

    const s1 = new SessionState("x");
    s1.updateUsage("m", { inputTokens: 1000, outputTokens: 100 }, 10, "anthropic");
    store.appendMetadata("usage_stats", s1.serializeUsageSnapshot());

    const s2 = new SessionState("x");
    s2.updateUsage("m", { inputTokens: 5000, outputTokens: 900 }, 10, "anthropic");
    store.appendMetadata("usage_stats", s2.serializeUsageSnapshot());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("usage-overwrite-001");
    const snap = loaded!.metadata?.["usage_stats"] as any;
    // 最后一条覆盖：输出 token = 900（第二次），而非 100
    expect(snap.modelUsage.m.outputTokens).toBe(900);
  });
});

/**
 * API 调用次数口径（状态栏 `⟳ N` 列的数据源）
 *
 * 背景：状态栏要显示"这次会话调了多少次模型"。候选计数器有三个，选中 `requests`
 * 的决定性理由就是**跨 resume / `/clear` 与同一行的邻居（token/cost）口径一致** ——
 * `SessionState.absoluteTurnCount` 既不持久化也不被 `resetCounters()` 清零，
 * 用它会渲染出「$0.43 全会话 + 3 轮 本进程」这种自相矛盾的行。
 * 这一组测试就是把"一致"这件事钉住。
 */
describe("API 调用次数 —— getTotalRequests / getDiscardedRequests", () => {
  test("每次 updateUsage 记一次调用，跨模型求和", () => {
    const st = new SessionState("req-1");
    st.updateUsage("m-a", { inputTokens: 100, outputTokens: 10 }, 5, "anthropic");
    st.updateUsage("m-a", { inputTokens: 200, outputTokens: 20 }, 5, "anthropic");
    st.updateUsage("m-b", { inputTokens: 300, outputTokens: 30 }, 5, "openai");
    expect(st.getTotalRequests()).toBe(3);
    expect(st.getDiscardedRequests()).toBe(0);
  });

  test("作废尝试（discarded=true）**计入** requests —— prompt 已发出并计费", () => {
    const st = new SessionState("req-2");
    st.updateUsage("m", { inputTokens: 100, outputTokens: 10 }, 5, "anthropic");
    // 第 2、3 次是超时/流内错误后重试，响应被丢弃但厂商已计费
    st.updateUsage("m", { inputTokens: 90, outputTokens: 0 }, 0, "anthropic", undefined, true);
    st.updateUsage("m", { inputTokens: 95, outputTokens: 0 }, 0, "anthropic", undefined, true);
    // 总调用 3 次，其中 2 次白烧 —— 白烧是子集，不是另一批调用
    expect(st.getTotalRequests()).toBe(3);
    expect(st.getDiscardedRequests()).toBe(2);
    expect(st.getDiscardedRequests()).toBeLessThanOrEqual(st.getTotalRequests());
  });

  test("零调用返回 0（状态栏据此隐藏该列，不显示 `⟳ 0`）", () => {
    const st = new SessionState("req-3");
    expect(st.getTotalRequests()).toBe(0);
    expect(st.getDiscardedRequests()).toBe(0);
  });

  test("resetCounters()（/clear）后归零 —— 与 token/cost 同步，不残留", () => {
    const st = new SessionState("req-4");
    st.updateUsage("m", { inputTokens: 100, outputTokens: 10 }, 5, "anthropic");
    st.updateUsage("m", { inputTokens: 90, outputTokens: 0 }, 0, "anthropic", undefined, true);
    expect(st.getTotalRequests()).toBe(2);

    st.resetCounters();

    // 三者必须同时归零：状态栏同一行里它们是邻居，任一不归零就是自相矛盾
    expect(st.getTotalRequests()).toBe(0);
    expect(st.getDiscardedRequests()).toBe(0);
    expect(st.getStockPromptTokens()).toBe(0);
    expect(st.getEffectiveTotalCostUSD()).toBe(0);
  });

  test("回归：resume 后白烧数不得凭空消失（hydrateUsage 曾漏读 discardedRequests）", () => {
    const orig = new SessionState("req-resume");
    orig.updateUsage("m", { inputTokens: 1000, outputTokens: 100 }, 10, "anthropic");
    orig.updateUsage("m", { inputTokens: 900, outputTokens: 0 }, 0, "anthropic", undefined, true);
    expect(orig.getTotalRequests()).toBe(2);
    expect(orig.getDiscardedRequests()).toBe(1);

    const resumed = new SessionState("req-resume-2");
    resumed.hydrateUsage(orig.serializeUsageSnapshot());

    // 分母（requests）此前就回灌，分子（discarded）此前漏读 → 状态栏 `⟳ 2 ✘1`
    // 在一次 resume 后变成 `⟳ 2`，表现为"重试白烧凭空消失"。两者必须一起连续。
    expect(resumed.getTotalRequests()).toBe(2);
    expect(resumed.getDiscardedRequests()).toBe(1);
  });

  test("回灌后继续累加：调用数与白烧数都在既有基础上续算，不断档", () => {
    const orig = new SessionState("req-cont");
    orig.updateUsage("m", { inputTokens: 1000, outputTokens: 100 }, 10, "anthropic");
    orig.updateUsage("m", { inputTokens: 900, outputTokens: 0 }, 0, "anthropic", undefined, true);

    const resumed = new SessionState("req-cont-2");
    resumed.hydrateUsage(orig.serializeUsageSnapshot());
    resumed.updateUsage("m", { inputTokens: 1100, outputTokens: 120 }, 10, "anthropic");
    resumed.updateUsage(
      "m",
      { inputTokens: 800, outputTokens: 0 },
      0,
      "anthropic",
      undefined,
      true,
    );

    expect(resumed.getTotalRequests()).toBe(4);
    expect(resumed.getDiscardedRequests()).toBe(2);
  });

  test("脏/旧快照缺 discardedRequests 字段 → 按 0 兜底，不抛错", () => {
    const st = new SessionState("req-legacy");
    st.hydrateUsage({
      totalCostUSD: 0.5,
      sideCostUSD: 0,
      totalAPIDuration: 100,
      totalToolDuration: 0,
      // 旧版快照：只有 requests，没有 discardedRequests
      modelUsage: {
        m: {
          inputTokens: 1000,
          stockPromptTokens: 1000,
          cumulativePromptTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          requests: 7,
          costUSD: 0.5,
          cacheSavingsUSD: 0,
          provider: "anthropic",
        },
      },
    } as any);
    expect(st.getTotalRequests()).toBe(7);
    expect(st.getDiscardedRequests()).toBe(0);
  });
});
