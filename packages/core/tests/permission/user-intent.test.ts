/**
 * UserIntentLedger 测试（PR2 / B1）
 *
 * 这个账本是 auto 档分类器**唯一**可见的「用户授权」依据，所以它的边界行为
 * （保留哪几条、怎么截断、omitted 怎么算、reset 清不清）直接决定分类器看到的授权范围。
 * 这里的每条断言都对应方案 §4.3.2 的一条明确约定。
 */

import { describe, test, expect } from "bun:test";
import {
  UserIntentLedger,
  clipUserIntentText,
  USER_INTENT_MAX_ENTRIES,
  USER_INTENT_MAX_CHARS,
} from "@sid-code/core/permission/user-intent.ts";

describe("UserIntentLedger 记录与快照", () => {
  test("按 seq 递增记录，快照带原文与 omitted=0", () => {
    const ledger = new UserIntentLedger();
    ledger.record("修一下登录 bug");
    ledger.record("顺便补测试");

    const snap = ledger.snapshot();
    expect(snap.entries.map((e) => e.text)).toEqual(["修一下登录 bug", "顺便补测试"]);
    expect(snap.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(snap.omitted).toBe(0);
    // at 是 ISO 时间戳（分类器用不到，但轨迹定位要用）
    expect(snap.entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("空白输入不算授权：不占配额、不推进 seq", () => {
    const ledger = new UserIntentLedger();
    ledger.record("   ");
    ledger.record("");
    expect(ledger.size).toBe(0);
    // 下一条真实输入仍从 seq=1 开始
    ledger.record("真实指令");
    expect(ledger.snapshot().entries[0].seq).toBe(1);
  });

  test("保留会话首条 + 最近 4 条：第 6 条起挤出中间最旧那条", () => {
    const ledger = new UserIntentLedger();
    for (let i = 1; i <= 6; i++) ledger.record(`第 ${i} 条`);

    const snap = ledger.snapshot();
    expect(snap.entries).toHaveLength(USER_INTENT_MAX_ENTRIES);
    // 首条（任务陈述）保留，被挤掉的是第 2 条
    expect(snap.entries[0].text).toBe("第 1 条");
    expect(snap.entries.map((e) => e.text)).toEqual([
      "第 1 条",
      "第 3 条",
      "第 4 条",
      "第 5 条",
      "第 6 条",
    ]);
    expect(snap.omitted).toBe(1);
  });

  test("omitted 累计被挤出的条数（不是当前缺几条）", () => {
    const ledger = new UserIntentLedger();
    for (let i = 1; i <= 8; i++) ledger.record(`第 ${i} 条`);
    // 8 条 → 挤出 3 条（第 2/3/4 条）
    expect(ledger.snapshot().omitted).toBe(3);
  });

  test("snapshot 返回副本：改快照不影响账本", () => {
    const ledger = new UserIntentLedger();
    ledger.record("原话");
    const snap = ledger.snapshot();
    snap.entries[0].text = "被改了";
    expect(ledger.snapshot().entries[0].text).toBe("原话");
  });

  test("reset 清空条数、seq 与 omitted（/clear 语义）", () => {
    const ledger = new UserIntentLedger();
    for (let i = 1; i <= 7; i++) ledger.record(`第 ${i} 条`);
    expect(ledger.snapshot().omitted).toBe(2);

    ledger.reset();
    expect(ledger.size).toBe(0);
    expect(ledger.snapshot()).toEqual({ entries: [], omitted: 0 });
    // 重置后 seq 从 1 重新开始，不与旧会话的序号接续
    ledger.record("新会话指令");
    expect(ledger.snapshot().entries[0].seq).toBe(1);
  });
});

describe("clipUserIntentText 截断规则", () => {
  test("不超长时原样返回", () => {
    const text = "短指令";
    expect(clipUserIntentText(text)).toBe(text);
  });

  test("恰好等于上限时不动", () => {
    const text = "x".repeat(USER_INTENT_MAX_CHARS);
    expect(clipUserIntentText(text)).toBe(text);
  });

  test("超长时保留头 1000 + 尾 500，中间标注省略量", () => {
    const head = "H".repeat(1000);
    const middle = "M".repeat(300);
    const tail = "T".repeat(500);
    const clipped = clipUserIntentText(head + middle + tail);

    expect(clipped.startsWith(head)).toBe(true);
    expect(clipped.endsWith(tail)).toBe(true);
    expect(clipped).toContain("…[省略 300 字]…");
    // 保留两端的理由：任务陈述在首部，约束条件（「不要动 X」）常在尾部
  });

  test("超长记录经 record 后落盘也是裁剪过的（提示不会失控膨胀）", () => {
    const ledger = new UserIntentLedger();
    ledger.record("y".repeat(5000));
    const recorded = ledger.snapshot().entries[0].text;
    expect(recorded.length).toBeLessThan(USER_INTENT_MAX_CHARS + 20);
    expect(recorded).toContain("…[省略");
  });
});
