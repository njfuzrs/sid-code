/**
 * 催促类 reminder 注入节流单测（query/reminder-throttle.ts）
 *
 * 回归目标：对话重播/消息被截断幻觉根因（会话 20260707-155324-1fb62e56）——
 * todo/progress 催促在无进展时被反复注入成"幻影用户消息"。这里锁定两条纪律：
 * 去重（相同文本不注入）+ 封顶（连续无进展催促达上限后停手）。
 */

import { describe, test, expect } from "bun:test";
import {
  decideNagInjection,
  MAX_NO_PROGRESS_NAGS,
} from "@sid-code/core/query/reminder-throttle.ts";

describe("decideNagInjection — 去重", () => {
  test("首次注入（无上次记录）→ 注入且计入无进展", () => {
    const d = decideNagInjection({
      candidate: "提醒 A",
      lastInjectedText: undefined,
      noProgressNagCount: 0,
    });
    expect(d.inject).toBe(true);
    expect(d.countedAsNoProgress).toBe(true);
  });

  test("与上次注入内容逐字节相同 → 跳过，不计数", () => {
    const d = decideNagInjection({
      candidate: "完全一样的提醒",
      lastInjectedText: "完全一样的提醒",
      noProgressNagCount: 0,
    });
    expect(d.inject).toBe(false);
    expect(d.countedAsNoProgress).toBe(false);
  });

  test("内容有变化（如待办数变了）→ 允许注入", () => {
    const d = decideNagInjection({
      candidate: "仍待办 2 项",
      lastInjectedText: "仍待办 3 项",
      noProgressNagCount: 0,
    });
    expect(d.inject).toBe(true);
  });
});

describe("decideNagInjection — 封顶", () => {
  test("达到 cap 后跳过注入", () => {
    const d = decideNagInjection({
      candidate: "新提醒",
      lastInjectedText: "旧提醒",
      noProgressNagCount: MAX_NO_PROGRESS_NAGS,
    });
    expect(d.inject).toBe(false);
    expect(d.countedAsNoProgress).toBe(false);
  });

  test("超过 cap 也跳过", () => {
    const d = decideNagInjection({
      candidate: "新提醒",
      lastInjectedText: "旧提醒",
      noProgressNagCount: MAX_NO_PROGRESS_NAGS + 5,
    });
    expect(d.inject).toBe(false);
  });

  test("恰好差一格（cap-1）→ 仍允许注入", () => {
    const d = decideNagInjection({
      candidate: "新提醒",
      lastInjectedText: "旧提醒",
      noProgressNagCount: MAX_NO_PROGRESS_NAGS - 1,
    });
    expect(d.inject).toBe(true);
    expect(d.countedAsNoProgress).toBe(true);
  });

  test("自定义 cap 生效", () => {
    const d = decideNagInjection({
      candidate: "新提醒",
      lastInjectedText: "旧提醒",
      noProgressNagCount: 1,
      cap: 1,
    });
    expect(d.inject).toBe(false);
  });
});

describe("decideNagInjection — 空候选", () => {
  test("candidate 为 null（builder 判定无需提醒）→ 不注入", () => {
    const d = decideNagInjection({
      candidate: null,
      lastInjectedText: undefined,
      noProgressNagCount: 0,
    });
    expect(d.inject).toBe(false);
    expect(d.countedAsNoProgress).toBe(false);
  });
});

describe("decideNagInjection — 进展后重新放行（模拟循环序列）", () => {
  test("停滞两轮达上限停手 → 进展清零后恢复注入", () => {
    let count = 0;
    let last: string | undefined;

    // 第 1 轮：停滞，注入
    let d = decideNagInjection({ candidate: "待办 1 项", lastInjectedText: last, noProgressNagCount: count });
    expect(d.inject).toBe(true);
    if (d.countedAsNoProgress) count++;
    last = "待办 1 项";
    expect(count).toBe(1);

    // 第 2 轮：文本略变（催促升级），仍停滞，注入 → 达上限
    d = decideNagInjection({ candidate: "仍待办 1 项，请继续", lastInjectedText: last, noProgressNagCount: count });
    expect(d.inject).toBe(true);
    if (d.countedAsNoProgress) count++;
    last = "仍待办 1 项，请继续";
    expect(count).toBe(MAX_NO_PROGRESS_NAGS);

    // 第 3 轮：仍停滞 → 封顶，跳过
    d = decideNagInjection({ candidate: "又一次催促", lastInjectedText: last, noProgressNagCount: count });
    expect(d.inject).toBe(false);

    // 模型终于更新了 todo（writeVersion 变化）→ 调用方清零
    count = 0;

    // 第 4 轮：有进展后，新提醒重新放行
    d = decideNagInjection({ candidate: "新一批待办", lastInjectedText: last, noProgressNagCount: count });
    expect(d.inject).toBe(true);
  });
});
