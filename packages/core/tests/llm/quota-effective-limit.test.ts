/**
 * B18（2026-10-02）：花费上限「取更严的那个」+ 交互模式接线
 *
 * 原缺陷两个叠加，结果是 `--max-budget-usd` 对装了团队默认配置的人两种模式都不存在：
 *   ① 交互模式直接告警并忽略该参数（cli.ts）；
 *   ② `quota.costLimit ?? costLimit` —— 团队默认 `quota.costLimit: 100` 把用户的 0.5 盖成 100。
 *
 * 行为断言测纯函数；接线断言读生产源码（同 quota-rate-limit-wiring.test.ts 范式），
 * 因为「函数对、没接进去」正是 ① 的形态，单测证明不了。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QuotaManager, resolveEffectiveCostLimit } from "@sid-code/core/llm/quota.ts";

const cliSrc = (p: string) => readFileSync(join(import.meta.dir, "../../../cli/src", p), "utf8");

describe("resolveEffectiveCostLimit：四格", () => {
  test("只有 CLI（顶层 costLimit）", () => {
    expect(resolveEffectiveCostLimit(undefined, 0.5)).toBe(0.5);
  });
  test("只有 quota.costLimit", () => {
    expect(resolveEffectiveCostLimit(100, undefined)).toBe(100);
  });
  test("都有且 CLI 更小 → CLI 胜（原实现这里返回 100，变异自证）", () => {
    expect(resolveEffectiveCostLimit(100, 0.5)).toBe(0.5);
  });
  test("都有且 quota 更小 → quota 胜", () => {
    expect(resolveEffectiveCostLimit(1, 5)).toBe(1);
  });
});

describe("resolveEffectiveCostLimit：0 = 不限，不参与取 min", () => {
  // 评测容器显式写 0 关闸门（exec-swebench.sh）；若把 0 当「最严」，
  // 任何正数上限都会塌成 0 = 闸门整个消失，方向又一次反了。
  test("一侧 0 一侧正数 → 取正数", () => {
    expect(resolveEffectiveCostLimit(0, 0.5)).toBe(0.5);
    expect(resolveEffectiveCostLimit(100, 0)).toBe(100);
  });
  test("两侧都不限 → 0", () => {
    expect(resolveEffectiveCostLimit(0, 0)).toBe(0);
    expect(resolveEffectiveCostLimit(undefined, undefined)).toBe(0);
  });
  test("负数 / NaN 视为不限", () => {
    expect(resolveEffectiveCostLimit(-1, 2)).toBe(2);
    expect(resolveEffectiveCostLimit(Number.NaN, 2)).toBe(2);
  });
});

describe("合并结果喂给 QuotaManager 后真的会拦", () => {
  test("团队默认 100 + 用户 0.002：花到 0.0025 即 exceeded", () => {
    const qm = new QuotaManager({ costLimit: resolveEffectiveCostLimit(100, 0.002) });
    expect(qm.check(0.0025)?.level).toBe("exceeded");
  });
  test("小于一分钱的上限不再显示成 $0.00（坑二）", () => {
    const qm = new QuotaManager({ costLimit: 0.002 });
    const msg = qm.check(0.0083)!.message;
    expect(msg.includes("$0.0020")).toBe(true);
    expect(msg.includes("$0.00）")).toBe(false);
  });
});

describe("接线：交互与 -p 共用同一个生效值", () => {
  const app = cliSrc("app.ts");

  test("app.ts 用 resolveEffectiveCostLimit 合并，不再是 `??`（变异自证）", () => {
    expect(app.includes("resolveEffectiveCostLimit(")).toBe(true);
    expect(app.includes("quotaConfig?.costLimit ?? opts.config.costLimit")).toBe(false);
  });

  test("合并发生在构造函数里，不在任何 print 分支内", () => {
    // 构造期这段对交互与 -p 都跑；若被挪进 runPrint / runStreamJson，交互模式又会失效。
    const idx = app.indexOf("resolveEffectiveCostLimit(");
    const ctor = app.indexOf("constructor(");
    const firstRunPrint = app.search(/async run(Print|Headless|StreamJson|SDK)/);
    expect(ctor).toBeGreaterThan(0);
    expect(idx).toBeGreaterThan(ctor);
    if (firstRunPrint > 0) expect(idx).toBeLessThan(firstRunPrint);
  });

  test("SDK 路径与状态栏分母读的都是生效值，不回退去读 config.costLimit", () => {
    expect(app.includes("maxBudgetUsd: this.config.costLimit")).toBe(false);
    expect(app.includes("costLimit: this.config.costLimit ?? 0")).toBe(false);
    // SDK 缺陷 6：SDKQueryEngine 从不读 maxBudgetUsd，该透传已删除；stream-json 的预算硬停
    // 由 QuotaManager 执行（构造期 costLimit: effectiveCostLimit），不能再加回一个死参数。
    expect(app.includes("maxBudgetUsd: this.effectiveCostLimit")).toBe(false);
    expect(app.includes("costLimit: effectiveCostLimit")).toBe(true);
  });

  test("cli.ts 不再在交互模式告警并忽略 --max-budget-usd", () => {
    expect(cliSrc("cli.ts").includes("--max-budget-usd 只在 --print 下生效")).toBe(false);
  });
});
