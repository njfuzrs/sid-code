/**
 * usage-aggregator 单测 —— 周期聚合 + P0-4 渠道可信度排除。
 *
 * ⚠️ 本文件是**补的**：`usage-aggregator.ts` 此前零测试覆盖，而它是 `/cache` 的
 * 唯一数据源。后果是 P0-4（不可信渠道排除出总计）只做在 `src/trace/cache-report.ts`
 * 里、`/cache` 完全没接，却没有任何机制发现 —— 方案的验收项写着
 * "`/cache` 输出里 ppchat 的行带警示且不进总计"，实际产品内看不到。
 *
 * **教训：一个模块是某条对外数字的唯一来源，就必须有测试站在它后面。**
 * 「另一个模块已经实现了这个语义」不代表这个入口也实现了。
 *
 * 隔离：本文件调用 `readUsageLedger`（读侧）与 `readChannelTrust`（读侧），
 * 两者都不落盘，但仍显式设 SID_CODE_USAGE_LEDGER / SID_CODE_CHANNEL_TRUST 到 tmpdir ——
 * 否则测试会读用户真实账本，变成"只在本机数据恰好合适时才通过"。
 * 存/恢复原值而非无条件 delete（见 CLAUDE.md 测试约定：同批多文件跑在同一进程）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";
import type { ChannelTrustRegistry } from "@sid-code/core/telemetry/channel-trust.ts";
import {
  aggregateEntries,
  aggregateOverall,
  aggregateUsage,
  periodKey,
} from "@sid-code/core/telemetry/usage-aggregator.ts";

let tmpDir: string;
const savedLedger = process.env.SID_CODE_USAGE_LEDGER;
const savedTrust = process.env.SID_CODE_CHANNEL_TRUST;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sid-aggregator-"));
  process.env.SID_CODE_USAGE_LEDGER = join(tmpDir, "usage-ledger.jsonl");
  process.env.SID_CODE_CHANNEL_TRUST = join(tmpDir, "channel-trust.json");
});

afterEach(() => {
  if (savedLedger === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
  else process.env.SID_CODE_USAGE_LEDGER = savedLedger;
  if (savedTrust === undefined) delete process.env.SID_CODE_CHANNEL_TRUST;
  else process.env.SID_CODE_CHANNEL_TRUST = savedTrust;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function entry(over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    ts: 1786000000,
    sessionId: `s-${Math.round(over.ts ?? 1786000000)}-${over.model ?? "m"}`,
    model: "glm-5.2",
    promptTotal: 10000,
    cacheHit: 8000,
    cacheWrite: 0,
    uncachedInput: 2000,
    output: 500,
    costUSD: 0.01,
    savingsUSD: 0.02,
    durationMs: 1000,
    ...over,
  } as UsageLedgerEntry;
}

/** 只含一个 untrusted 渠道的登记表（判据与真实探针产出同形状） */
function registry(): ChannelTrustRegistry {
  return {
    channels: {
      "code.ppchat.vip": {
        host: "code.ppchat.vip",
        verdict: "untrusted",
        failedCriteria: ["A", "B", "C"],
        reason: "全新前缀首次请求即报命中（服务端从未见过该前缀）",
        probedAt: 1786177861,
      },
      "gw.example.com": {
        host: "gw.example.com",
        verdict: "trusted",
        probedAt: 1786177883,
      },
    },
  };
}

