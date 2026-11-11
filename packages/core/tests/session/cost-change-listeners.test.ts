/**
 * D1（P0）：Footer 漏掉一轮结束后的辅助调用费用。
 *
 * 根因不是计价口径，而是**通知通道只有一个槽位**：`setCostChangeListener` 是覆盖式赋值，
 * 被 app.ts 的账本落盘占用（`app.ts` 构造 SessionState 后立刻挂上），于是 UI 想"每笔
 * 入账都刷新"就无处可挂 —— 只能返回五个固定时机重新读值，而辅助调用（后台记忆 fork、
 * 标题生成、SessionEnd 前的收尾）全部发生在一轮结束之后，那五个时机都已经过去了。
 *
 * 本文件锁三件事：
 *   ① 新接口 addCostChangeListener 可与旧单槽位共存，且互不挤掉；
 *   ② 单个订阅者抛错不影响其他订阅者，也不影响入账本身；
 *   ③ 反注册幂等，反注册后不再回调。
 *
 * 用户可见的后果：实测那次会话 Footer 停在 $0.0856、真实 $0.1501（少报 43%），
 * 且用户不再输入就永不更新 —— 见方案文档 2.4 节。
 */

import { describe, expect, test } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";

describe("D1 · SessionState 多入账订阅者", () => {
  test("两个订阅者都被回调，且与旧的单槽位观察者共存（不互相挤掉）", () => {
    const ss = new SessionState("d1-multi");
    const ledger: number[] = [];
    const ui: number[] = [];
    // 旧接口先占位（复刻 app.ts 账本落盘的接线顺序）
    ss.setCostChangeListener((cost) => ledger.push(cost));
    ss.addCostChangeListener((cost) => ui.push(cost));

    ss.addSideCost(0.0645);

    expect(ledger).toEqual([0.0645]);
    expect(ui).toEqual([0.0645]);
    expect(ui[0]).toBe(ss.getEffectiveTotalCostUSD());
  });

  test("订阅者抛错不影响入账，也不影响其他订阅者", () => {
    const ss = new SessionState("d1-throw");
    const after: number[] = [];
    ss.addCostChangeListener(() => {
      throw new Error("ui boom");
    });
    ss.addCostChangeListener((cost) => after.push(cost));

    expect(() => ss.addSideCost(0.3)).not.toThrow();
    expect(ss.getEffectiveTotalCostUSD()).toBeCloseTo(0.3, 10);
    expect(after).toEqual([0.3]);
  });

  test("主循环 updateUsage 同样通知订阅者（不只是辅助调用那条路）", () => {
    const ss = new SessionState("d1-update-usage");
    const seen: number[] = [];
    ss.addCostChangeListener((cost) => seen.push(cost));

    ss.updateUsage("deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 }, 10, "openai");

    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(ss.getEffectiveTotalCostUSD());
    expect(seen[0]).toBeGreaterThan(0);
  });

  test("反注册后不再回调，重复反注册无害", () => {
    const ss = new SessionState("d1-unsubscribe");
    const seen: number[] = [];
    const off = ss.addCostChangeListener((cost) => seen.push(cost));

    ss.addSideCost(0.01);
    expect(seen.length).toBe(1);

    off();
    off(); // 幂等：退出路径不必判重
    ss.addSideCost(0.02);
    expect(seen.length).toBe(1);
    expect(ss.getEffectiveTotalCostUSD()).toBeCloseTo(0.03, 10);
  });

  test("反注册只摘掉自己，其他订阅者仍在", () => {
    const ss = new SessionState("d1-partial-off");
    const a: number[] = [];
    const b: number[] = [];
    const offA = ss.addCostChangeListener((cost) => a.push(cost));
    ss.addCostChangeListener((cost) => b.push(cost));

    ss.addSideCost(0.01);
    offA();
    ss.addSideCost(0.02);

    expect(a).toEqual([0.01]);
    expect(b).toEqual([0.01, 0.03]);
  });
});
