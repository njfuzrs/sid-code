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
  upsertUsageLedger,
  readUsageLedger,
  pruneUsageLedger,
  dedupeBySession,
} from "@sid-code/core/telemetry/usage-ledger.ts";
import type { UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";
import {
  periodKey,
  aggregateUsage,
  aggregateOverall,
} from "@sid-code/core/telemetry/usage-aggregator.ts";

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

/**
 * P3-2：必须存/恢复原值，不能无条件 delete。
 *
 * `bun test` 同一批多文件跑在**同一个进程**里，无条件 delete 会把别的文件
 *（或 preload 兜底 tests/preload-isolate-sid-home.ts）设的隔离一起抹掉，
 * 于是后续文件静默写进用户真实路径。实测同类问题：`bun test tests/permission`
 * 单跑泄漏 0 行，而 `tests/migrations tests/permission` 同批跑泄漏 84 行 ——
 * 就是 migrations 里无条件删掉了隔离变量。
 *
 * 这条规则本文件自己曾违反，而 no-real-path-writes.test.ts 的报错文案里
 * 正写着"不要无条件 delete" —— 门禁只扫"有没有设隔离"，扫不出"恢复方式错了"。
 */
const savedLedgerEnv = process.env.SID_CODE_USAGE_LEDGER;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sid-ledger-"));
  process.env.SID_CODE_USAGE_LEDGER = join(tmpDir, "usage-ledger.jsonl");
});

