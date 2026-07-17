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
import { SessionState } from "../../src/session/state.ts";
import { SessionStore } from "../../src/session/store.ts";
import type { Usage } from "../../src/llm/types.ts";
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
    orig.updateUsage("claude-opus-4-8", { inputTokens: 10000, outputTokens: 500 }, 100, "anthropic");
    const snap = orig.serializeUsageSnapshot();
    const costBefore = orig.getEffectiveTotalCostUSD();

    const restored = new SessionState("s-cont-1-resumed");
    restored.hydrateUsage(snap);
    // resume 后新增一轮
    restored.updateUsage("claude-opus-4-8", { inputTokens: 2000, outputTokens: 300 }, 100, "anthropic");

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
    expect(() => s.hydrateUsage({ modelUsage: { m: { outputTokens: "bad" } } } as any)).not.toThrow();
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
    state.updateUsage("claude-opus-4-8", {
      inputTokens: 40120,
      outputTokens: 3600,
      cacheReadInputTokens: 20000,
      cacheCreationInputTokens: 5000,
    }, 1000, "anthropic");

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
