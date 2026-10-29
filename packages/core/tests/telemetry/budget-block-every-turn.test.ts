/**
 * 配额与预算规则 4 项缺陷回归（2026-10-22 核对官网 team/quota.md 时发现）
 *
 * 1. 超限只拦一次：硬停判定与告警去重共用一个状态，exceeded 报一次之后再也不拦
 * 2. budgetRules 不计影子调用：只记主调用 thisCost，口径和 costLimit 不一致
 * 3. 周期键按 UTC 算：UTC+8 下 daily 早上 8 点翻天，weekly 从周四开始
 * 4. /clear 不重置 budgetRules 告警级别与 session 周期累计
 */

// 周期键按本地时区算，固定一个非 UTC 时区才能让「按 UTC 算」的旧实现现形
process.env.TZ = "Asia/Shanghai";

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QuotaManager } from "@sid-code/core/llm/quota.ts";
import {
  BudgetTracker,
  budgetPeriodKey,
  type BudgetRule,
} from "@sid-code/core/telemetry/metrics/budget-tracker.ts";
import { checkPreRequestBudgetStop } from "@sid-code/core/query/loop.ts";

const rule = (over: Partial<BudgetRule> = {}): BudgetRule => ({
  id: "r1",
  name: "会话预算",
  period: "session",
  limitUSD: 1,
  thresholds: { warning: 0.5, critical: 0.8, exceeded: 1.0 },
  action: "block",
  ...over,
});

describe("缺陷 1：超限后每一轮都拦", () => {
  test("costLimit：check 报过 exceeded 之后 isExceeded 仍为 true，请求前硬停仍生效", () => {
    const qm = new QuotaManager(1);
    expect(qm.check(1.2)?.level).toBe("exceeded");
    // 告警去重照旧：同级别不再报
    expect(qm.check(2)).toBeNull();
    // 硬停判定不受去重影响
    expect(qm.isExceeded(2)).toBe(true);
    for (const cost of [2, 5]) {
      const stop = checkPreRequestBudgetStop({ quotaManager: qm }, cost);
      expect(stop?.source).toBe("quota");
      expect(stop?.text).toContain("仍拦截");
    }
  });

  test("budgetRules block：exceeded 报过一次后 findBlockingRule 每轮仍命中", () => {
    const bt = new BudgetTracker([rule()]);
    expect(bt.recordTurn(1.2, 1.2, {})?.level).toBe("exceeded");
    // 第二、三轮：告警不重复，但硬停仍在
    expect(bt.recordTurn(1.5, 0.3, {})).toBeUndefined();
    expect(bt.findBlockingRule()?.rule.id).toBe("r1");
    expect(bt.recordTurn(3, 1.5, {})).toBeUndefined();
    expect(bt.findBlockingRule()?.rule.id).toBe("r1");
    expect(checkPreRequestBudgetStop({ budgetTracker: bt }, 3)?.source).toBe("budget_rule");
  });

  test("action=alert 的规则超限不拦", () => {
    const bt = new BudgetTracker([rule({ action: "alert" })]);
    bt.recordTurn(2, 2, {});
    expect(bt.findBlockingRule()).toBeUndefined();
    expect(checkPreRequestBudgetStop({ budgetTracker: bt }, 2)).toBeNull();
  });

  test("主循环接线：硬停走 isExceeded / findBlockingRule，请求前也查一次", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf-8");
    const body = src.slice(src.indexOf("export async function* queryLoop("));
    expect(/quotaManager\.isExceeded\(effectiveCost\)/.test(body)).toBe(true);
    expect(/budgetTracker\.findBlockingRule\(\)/.test(body)).toBe(true);
    // 请求前硬停必须在发请求之前
    const pre = body.search(/checkPreRequestBudgetStop\(\s*loopConfig/);
    const send = body.indexOf("deps.sendWithRetry(");
    expect(pre).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(pre);
  });
});

describe("缺陷 2：budgetRules 与 costLimit 同口径（含影子调用）", () => {
  test("主调用花费为 0、只有影子调用时，session 规则累计 = 有效总花费", () => {
    const bt = new BudgetTracker([rule({ limitUSD: 100 })]);
    // 第一轮：主调用 0.1，期间影子调用花了 0.3 → 有效总花费 0.4
    bt.recordTurn(0.4, 0.1, { model: "m" });
    // 第二轮：主调用 0，影子调用 0.25 → 0.65
    bt.recordTurn(0.65, 0, { model: "m" });
    expect(bt.getStatus()[0]!.currentUSD).toBeCloseTo(0.65, 10);
  });

  test("不重复计数：总额不变时再记一轮，累计不变", () => {
    const bt = new BudgetTracker([rule({ limitUSD: 100 })]);
    bt.recordTurn(0.4, 0.4, {});
    bt.recordTurn(0.4, 0, {});
    expect(bt.getStatus()[0]!.currentUSD).toBeCloseTo(0.4, 10);
  });

  test("scope.model 规则只计本次主调用的那部分，影子调用增量不记到它头上", () => {
    const bt = new BudgetTracker([
      rule({ id: "all", limitUSD: 100 }),
      rule({ id: "opus", limitUSD: 100, scope: { model: "opus" } }),
    ]);
    bt.recordTurn(0.5, 0.2, { model: "opus" });
    const [all, opus] = bt.getStatus();
    expect(all!.currentUSD).toBeCloseTo(0.5, 10);
    expect(opus!.currentUSD).toBeCloseTo(0.2, 10);
  });

  test("影子调用把 session 规则推过上限 → 下一轮请求前就拦", () => {
    const bt = new BudgetTracker([rule({ limitUSD: 1 })]);
    bt.recordTurn(1.1, 0.05, {});
    expect(checkPreRequestBudgetStop({ budgetTracker: bt }, 1.1)?.source).toBe("budget_rule");
  });

  test("resume：回灌的历史花费计入 session 规则、不计入 daily，且下一轮不重复记", () => {
    const bt = new BudgetTracker([
      rule({ id: "s", limitUSD: 100 }),
      rule({ id: "d", period: "daily", limitUSD: 100 }),
    ]);
    bt.hydrateSessionBaseline(3);
    bt.recordTurn(3.5, 0.5, {});
    const [s, d] = bt.getStatus();
    expect(s!.currentUSD).toBeCloseTo(3.5, 10);
    expect(d!.currentUSD).toBeCloseTo(0.5, 10);
  });
});