afterEach(() => {
  if (savedLedgerEnv === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
  else process.env.SID_CODE_USAGE_LEDGER = savedLedgerEnv;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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

  /**
   * P0-1：`appVersion` 是**可选**字段，混合固件必须全部解析成功。
   *
   * 存量 377 行没有这个字段，把它设成必填会让 `readUsageLedger()` 整批丢行 ——
   * 而 readUsageLedger 的失败是静默的（catch 里跳过损坏行），一次改动就能让
   * 历史成本数据凭空消失且没有任何报错。
   */
  test("混合固件（5 行有 appVersion + 5 行无）10 行全部解析成功", () => {
    for (let i = 0; i < 5; i++) {
      appendUsageLedger(entry({ sessionId: `new${i}`, appVersion: "0.1.601" }));
    }
    for (let i = 0; i < 5; i++) {
      appendUsageLedger(entry({ sessionId: `old${i}`, appVersion: undefined }));
    }
    const all = readUsageLedger();
    expect(all.length).toBe(10);
    expect(all.filter((e) => e.appVersion === "0.1.601").length).toBe(5);
  });

  test("无 appVersion 的行读回是 undefined —— 不是空串，也不抛错", () => {
    // 这条防的是 explicit-undefined-punches-through-defaults 那类击穿：
    // 落盘时写 `"appVersion": undefined` 或 `""` 都会让消费侧的
    // 「字段缺失 = 存量数据」判据失效（空串是有值的，`!e.appVersion` 虽然仍为真，
    // 但 JSON 里多出一个键会让"这行没版本"与"这行版本是空"再也分不开）。
    appendUsageLedger(entry({ sessionId: "old", appVersion: undefined }));
    const [row] = readUsageLedger();
    expect(row!.appVersion).toBeUndefined();
    expect("appVersion" in row!).toBe(false);
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

describe("upsertUsageLedger（每轮增量落盘 · 按 sessionId 去重 latest-wins）", () => {
  test("同一会话多次 upsert 只保留一行，取最后一次值", () => {
    // 模拟长驻会话每轮 done 后增量落盘：cost 逐轮累加
    upsertUsageLedger(entry({ sessionId: "long", costUSD: 0.01, promptTotal: 1000 }));
    upsertUsageLedger(entry({ sessionId: "long", costUSD: 0.05, promptTotal: 5000 }));
    upsertUsageLedger(entry({ sessionId: "long", costUSD: 0.12, promptTotal: 12000 }));
    const all = readUsageLedger();
    expect(all.length).toBe(1);
    expect(all[0].costUSD).toBeCloseTo(0.12, 10);
    expect(all[0].promptTotal).toBe(12000);
  });

  test("不同会话各占一行", () => {
    upsertUsageLedger(entry({ sessionId: "a" }));
    upsertUsageLedger(entry({ sessionId: "b" }));
    upsertUsageLedger(entry({ sessionId: "a", costUSD: 0.9 })); // 覆盖 a
    const all = readUsageLedger();
    expect(all.length).toBe(2);
    const byId = Object.fromEntries(all.map((e) => [e.sessionId, e]));
    expect(byId["a"].costUSD).toBeCloseTo(0.9, 10);
    expect(byId["b"]).toBeDefined();
  });

  test("增量 upsert 在求和型聚合里不翻倍（核心回归：长会话成本不虚高）", () => {
    // 同一会话 upsert 30 次（模拟 30 轮），聚合后成本/会话数应等于「一行」的效果
    for (let i = 1; i <= 30; i++) {
      upsertUsageLedger(entry({ sessionId: "s", costUSD: 0.001 * i, promptTotal: 100 * i }));
    }
    const o = aggregateOverall();
    expect(o.totalSessions).toBe(1); // 不是 30
    expect(o.totalCostUSD).toBeCloseTo(0.03, 10); // 最后一次值，不是 Σ
  });
});

describe("dedupeBySession（读侧防御 · 兼容历史 append 多行）", () => {
  test("剔除同会话早期行，保留最后一行", () => {
    const deduped = dedupeBySession([
      entry({ sessionId: "x", costUSD: 0.1 }),
      entry({ sessionId: "y", costUSD: 0.2 }),
      entry({ sessionId: "x", costUSD: 0.3 }), // x 的最终值
    ]);
    expect(deduped.length).toBe(2);
    const byId = Object.fromEntries(deduped.map((e) => [e.sessionId, e]));
    expect(byId["x"].costUSD).toBeCloseTo(0.3, 10);
    expect(byId["y"].costUSD).toBeCloseTo(0.2, 10);
  });

  test("无重复时是恒等变换", () => {
    const input = [entry({ sessionId: "a" }), entry({ sessionId: "b" }), entry({ sessionId: "c" })];
    expect(dedupeBySession(input)).toEqual(input);
  });

  test("聚合器读侧对历史 append 多行去重（append 时代的脏数据不再翻倍）", () => {
    // 模拟旧版本 append 时代:同一会话被 append 了 3 行
    appendUsageLedger(entry({ sessionId: "legacy", costUSD: 0.01 }));
    appendUsageLedger(entry({ sessionId: "legacy", costUSD: 0.02 }));
    appendUsageLedger(entry({ sessionId: "legacy", costUSD: 0.03 }));
    const o = aggregateOverall();
    expect(o.totalSessions).toBe(1);
    expect(o.totalCostUSD).toBeCloseTo(0.03, 10);
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
    appendUsageLedger(entry({ sessionId: "s1", cacheHit: 5000, promptTotal: 6000 }));
    appendUsageLedger(entry({ sessionId: "s2", cacheHit: 1000, promptTotal: 4000 }));
    const o = aggregateOverall();
    expect(o.totalSessions).toBe(2);
    expect(o.totalHitRate).toBeCloseTo(6000 / 10000, 10);
    expect(o.totalSavingsUSD).toBeCloseTo(0.004, 10);
  });

  test("按模型分组聚合", () => {
    appendUsageLedger(entry({ sessionId: "s1", model: "deepseek-v4-pro", cacheHit: 5000 }));
    appendUsageLedger(
      entry({
        sessionId: "s2",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        cacheHit: 2000,
      }),
    );
    const o = aggregateOverall();
    expect(Object.keys(o.byModel).sort()).toEqual(
      ["claude-sonnet-4-20250514", "deepseek-v4-pro"].sort(),
    );
    expect(o.byModel["deepseek-v4-pro"].cacheHit).toBe(5000);
  });

  test("--model 过滤（前缀匹配）", () => {
    appendUsageLedger(entry({ sessionId: "s1", model: "deepseek-v4-pro" }));
    appendUsageLedger(entry({ sessionId: "s2", model: "gpt-4o", provider: "openai" }));
    const o = aggregateOverall({ model: "deepseek" });
    expect(o.totalSessions).toBe(1);
  });

  test("sinceDays 时间窗过滤", () => {
    const now = 1_700_000_000;
    appendUsageLedger(entry({ sessionId: "old", ts: now - 10 * 86400 })); // 10 天前
    appendUsageLedger(entry({ sessionId: "recent", ts: now - 1 * 86400 })); // 1 天前
    const o = aggregateOverall({ sinceDays: 3, nowSeconds: now });
    expect(o.totalSessions).toBe(1);
  });

  test("按周期分组并升序", () => {
    appendUsageLedger(entry({ sessionId: "d1", ts: 1_700_000_000 })); // 2023-11-14
    appendUsageLedger(entry({ sessionId: "d2", ts: 1_700_000_000 + 86400 })); // 2023-11-15
    const periods = aggregateUsage({ granularity: "day" });
    expect(periods.length).toBe(2);
    expect(periods[0].period < periods[1].period).toBe(true);
  });

  test("空账本总览 totalSessions=0", () => {
    expect(aggregateOverall().totalSessions).toBe(0);
  });
});
