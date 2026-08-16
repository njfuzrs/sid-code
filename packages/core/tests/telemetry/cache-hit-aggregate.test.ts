/**
 * 缓存命中率公共聚合器测试
 *
 * ## 这个文件在防什么
 *
 * 命中率此前有**两个入口各写一份聚合**（`trace/cache-report.ts` 与
 * `scripts/northstar-snapshot.ts`），读同一份账本却给出 76.4% 与 68.2% 两个数 ——
 * 后者三层清洗一个都没做，而它恰好是进 release 曲线的那个。收口到
 * `telemetry/cache-hit-aggregate.ts` 之后，这里锁住四条**不变量**：
 *
 * 1. 重复会话行只算一次（账本里有 append 时代的残留）
 * 2. untrusted 渠道整行排除（实测某月卡网关的 usage 是编造的）
 * 3. 无 `appVersion` 的存量行排除出干净口径，且**对照值仍可算**
 * 4. 时间窗与版本过滤仍生效（northstar 的 --weekly / --compare 靠它们）
 *
 * 每条都配**反向自证**：只验"正常时对"测不出清洗是否真的在做 —— 一个恒等变换
 * 也能让前三条的正向断言全绿。
 *
 * 落盘隔离：经 SID_CODE_USAGE_LEDGER / SID_CODE_CHANNEL_TRUST 重定向到 tmp，
 * 不触碰真实 ~/.sid-code。env 一律**存/恢复原值**，不无条件 delete ——
 * bun test 同进程跑多文件，delete 会抹掉 preload 的兜底。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateCacheHit,
  CACHE_HIT_SOURCE,
} from "@sid-code/core/telemetry/cache-hit-aggregate.ts";
import type { UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";
import type { ChannelTrustRegistry } from "@sid-code/core/telemetry/channel-trust.ts";

let dir: string;
const savedLedger = process.env.SID_CODE_USAGE_LEDGER;
const savedTrust = process.env.SID_CODE_CHANNEL_TRUST;
// cache-report 会读中断历史，也必须重定向 —— 否则那个用例会读真实 ~/.sid-code
const savedBreaks = process.env.SID_CODE_CACHE_BREAKS;

const TS = 1_700_000_000;

/**
 * 默认造**当前采集代码写的行**（带 appVersion）。
 *
 * 这个默认值是刻意的：无 `appVersion` 的行被判存量并排除出干净口径，若默认不带版本，
 * 测 trust / 去重 的用例会因为"整批被当存量排除"而全部变成 null，
 * 测出来的东西就不是它们的题目了。**要测存量路径请显式传 `appVersion: undefined`**。
 */
function entry(over: Partial<UsageLedgerEntry> & { sessionId: string }): UsageLedgerEntry {
  return {
    ts: TS,
    model: "glm-5.2",
    provider: "openai",
    promptTotal: 10_000,
    cacheHit: 8_000,
    cacheWrite: 0,
    uncachedInput: 2_000,
    output: 500,
    costUSD: 0.01,
    savingsUSD: 0.02,
    durationMs: 1_000,
    appVersion: "0.1.601",
    ...over,
  };
}

function writeLedger(entries: UsageLedgerEntry[]): void {
  writeFileSync(
    process.env.SID_CODE_USAGE_LEDGER!,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

function writeTrust(reg: ChannelTrustRegistry): void {
  writeFileSync(process.env.SID_CODE_CHANNEL_TRUST!, JSON.stringify(reg), "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-cache-hit-agg-"));
  process.env.SID_CODE_USAGE_LEDGER = join(dir, "usage-ledger.jsonl");
  process.env.SID_CODE_CHANNEL_TRUST = join(dir, "channel-trust.json");
  process.env.SID_CODE_CACHE_BREAKS = join(dir, "cache-breaks.jsonl");
});