describe("缺陷 3：周期键按本地时区，weekly 按 ISO 周（周一开始）", () => {
  test("前提：本文件跑在 UTC+8", () => {
    expect(new Date(2026, 9, 29).getTimezoneOffset()).toBe(-480);
  });

  test("本地 07:59 与 08:01 的 daily 键相同（UTC 下跨天）", () => {
    const a = new Date(2026, 9, 29, 7, 59);
    const b = new Date(2026, 9, 29, 8, 1);
    expect(budgetPeriodKey("daily", a)).toBe("2026-10-29");
    expect(budgetPeriodKey("daily", b)).toBe(budgetPeriodKey("daily", a));
  });

  test("本地 00:30 的 daily 键是当天，不是 UTC 的前一天", () => {
    expect(budgetPeriodKey("daily", new Date(2026, 9, 29, 0, 30))).toBe("2026-10-29");
    expect(budgetPeriodKey("hourly", new Date(2026, 9, 29, 0, 30))).toBe("2026-10-29T00");
    expect(budgetPeriodKey("monthly", new Date(2026, 9, 1, 0, 30))).toBe("2026-10");
  });

  test("本地周日 23:59 与周一 00:01 的 weekly 键不同；周一到周日同键", () => {
    const sun = new Date(2026, 10, 1, 23, 59); // 2026-11-01 周日
    const mon = new Date(2026, 10, 2, 0, 1); // 2026-11-02 周一
    expect(sun.getDay()).toBe(0);
    expect(budgetPeriodKey("weekly", sun)).not.toBe(budgetPeriodKey("weekly", mon));
    const nextSun = new Date(2026, 10, 8, 23, 59);
    expect(budgetPeriodKey("weekly", nextSun)).toBe(budgetPeriodKey("weekly", mon));
    // 旧实现的分界在周四：周三与周四必须同键
    const wed = new Date(2026, 10, 4, 12);
    const thu = new Date(2026, 10, 5, 12);
    expect(budgetPeriodKey("weekly", wed)).toBe(budgetPeriodKey("weekly", thu));
  });

  test("ISO 周跨年：2027-01-01（周五）属于 2026-W53", () => {
    expect(budgetPeriodKey("weekly", new Date(2027, 0, 1, 12))).toBe("2026-W53");
    expect(budgetPeriodKey("weekly", new Date(2027, 0, 4, 12))).toBe("2027-W01");
  });
});

describe("缺陷 4：/clear 重置 budgetRules", () => {
  test("超限后 resetSessionPeriod + resetAlertLevels：新会话放行，再次超限再拦", () => {
    const bt = new BudgetTracker([rule()]);
    bt.recordTurn(1.2, 1.2, {});
    expect(bt.findBlockingRule()).toBeDefined();

    // /clear：rotate 把会话花费归零，tracker 同批重置
    bt.resetAlertLevels();
    bt.resetSessionPeriod();
    expect(bt.findBlockingRule()).toBeUndefined();
    expect(checkPreRequestBudgetStop({ budgetTracker: bt }, 0)).toBeNull();

    // 新会话从 0 开始计：0.6 只到 warning（告警级别已重置，能再报）
    expect(bt.recordTurn(0.6, 0.6, {})?.level).toBe("warning");
    expect(bt.findBlockingRule()).toBeUndefined();
    expect(bt.recordTurn(1.1, 0.5, {})?.level).toBe("exceeded");
    expect(bt.findBlockingRule()).toBeDefined();
  });

  test("resetSessionPeriod 不清 daily 这类自然时间周期", () => {
    const bt = new BudgetTracker([rule({ period: "daily" })]);
    bt.recordTurn(1.2, 1.2, {});
    bt.resetSessionPeriod();
    expect(bt.findBlockingRule()).toBeDefined();
  });

  test("app.ts 的 /clear 调用两个重置方法；resume 设记账基线", () => {
    const app = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");
    const clear = app.slice(app.indexOf("private async clearConversation("));
    const seg = clear.slice(0, 12_000);
    expect(/this\.budgetTracker\?\.resetAlertLevels\(\)/.test(seg)).toBe(true);
    expect(/this\.budgetTracker\?\.resetSessionPeriod\(\)/.test(seg)).toBe(true);
    expect(/this\.budgetTracker\?\.hydrateSessionBaseline\(/.test(app)).toBe(true);
  });
});
