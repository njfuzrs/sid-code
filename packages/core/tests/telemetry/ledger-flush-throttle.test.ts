/**
 * 发现 8（20261020 ce7ea52e）：账本节流刷新 + 入账观察者 + 「一次提问多轮后 abort，账本已更新」。
 *
 * 那次会话一次提问内跑了 1300+ 轮、最后被 abort：done 从未到达，账本停在第 1 问的 $0.17，
 * 真实花费 $11.2。本文件锁三件事：
 *   ① 节流判据（≥30s 或成本增量 ≥$0.1，成本没涨不刷）；
 *   ② SessionState 每次入账都通知观察者（主循环 updateUsage、旁路 addSideCost 两条路都要）；
 *   ③ 端到端：观察者 → 节流 → upsertUsageLedger，多轮后不经 done，账本已是最新值；
 *      abort 强刷补上节流窗口内最后那笔。
 *   ④ app.ts 接线（源码断言：app 层起不来，按跨域字面量锁住）。
 *
 * 隔离：upsertUsageLedger 写 SID_CODE_USAGE_LEDGER；buildUsageLedgerEntry 经 getIdentity 落 deviceId，
 * 所以 SID_CONFIG_DIR 也重定向。两者都存/恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldFlushLedger,
  LedgerFlushThrottle,
  LEDGER_FLUSH_MIN_INTERVAL_MS,
} from "@sid-code/core/telemetry/ledger-flush-throttle.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { buildUsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger-entry.ts";
import { upsertUsageLedger, readUsageLedger } from "@sid-code/core/telemetry/usage-ledger.ts";

describe("① shouldFlushLedger 节流判据", () => {
  const at = (atMs: number, costUSD: number, version = 1) => ({ atMs, costUSD, version });

  test("从未刷新：有入账就刷，无入账不刷", () => {
    expect(shouldFlushLedger(null, 0, 0.001, 1)).toBe(true);
    expect(shouldFlushLedger(null, 0, 0, 0)).toBe(false);
  });

  test("成本增量 ≥ $0.1 → 立刻刷（不等 30s）", () => {
    expect(shouldFlushLedger(at(0, 1), 1000, 1.1, 2)).toBe(true);
    expect(shouldFlushLedger(at(0, 1), 1000, 1.09, 2)).toBe(false);
  });

  test("间隔 ≥ 30s 且有新入账 → 刷", () => {
    expect(shouldFlushLedger(at(0, 1), LEDGER_FLUSH_MIN_INTERVAL_MS, 1.001, 2)).toBe(true);
    expect(shouldFlushLedger(at(0, 1), LEDGER_FLUSH_MIN_INTERVAL_MS - 1, 1.001, 2)).toBe(false);
  });

  test("无新入账（版本未变）→ 时间再久也不刷", () => {
    expect(shouldFlushLedger(at(0, 1), 10 * 60_000, 1, 1)).toBe(false);
  });

  test("零成本 provider：成本恒 0 但有新入账，过 30s 照样刷", () => {
    expect(shouldFlushLedger(null, 0, 0, 1)).toBe(true);
    expect(shouldFlushLedger(at(0, 0), LEDGER_FLUSH_MIN_INTERVAL_MS, 0, 2)).toBe(true);
  });

  test("LedgerFlushThrottle：isDirty 只在有新入账时为真；reset 后回到初始", () => {
    let now = 0;
    const t = new LedgerFlushThrottle(() => now);
    expect(t.isDirty(0)).toBe(false);
    expect(t.isDirty(1)).toBe(true);
    t.markFlushed(0.5, 1);
    expect(t.isDirty(1)).toBe(false);
    // 零成本入账同样算脏（本地 provider 改前 done 无条件落行，不能回退）
    expect(t.isDirty(2)).toBe(true);
    now = 5_000;
    expect(t.shouldFlush(0.55, 2)).toBe(false);
    expect(t.shouldFlush(0.65, 2)).toBe(true);
    t.reset();
    expect(t.shouldFlush(0.01, 3)).toBe(true);
  });
});

describe("② SessionState 入账观察者", () => {
  test("updateUsage 与 addSideCost 各通知一次，带有效总成本", () => {
    const ss = new SessionState("obs");
    const seen: number[] = [];
    ss.setCostChangeListener((c) => seen.push(c));
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 }, 10, "openai");
    ss.addSideCost(0.25);
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(ss.getEffectiveTotalCostUSD());
    expect(seen[1]).toBeGreaterThan(0.25);
  });

  test("观察者抛错不影响入账", () => {
    const ss = new SessionState("obs-throw");
    ss.setCostChangeListener(() => {
      throw new Error("boom");
    });
    ss.addSideCost(0.3);
    expect(ss.getEffectiveTotalCostUSD()).toBeCloseTo(0.3, 10);
  });
});

describe("③ 端到端：一次提问多轮后 abort，账本已更新", () => {
  let tmp: string;
  const saved = {
    cfg: process.env.SID_CONFIG_DIR,
    ledger: process.env.SID_CODE_USAGE_LEDGER,
  };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sid-ledger-throttle-"));
    process.env.SID_CONFIG_DIR = tmp;
    process.env.SID_CODE_USAGE_LEDGER = join(tmp, "usage-ledger.jsonl");
  });
  afterEach(() => {
    if (saved.cfg === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = saved.cfg;
    if (saved.ledger === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
    else process.env.SID_CODE_USAGE_LEDGER = saved.ledger;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 复刻 app.ts 的两个方法：flushSessionLedgerIncremental（强刷）/ flushSessionLedgerThrottled */
  function wire(ss: SessionState, now: () => number) {
    const throttle = new LedgerFlushThrottle(now);
    const force = () => {
      const cost = ss.getEffectiveTotalCostUSD();
      const version = ss.getUsageVersion();
      if (!throttle.isDirty(version)) return;
      const e = buildUsageLedgerEntry({ sessionState: ss });
      if (!e) return;
      upsertUsageLedger(e);
      throttle.markFlushed(cost, version);
    };
    ss.setCostChangeListener((c) => {
      if (throttle.shouldFlush(c, ss.getUsageVersion())) force();
    });
    return { force };
  }

  const ledgerCost = (id: string) => readUsageLedger().find((e) => e.sessionId === id)?.costUSD;

  test("多轮入账不经 done：账本随节流前进；abort 强刷补齐最后一笔", () => {
    let now = 0;
    const ss = new SessionState("abort-mid-prompt");
    const { force } = wire(ss, () => now);
    // 第 1 笔：主循环入账（账本行要求 promptTotal > 0，纯旁路成本构不成账本行）。从未刷过 → 立刻落盘
    ss.updateUsage("deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 }, 10, "openai");
    const c0 = ss.getEffectiveTotalCostUSD();
    expect(c0).toBeGreaterThan(0);
    expect(c0).toBeLessThan(0.1); // 下面的增量判断以此为前提
    expect(ledgerCost("abort-mid-prompt")).toBeCloseTo(c0, 10);
    // 一次提问内多轮小额入账，30s 内、增量 < $0.1 → 不刷
    now = 1_000;
    ss.addSideCost(0.02);
    ss.addSideCost(0.02);
    expect(ledgerCost("abort-mid-prompt")).toBeCloseTo(c0, 10);
    // 增量累计到 ≥ $0.1 → 刷
    ss.addSideCost(0.07);
    expect(ledgerCost("abort-mid-prompt")).toBeCloseTo(c0 + 0.11, 10);
    // 节流窗口内又花了一笔，随后 abort（done 永远不到）→ 强刷
    now = 2_000;
    ss.addSideCost(0.01);
    expect(ledgerCost("abort-mid-prompt")).toBeCloseTo(c0 + 0.11, 10);
    force();
    expect(ledgerCost("abort-mid-prompt")).toBeCloseTo(c0 + 0.12, 10);
    // 每会话恒一行（upsert）
    expect(readUsageLedger().filter((e) => e.sessionId === "abort-mid-prompt").length).toBe(1);
  });
  test("零成本 provider：强刷照样落行（改前 done 无条件写，不能回退成永不落盘）", () => {
    const ss = new SessionState("zero-cost-local");
    const { force } = wire(ss, () => 0);
    ss.updateUsage("llama3", { inputTokens: 1000, outputTokens: 100 }, 10, "ollama");
    expect(ss.getEffectiveTotalCostUSD()).toBe(0);
    force();
    expect(readUsageLedger().some((e) => e.sessionId === "zero-cost-local")).toBe(true);
  });
});

describe("④ app.ts 接线（源码断言）", () => {
  const src = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");

  test("构造 SessionState 后立即挂入账观察者 → 节流刷新", () => {
    expect(src).toMatch(
      /this\.sessionState\.setCostChangeListener\(\(cost\) => this\.flushSessionLedgerThrottled\(cost\)\)/,
    );
  });

  test("onUserInput 内层 finally 里强刷（abort / 异常收尾覆盖）", () => {
    const i = src.indexOf("stopPreventSleep();\n        // 发现 8：abort / 异常收尾时强刷账本一次");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 400)).toContain("this.flushSessionLedgerIncremental();");
  });

  test("/clear 换会话时重置节流状态", () => {
    const i = src.indexOf("this.sessionState.rotate(newSessionId);");
    expect(src.slice(i, i + 200)).toContain("this.ledgerFlushThrottle.reset();");
  });
});