describe("periodKey", () => {
  test("day / month 按 UTC 切分", () => {
    expect(periodKey(1786000000, "day")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(periodKey(1786000000, "month")).toMatch(/^\d{4}-\d{2}$/);
  });

  test("week 用 ISO 8601 周数（周一为周首）", () => {
    expect(periodKey(1786000000, "week")).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("aggregateEntries：基础聚合", () => {
  test("加权命中率的分母是 promptTotal 而非会话数", () => {
    // 两个会话命中率差很多但输入量也差很多 —— 按会话平均会得出错误答案
    const r = aggregateEntries(
      [
        entry({ model: "a", promptTotal: 1000, cacheHit: 100 }),   // 10%
        entry({ model: "a", promptTotal: 99000, cacheHit: 90000 }), // 90.9%
      ],
      "p",
      registry(),
    );
    // 正确：90100/100000 = 90.1%。按会话平均会得到 (10+90.9)/2 ≈ 50.5%
    expect(r.totalHitRate).toBeCloseTo(0.901, 3);
  });

  test("promptTotal=0 时命中率为 0 而不是 NaN", () => {
    const r = aggregateEntries([entry({ promptTotal: 0, cacheHit: 0 })], "p", registry());
    expect(r.totalHitRate).toBe(0);
    expect(Number.isNaN(r.totalHitRate)).toBe(false);
  });

  test("空输入不崩，且各总量为 0", () => {
    const r = aggregateEntries([], "p", registry());
    expect(r.totalSessions).toBe(0);
    expect(r.totalHitRate).toBe(0);
    expect(r.excludedUntrustedRows).toBe(0);
    expect(r.untrustedHosts).toEqual([]);
  });
});

describe("P0-4：不可信渠道排除出统计", () => {
  test("★ untrusted 行既不进 byModel 也不进总计", () => {
    const r = aggregateEntries(
      [
        entry({ model: "claude-sonnet-5", endpointHost: "code.ppchat.vip", promptTotal: 100000, cacheHit: 99000, costUSD: 5, savingsUSD: 9 }),
        entry({ model: "glm-5.2", endpointHost: "gw.example.com", promptTotal: 10000, cacheHit: 5000, costUSD: 1, savingsUSD: 2 }),
      ],
      "p",
      registry(),
    );

    // 假数字完全不参与：命中率 = 5000/10000，不是 104000/110000（94.5%）
    expect(r.totalHitRate).toBeCloseTo(0.5, 6);
    expect(r.totalCostUSD).toBeCloseTo(1, 6);
    expect(r.totalSavingsUSD).toBeCloseTo(2, 6);
    // 被排除的模型不出现在 byModel —— 出现了就会被渲染层当正常行打印
    expect(Object.keys(r.byModel)).toEqual(["glm-5.2"]);
  });

  test("★ 覆盖盲区：无 host 的行按可信计入，但必须单独计数可上报", () => {
    // 这条锚死本轮发现的真实状况：ppchat 判为 untrusted，但账本里 ppchat 的行
    // 一条都没有 endpointHost（该字段 2026-08-08 才落地），于是排除了 **0 行**。
    // 若只暴露 excludedUntrustedRows，"排除 0"会被读成"总计干净" —— 而脏数据还在里面。
    const r = aggregateEntries(
      [
        entry({ endpointHost: undefined }),
        entry({ endpointHost: undefined }),
        entry({ endpointHost: "gw.example.com" }),
      ],
      "p",
      registry(),
    );
    expect(r.excludedUntrustedRows).toBe(0);   // 什么都没排掉
    expect(r.sessionsWithoutHost).toBe(2);     // 但有 2 个会话压根没被判定
    expect(r.totalSessions).toBe(3);           // 三行都计入了
  });

  test("全部带 host 且可信时，盲区计数为 0（不误报）", () => {
    const r = aggregateEntries(
      [entry({ endpointHost: "gw.example.com" })],
      "p",
      registry(),
    );
    expect(r.sessionsWithoutHost).toBe(0);
  });

  test("★ 排除必须留痕：行数 + host + 理由都可读", () => {
    const r = aggregateEntries(
      [
        entry({ endpointHost: "code.ppchat.vip" }),
        entry({ endpointHost: "code.ppchat.vip" }),
        entry({ endpointHost: "gw.example.com" }),
      ],
      "p",
      registry(),
    );
    expect(r.excludedUntrustedRows).toBe(2);
    // 同一渠道多行只报一次 host
    expect(r.untrustedHosts).toHaveLength(1);
    expect(r.untrustedHosts[0]!.host).toBe("code.ppchat.vip");
    expect(r.untrustedHosts[0]!.reason).toContain("全新前缀");
  });

  test("★ totalSessions 与三个总量同口径：只数计入的行", () => {
    // 若这里用 entries.length，就会出现"3 会话"配上"排除 2 行后的命中率"，分母对不上
    const r = aggregateEntries(
      [
        entry({ endpointHost: "code.ppchat.vip" }),
        entry({ endpointHost: "code.ppchat.vip" }),
        entry({ endpointHost: "gw.example.com" }),
      ],
      "p",
      registry(),
    );
    expect(r.totalSessions).toBe(1);
  });

  test("unknown 渠道按可信处理（含旧账本行无 endpointHost）", () => {
    // 把没探测过的一律排除，会让 /cache 在探针跑之前显示空表 —— 比不排除更糟。
    // 判据链见 channel-trust.ts 头注释。
    const r = aggregateEntries(
      [
        entry({ endpointHost: undefined, promptTotal: 10000, cacheHit: 6000 }),
        entry({ endpointHost: "never-probed.example.com", promptTotal: 10000, cacheHit: 4000 }),
      ],
      "p",
      registry(),
    );
    expect(r.excludedUntrustedRows).toBe(0);
    expect(r.totalSessions).toBe(2);
    expect(r.totalHitRate).toBeCloseTo(0.5, 6);
  });

  test("trusted 渠道正常计入（判据是 untrusted，不是「有 endpointHost 就排除」）", () => {
    const r = aggregateEntries(
      [entry({ endpointHost: "gw.example.com" })],
      "p",
      registry(),
    );
    expect(r.excludedUntrustedRows).toBe(0);
    expect(r.totalSessions).toBe(1);
  });

  test("空登记表时全部计入（探针还没跑过的机器不该看到空表）", () => {
    const r = aggregateEntries(
      [entry({ endpointHost: "code.ppchat.vip" })],
      "p",
      { channels: {} },
    );
    expect(r.excludedUntrustedRows).toBe(0);
    expect(r.totalSessions).toBe(1);
  });
});

describe("P0-4：模型行带渠道标注", () => {
  test("单渠道模型记一个 host", () => {
    const r = aggregateEntries(
      [entry({ model: "glm-5.2", endpointHost: "gw.example.com" })],
      "p",
      registry(),
    );
    expect(r.byModel["glm-5.2"]!.hosts).toEqual(["gw.example.com"]);
  });

  test("★ 同模型跨渠道：两个 host 都保留，不合并", () => {
    // 合并成一个百分比恰恰掩盖了渠道差异 —— 而"这个数能不能信"取决于渠道
    const r = aggregateEntries(
      [
        entry({ model: "glm-5.2", endpointHost: "gw.example.com" }),
        entry({ model: "glm-5.2", endpointHost: "gw-b.example.com" }),
        entry({ model: "glm-5.2", endpointHost: "gw.example.com" }),
      ],
      "p",
      registry(),
    );
    // 去重且保持首次出现顺序
    expect(r.byModel["glm-5.2"]!.hosts).toEqual(["gw.example.com", "gw-b.example.com"]);
    expect(r.byModel["glm-5.2"]!.sessions).toBe(3);
  });

  test("旧账本行（无 endpointHost）hosts 为空数组，不是 [undefined]", () => {
    const r = aggregateEntries([entry({ endpointHost: undefined })], "p", registry());
    expect(r.byModel["glm-5.2"]!.hosts).toEqual([]);
  });
});

describe("aggregateUsage / aggregateOverall：从账本读", () => {
  function writeLedger(entries: UsageLedgerEntry[]): void {
    writeFileSync(
      process.env.SID_CODE_USAGE_LEDGER!,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }
  function writeTrust(reg: ChannelTrustRegistry): void {
    writeFileSync(process.env.SID_CODE_CHANNEL_TRUST!, JSON.stringify(reg));
  }

  test("★ 端到端：账本 + 登记表 → /cache 的总计已排除不可信渠道", () => {
    writeTrust(registry());
    writeLedger([
      entry({ sessionId: "s1", model: "claude-sonnet-5", endpointHost: "code.ppchat.vip", promptTotal: 100000, cacheHit: 99000 }),
      entry({ sessionId: "s2", model: "glm-5.2", endpointHost: "gw.example.com", promptTotal: 10000, cacheHit: 5000 }),
    ]);

    const overall = aggregateOverall();
    expect(overall.excludedUntrustedRows).toBe(1);
    expect(overall.totalHitRate).toBeCloseTo(0.5, 6);
    expect(Object.keys(overall.byModel)).toEqual(["glm-5.2"]);
  });

  test("按周期分组时每组各自统计排除数", () => {
    writeTrust(registry());
    const day1 = 1786000000;
    const day2 = day1 + 86400 * 2;
    writeLedger([
      entry({ sessionId: "a1", ts: day1, endpointHost: "code.ppchat.vip" }),
      entry({ sessionId: "a2", ts: day1, endpointHost: "gw.example.com" }),
      entry({ sessionId: "b1", ts: day2, endpointHost: "gw.example.com" }),
    ]);

    const periods = aggregateUsage({ granularity: "day" });
    expect(periods).toHaveLength(2);
    expect(periods[0]!.excludedUntrustedRows).toBe(1);
    expect(periods[1]!.excludedUntrustedRows).toBe(0);
    // 周期按键升序
    expect(periods[0]!.period < periods[1]!.period).toBe(true);
  });

  test("登记表文件损坏时全部计入而不是抛错（度量绝不阻断）", () => {
    writeFileSync(process.env.SID_CODE_CHANNEL_TRUST!, "{ 这不是 JSON");
    writeLedger([entry({ sessionId: "s1", endpointHost: "code.ppchat.vip" })]);
    const overall = aggregateOverall();
    expect(overall.totalSessions).toBe(1);
    expect(overall.excludedUntrustedRows).toBe(0);
  });

  test("model 过滤支持精确与前缀", () => {
    writeTrust({ channels: {} });
    writeLedger([
      entry({ sessionId: "s1", model: "glm-5.2" }),
      entry({ sessionId: "s2", model: "origin-deepseek-v4-pro" }),
    ]);
    expect(Object.keys(aggregateOverall({ model: "glm-5.2" }).byModel)).toEqual(["glm-5.2"]);
    expect(Object.keys(aggregateOverall({ model: "origin-deepseek" }).byModel))
      .toEqual(["origin-deepseek-v4-pro"]);
  });

  test("sinceDays 按 ts 过滤", () => {
    writeTrust({ channels: {} });
    const now = 1786000000;
    writeLedger([
      entry({ sessionId: "old", ts: now - 86400 * 10 }),
      entry({ sessionId: "new", ts: now - 3600 }),
    ]);
    const r = aggregateOverall({ sinceDays: 2, nowSeconds: now });
    expect(r.totalSessions).toBe(1);
  });
});