afterEach(() => {
  if (savedLedger === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
  else process.env.SID_CODE_USAGE_LEDGER = savedLedger;
  if (savedTrust === undefined) delete process.env.SID_CODE_CHANNEL_TRUST;
  else process.env.SID_CODE_CHANNEL_TRUST = savedTrust;
  if (savedBreaks === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
  else process.env.SID_CODE_CACHE_BREAKS = savedBreaks;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("不变量 1：重复会话行只算一次", () => {
  test("同一 sessionId 的多行按 latest-wins 折成一行", () => {
    // append 时代的残留形态：同一会话被增量 append 了 3 次，数字逐次增长。
    // 不去重的话 4000+8000+10000 = 22000 会被当成分子，命中率直接爆表。
    writeLedger([
      entry({ sessionId: "s1", promptTotal: 5_000, cacheHit: 4_000 }),
      entry({ sessionId: "s1", promptTotal: 9_000, cacheHit: 8_000 }),
      entry({ sessionId: "s1", promptTotal: 10_000, cacheHit: 9_000 }),
    ]);
    const a = aggregateCacheHit();
    expect(a.excluded.duplicateRows).toBe(2);
    expect(a.cleanSessions).toBe(1);
    // 只保留最后一行：9000/10000
    expect(a.cleanPromptTotal).toBe(10_000);
    expect(a.cleanCacheHit).toBe(9_000);
    expect(a.hitRate).toBeCloseTo(0.9, 9);
  });

  test("反向自证：不去重会得到另一个数（确认这道防御真的在改结果）", () => {
    const rows = [
      entry({ sessionId: "s1", promptTotal: 5_000, cacheHit: 500 }),
      entry({ sessionId: "s1", promptTotal: 5_000, cacheHit: 4_500 }),
    ];
    writeLedger(rows);
    const a = aggregateCacheHit();
    // 去重后 = 4500/5000 = 0.9；若漏了去重则 5000/10000 = 0.5
    expect(a.hitRate).toBeCloseTo(0.9, 9);
    expect(a.hitRate).not.toBeCloseTo(0.5, 2);
  });

  test("无重复时是恒等变换，duplicateRows 为 0", () => {
    writeLedger([entry({ sessionId: "a" }), entry({ sessionId: "b" })]);
    const a = aggregateCacheHit();
    expect(a.excluded.duplicateRows).toBe(0);
    expect(a.cleanSessions).toBe(2);
  });
});

describe("不变量 2：untrusted 渠道整行排除", () => {
  const untrusted: ChannelTrustRegistry = {
    channels: {
      "fake.example.com": {
        host: "fake.example.com",
        verdict: "untrusted",
        failedCriteria: ["A", "C"],
        reason: "全新前缀 r1 即报命中",
      },
    },
  };

  test("伪造 usage 的渠道不进分子分母（否则凭空抬高整体数字）", () => {
    writeTrust(untrusted);
    writeLedger([
      // 真实渠道：低命中
      entry({
        sessionId: "real",
        endpointHost: "api.deepseek.com",
        promptTotal: 10_000,
        cacheHit: 1_000,
      }),
      // 伪造渠道：报满命中，混进去会把总计从 10% 抬到 55%
      entry({
        sessionId: "fake",
        endpointHost: "fake.example.com",
        promptTotal: 10_000,
        cacheHit: 10_000,
      }),
    ]);
    const a = aggregateCacheHit();
    expect(a.excluded.untrustedRows).toBe(1);
    expect(a.excluded.untrustedPromptTotal).toBe(10_000);
    expect(a.excluded.untrustedCacheHit).toBe(10_000);
    expect(a.cleanSessions).toBe(1);
    expect(a.hitRate).toBeCloseTo(0.1, 9);
    // 反向自证：若排除没生效会是 0.55
    expect(a.hitRate).not.toBeCloseTo(0.55, 2);
  });

  test("unknown（未探测 / 无 host）按可信计入 —— 一律排除会让指标变空值", () => {
    writeTrust(untrusted);
    writeLedger([
      entry({ sessionId: "nohost", endpointHost: undefined }),
      entry({ sessionId: "unprobed", endpointHost: "never.probed.example" }),
    ]);
    const a = aggregateCacheHit();
    expect(a.excluded.untrustedRows).toBe(0);
    expect(a.cleanSessions).toBe(2);
    // 无 host 的那行必须被单独数出来：它不是"已确认可信"，是"判不了"
    expect(a.excluded.rowsWithoutHost).toBe(1);
  });

  test("排除量为 0 时 rowsWithoutHost 仍如实报告（覆盖盲区必须可见）", () => {
    // 空登记表 = 什么都没探测过。此时"已排除 0 行"读起来像"总计干净"，
    // 而真相是这些行没带 host 所以根本没进判定。
    writeLedger([entry({ sessionId: "a" }), entry({ sessionId: "b" })]);
    const a = aggregateCacheHit();
    expect(a.excluded.untrustedRows).toBe(0);
    expect(a.excluded.rowsWithoutHost).toBe(2);
  });
});

describe("不变量 3：无 appVersion 的存量行排除出干净口径，对照值仍可算", () => {
  test("存量行不进干净口径，但含存量口径与存量自身口径都算得出来", () => {
    writeLedger([
      // 当前采集代码：高命中
      entry({ sessionId: "new", promptTotal: 10_000, cacheHit: 8_000 }),
      // 2026-08-08 前的存量：已知漏采 cacheHit，数字偏低
      entry({ sessionId: "old", appVersion: undefined, promptTotal: 90_000, cacheHit: 9_000 }),
    ]);
    const a = aggregateCacheHit();

    expect(a.excluded.legacyRows).toBe(1);
    expect(a.excluded.legacyPromptTotal).toBe(90_000);
    expect(a.excluded.legacyCacheHit).toBe(9_000);

    // 干净口径只含新行
    expect(a.cleanSessions).toBe(1);
    expect(a.hitRate).toBeCloseTo(0.8, 9);

    // 对照值必须仍可算 —— 只报"已排除 N 行"而不给对照，
    // 分不清"存量本来不脏"与"排除没接上"
    expect(a.hitRateIncludingLegacy).toBeCloseTo(17_000 / 100_000, 9);
    expect(a.legacyHitRate).toBeCloseTo(0.1, 9);
    expect(a.countedSessions).toBe(2);
  });

  test("全是存量行时 hitRate 为 null，绝不回落到含存量的数字", () => {
    // 回落会让"这个总计是干净的"这个承诺在最需要它的场景下静默失效。
    writeLedger([
      entry({ sessionId: "o1", appVersion: undefined }),
      entry({ sessionId: "o2", appVersion: undefined }),
    ]);
    const a = aggregateCacheHit();
    expect(a.hitRate).toBeNull();
    expect(a.cleanSessions).toBe(0);
    expect(a.cleanPromptTotal).toBe(0);
    // 对照口径此时仍有值 —— 这正是能看出"排除了什么"的地方
    expect(a.hitRateIncludingLegacy).toBeCloseTo(0.8, 9);
    expect(a.legacyHitRate).toBeCloseTo(0.8, 9);
  });

  test("判据是字段缺失而非版本号比较（0.1.99 vs 0.1.100 上字符串比较会排错）", () => {
    writeLedger([
      entry({ sessionId: "v99", appVersion: "0.1.99" }),
      entry({ sessionId: "v100", appVersion: "0.1.100" }),
    ]);
    const a = aggregateCacheHit();
    // 两个都有字段 → 两个都算干净，一个都不该被判存量
    expect(a.excluded.legacyRows).toBe(0);
    expect(a.cleanSessions).toBe(2);
  });

  test("空字符串 appVersion 与缺失同等对待（都不是可信的版本标记）", () => {
    writeLedger([entry({ sessionId: "empty", appVersion: "" })]);
    const a = aggregateCacheHit();
    expect(a.excluded.legacyRows).toBe(1);
    expect(a.hitRate).toBeNull();
  });

  test("untrusted 行的存量份额不重复计入排除量（否则「排除了多少」失真）", () => {
    writeTrust({
      channels: {
        "fake.example.com": { host: "fake.example.com", verdict: "untrusted" },
      },
    });
    writeLedger([
      entry({ sessionId: "keep" }),
      // 同时满足"untrusted"与"无版本" —— 只该被算作 untrusted 一次
      entry({ sessionId: "both", endpointHost: "fake.example.com", appVersion: undefined }),
    ]);
    const a = aggregateCacheHit();
    expect(a.excluded.untrustedRows).toBe(1);
    expect(a.excluded.legacyRows).toBe(0);
    expect(a.excluded.legacyPromptTotal).toBe(0);
  });
});

describe("不变量 4：时间窗与版本过滤仍生效", () => {
  const NOW = new Date(TS * 1000);

  test("windowDays 只保留窗口内的行", () => {
    writeLedger([
      entry({ sessionId: "recent", ts: TS - 2 * 86_400, promptTotal: 1_000, cacheHit: 900 }),
      entry({ sessionId: "ancient", ts: TS - 60 * 86_400, promptTotal: 1_000, cacheHit: 100 }),
    ]);
    const a = aggregateCacheHit({ windowDays: 7, now: NOW });
    expect(a.cleanSessions).toBe(1);
    expect(a.hitRate).toBeCloseTo(0.9, 9);
    // 反向自证：不过滤时两行都在，命中率是 0.5
    const all = aggregateCacheHit({ now: NOW });
    expect(all.cleanSessions).toBe(2);
    expect(all.hitRate).toBeCloseTo(0.5, 9);
  });

  test("onlyVersion 只保留该版本的行，且过滤不存在的版本得到 null 而非回落全量", () => {
    writeLedger([
      entry({ sessionId: "a", appVersion: "0.1.600", promptTotal: 1_000, cacheHit: 100 }),
      entry({ sessionId: "b", appVersion: "0.1.601", promptTotal: 1_000, cacheHit: 900 }),
    ]);
    expect(aggregateCacheHit({ onlyVersion: "0.1.601" }).hitRate).toBeCloseTo(0.9, 9);
    expect(aggregateCacheHit({ onlyVersion: "0.1.600" }).hitRate).toBeCloseTo(0.1, 9);

    // 反向自证：过滤一个不存在的版本必须得到空样本，而不是静默回落到全量
    const none = aggregateCacheHit({ onlyVersion: "9.9.9" });
    expect(none.cleanSessions).toBe(0);
    expect(none.hitRate).toBeNull();
  });

  test("去重发生在窗口过滤之前（否则边界外的 upsert 会让旧脏值留下）", () => {
    // 同一会话：窗口外有一条旧的（脏值），窗口内有最新的一条。
    // 若先按窗口切再去重，旧行被切掉后新行留下 —— 结果碰巧也对；
    // 但反过来若窗口内只剩旧行、最新行在窗口外，先切窗口就会留下旧脏值。
    // 这里构造后者：最新一行在窗口外。
    writeLedger([
      entry({ sessionId: "s", ts: TS - 30 * 86_400, promptTotal: 1_000, cacheHit: 100 }),
      entry({ sessionId: "s", ts: TS - 1 * 86_400, promptTotal: 1_000, cacheHit: 900 }),
    ]);
    const a = aggregateCacheHit({ windowDays: 7, now: NOW });
    // latest-wins 先生效 → 保留窗口内那条 900
    expect(a.excluded.duplicateRows).toBe(1);
    expect(a.cleanSessions).toBe(1);
    expect(a.hitRate).toBeCloseTo(0.9, 9);
  });
});

describe("口径自述", () => {
  test("source 串写明三层清洗 —— 口径变了描述必须跟着变", () => {
    // 说不出取数源的数字就是自我感觉；而 source 串停在旧口径上比不写更糟：
    // 它会让人以为这个数是裸账本除法，从而拿去和别处的裸除法结果作对比。
    writeLedger([entry({ sessionId: "a" })]);
    const a = aggregateCacheHit();
    expect(a.source).toBe(CACHE_HIT_SOURCE);
    expect(a.source).toContain("usage-ledger.jsonl");
    expect(a.source).toContain("去重");
    expect(a.source).toContain("untrusted");
    expect(a.source).toContain("appVersion");
  });

  test("返回的 entries 已去重并过滤，供分行视图在同一份行上分组", () => {
    // cache-report 的「模型 × 渠道」分行必须用这份 entries，否则分行与总计
    // 各读一次账本 → 两侧数字对不上，又变回"一套数据两个说法"
    writeLedger([
      entry({ sessionId: "s1" }),
      entry({ sessionId: "s1" }),
      entry({ sessionId: "s2" }),
    ]);
    const a = aggregateCacheHit();
    expect(a.entries.length).toBe(2);
    expect(a.entries.map((e) => e.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  test("空账本：全部比率为 null，计数为 0（null 不得退化成 0%）", () => {
    writeLedger([]);
    const a = aggregateCacheHit();
    expect(a.hitRate).toBeNull();
    expect(a.hitRateIncludingLegacy).toBeNull();
    expect(a.legacyHitRate).toBeNull();
    expect(a.cleanSessions).toBe(0);
    expect(a.countedSessions).toBe(0);
    expect(a.excluded.duplicateRows).toBe(0);
  });

  test("promptTotal / cacheHit 缺失或非数时按 0 计，绝不让 NaN 进累加器", () => {
    // NaN 一旦进了累加器，整个比值变成 NaN 且没有任何报错，是最难查的一类脏数据
    writeLedger([
      { ...entry({ sessionId: "bad" }), promptTotal: undefined, cacheHit: undefined } as never,
      entry({ sessionId: "ok", promptTotal: 1_000, cacheHit: 500 }),
    ]);
    const a = aggregateCacheHit();
    expect(Number.isNaN(a.hitRate)).toBe(false);
    expect(a.hitRate).toBeCloseTo(0.5, 9);
  });
});

describe("两个入口口径一致（本次收口要修的缺陷本身）", () => {
  test("cache-report 的总计与聚合器给出同一个数", async () => {
    // 这条是**跨模块**断言：cache-report 曾自己写一份聚合，与 northstar 那份
    // 给出 76.4% vs 68.2%。收口后两侧必须逐位相同 —— 差一点就说明有一侧
    // 又偷偷做了自己的清洗。
    writeLedger([
      entry({ sessionId: "s1", endpointHost: "api.deepseek.com" }),
      entry({ sessionId: "s1", endpointHost: "api.deepseek.com" }),
      entry({ sessionId: "s2", appVersion: undefined, promptTotal: 50_000, cacheHit: 5_000 }),
    ]);
    const { buildCacheReport } = await import("@sid-code/core/trace/cache-report.ts");
    const r = buildCacheReport();
    const a = aggregateCacheHit();

    expect(r.totalHitRate).toBe(a.hitRate);
    expect(r.totalHitRateIncludingLegacy).toBe(a.hitRateIncludingLegacy);
    expect(r.legacyHitRate).toBe(a.legacyHitRate);
    expect(r.sessionsWithoutVersion).toBe(a.excluded.legacyRows);
    expect(r.excludedLegacyPromptTotal).toBe(a.excluded.legacyPromptTotal);
    expect(r.excludedLegacyCacheHit).toBe(a.excluded.legacyCacheHit);
    expect(r.sessionsWithoutHost).toBe(a.excluded.rowsWithoutHost);
  });
});
