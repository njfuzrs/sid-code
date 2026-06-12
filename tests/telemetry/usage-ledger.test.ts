/**
 * 用量账本（usage-ledger）+ 聚合器（usage-aggregator）测试
 *
 * 用 SID_CODE_USAGE_LEDGER 重定向到临时文件，避免污染真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendUsageLedger,
  readUsageLedger,
  pruneUsageLedger,
} from "../../src/telemetry/usage-ledger.ts";
import type { UsageLedgerEntry } from "../../src/telemetry/usage-ledger.ts";
import {
  periodKey,
  aggregateUsage,
  aggregateOverall,
} from "../../src/telemetry/usage-aggregator.ts";

let tmpDir: string;

function entry(over: Partial<UsageLedgerEntry>): UsageLedgerEntry {
  return {
    ts: 1_700_000_000,
    sessionId: "s1",
    model: "deepseek-v4-pro",
    provider: "openai",
    promptTotal: 6000,
    cacheHit: 5000,
    cacheWrite: 0,
    uncachedInput: 1000,
    output: 200,
    costUSD: 0.001,
    savingsUSD: 0.002,
    durationMs: 1000,
    ...over,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sid-ledger-"));
  process.env.SID_CODE_USAGE_LEDGER = join(tmpDir, "usage-ledger.jsonl");
});

afterEach(() => {
  delete process.env.SID_CODE_USAGE_LEDGER;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("usage-ledger 读写", () => {
  test("append 后能读回", () => {
    appendUsageLedger(entry({ sessionId: "a" }));
    appendUsageLedger(entry({ sessionId: "b" }));
    const all = readUsageLedger();
    expect(all.length).toBe(2);
    expect(all[0].sessionId).toBe("a");
    expect(all[1].sessionId).toBe("b");
  });

  test("文件不存在返回空数组", () => {
    expect(readUsageLedger()).toEqual([]);
  });

  test("损坏行被跳过", () => {
    const path = process.env.SID_CODE_USAGE_LEDGER!;
    const { appendFileSync } = require("node:fs");
    appendUsageLedger(entry({ sessionId: "ok" }));
    appendFileSync(path, "这不是 json\n");
    appendUsageLedger(entry({ sessionId: "ok2" }));
    const all = readUsageLedger();
    expect(all.length).toBe(2);
  });

  test("maxEntries 只取尾部 N 行", () => {
    for (let i = 0; i < 5; i++) appendUsageLedger(entry({ sessionId: `s${i}` }));
    const last2 = readUsageLedger(2);
    expect(last2.length).toBe(2);
    expect(last2[0].sessionId).toBe("s3");
    expect(last2[1].sessionId).toBe("s4");
  });

  test("prune 保留最近 N 行", () => {
    for (let i = 0; i < 10; i++) appendUsageLedger(entry({ sessionId: `s${i}` }));
    const kept = pruneUsageLedger(3);
    expect(kept).toBe(3);
    const all = readUsageLedger();
    expect(all.length).toBe(3);
    expect(all[0].sessionId).toBe("s7");
  });
});

describe("periodKey", () => {
  test("day 粒度 YYYY-MM-DD", () => {
    // 2023-11-14 22:13:20 UTC
    expect(periodKey(1_700_000_000, "day")).toBe("2023-11-14");
  });
  test("month 粒度 YYYY-MM", () => {
    expect(periodKey(1_700_000_000, "month")).toBe("2023-11");
  });
  test("week 粒度 YYYY-Www（ISO 周）", () => {
    const k = periodKey(1_700_000_000, "week");
    expect(k).toMatch(/^2023-W\d{2}$/);
  });
});

describe("aggregateUsage / aggregateOverall", () => {
  test("总览加权命中率 = Σhit / ΣpromptTotal", () => {
    appendUsageLedger(entry({ cacheHit: 5000, promptTotal: 6000 }));
    appendUsageLedger(entry({ cacheHit: 1000, promptTotal: 4000 }));
    const o = aggregateOverall();
    expect(o.totalSessions).toBe(2);
    expect(o.totalHitRate).toBeCloseTo(6000 / 10000, 10);
    expect(o.totalSavingsUSD).toBeCloseTo(0.004, 10);
  });

  test("按模型分组聚合", () => {
    appendUsageLedger(entry({ model: "deepseek-v4-pro", cacheHit: 5000 }));
    appendUsageLedger(entry({ model: "claude-sonnet-4-20250514", provider: "anthropic", cacheHit: 2000 }));
    const o = aggregateOverall();
    expect(Object.keys(o.byModel).sort()).toEqual(
      ["claude-sonnet-4-20250514", "deepseek-v4-pro"].sort(),
    );
    expect(o.byModel["deepseek-v4-pro"].cacheHit).toBe(5000);
  });

  test("--model 过滤（前缀匹配）", () => {
    appendUsageLedger(entry({ model: "deepseek-v4-pro" }));
    appendUsageLedger(entry({ model: "gpt-4o", provider: "openai" }));
    const o = aggregateOverall({ model: "deepseek" });
    expect(o.totalSessions).toBe(1);
  });

  test("sinceDays 时间窗过滤", () => {
    const now = 1_700_000_000;
    appendUsageLedger(entry({ ts: now - 10 * 86400 }));  // 10 天前
    appendUsageLedger(entry({ ts: now - 1 * 86400 }));   // 1 天前
    const o = aggregateOverall({ sinceDays: 3, nowSeconds: now });
    expect(o.totalSessions).toBe(1);
  });

  test("按周期分组并升序", () => {
    appendUsageLedger(entry({ ts: 1_700_000_000 }));            // 2023-11-14
    appendUsageLedger(entry({ ts: 1_700_000_000 + 86400 }));    // 2023-11-15
    const periods = aggregateUsage({ granularity: "day" });
    expect(periods.length).toBe(2);
    expect(periods[0].period < periods[1].period).toBe(true);
  });

  test("空账本总览 totalSessions=0", () => {
    expect(aggregateOverall().totalSessions).toBe(0);
  });
});
