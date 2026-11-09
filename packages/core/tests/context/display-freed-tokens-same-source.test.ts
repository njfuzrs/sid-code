/**
 * 展示口径必须与压缩决策同源：扣掉「本地已释放量」。
 *
 * 事故形态（2026-11-09）：同一份 `estimateTokens`，两个消费者两套算法——
 * `getCompactionLevel()` 减了 `tokenFreedTracker.getTotalFreed()`，
 * 而 `getContextUsageForDisplay()`（Footer / 状态栏）和 `getTokenBreakdown()`（/context）
 * 一分不扣。tokenFreedTracker 记的正是「发送副本已经瘦掉、全量历史里还在」的部分：
 * 大输出清理（cleanedMessages）、冷缓存清理（coldCacheClear）、遮罩（masking）。
 *
 * 后果不是差几个点：长会话实测展示值虚高 1.9–2.7 倍（三个会话分别
 * 1,162,927→438,012、1,163,778→364,057、1,599,574→830,237），而且数字永不回落。
 *
 * 断言对着两个可观察后果写：
 *  1. 清理后展示值必须跟着降（旧行为恒定不变）；
 *  2. 展示值必须精确等于 `max(0, estimateTokens − freed)`——与决策同一表达式，
 *     不是「大概小一点」。
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** n 轮 read 调用，每条结果 chars 字符。
 *  > microcompact 的 500 字符阈值（才进冷清理候选），< 大输出 30K 阈值（走独立路径）。 */
function history(rounds: number, chars = 2_000): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { file_path: `f${i}.ts` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${i}`.repeat(chars) }],
    });
  }
  return msgs;
}

/** 造一个「有东西可清」的 manager，返回清理释放量（与 tokenFreedTracker 同口径）。 */
function managerWithFreedTokens(): { mgr: Manager; freed: number } {
  const mgr = new Manager({ maxTokens: 1_000_000 });
  mgr.setMessages(history(10));
  mgr.consumeSendMutationCauses();
  const r = mgr.applyColdCacheClear();
  expect(r.cleared).toBeGreaterThan(0); // 前提：确实发生了清理，否则下面的断言无意义
  // coldCacheClear 的记账口径：Math.ceil(savedChars / 4)（见 manager.ts applyColdCacheClear）
  return { mgr, freed: Math.ceil(r.savedChars / 4) };
}

describe("getContextUsageForDisplay 扣掉本地已释放量（与 getCompactionLevel 同源）", () => {
  test("本地清理后展示占用必须下降（旧行为：恒定不变，永远按膨胀历史计价）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));

    const before = mgr.getContextUsageForDisplay();
    const r = mgr.applyColdCacheClear();
    expect(r.cleared).toBeGreaterThan(0);
    const after = mgr.getContextUsageForDisplay();

    expect(after.used).toBeLessThan(before.used);
    // 百分比同源派生，必须跟着降（否则 Footer 与 used 两个口径自相矛盾）
    expect(after.percentOfWindow).toBeLessThanOrEqual(before.percentOfWindow);
  });

  test("used 精确等于 max(0, estimateTokens − freed)：与决策是同一个表达式，不是「大概小一点」", () => {
    const { mgr, freed } = managerWithFreedTokens();

    const u = mgr.getContextUsageForDisplay();

    // estimateTokens 只读全量历史，清理不动它 —— 差额只能来自 freed
    expect(freed).toBeGreaterThan(0);
    expect(u.used).toBe(Math.max(0, mgr.estimateTokens() - freed));
  });

  test("未发生本地清理时展示值不变（不凭空造减量）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages([{ role: "user", content: [{ type: "text", text: "只有一条消息" }] }]);

    const before = mgr.getContextUsageForDisplay();
    expect(mgr.applyColdCacheClear().cleared).toBe(0); // 无可清
    const after = mgr.getContextUsageForDisplay();

    expect(after.used).toBe(before.used);
    expect(after.used).toBe(mgr.estimateTokens());
  });
});

describe("getTokenBreakdown 扣掉本地已释放量（/context 与 Footer 不能两套数）", () => {
  test("清理后 total 下降，且下降量与实际释放量一致", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));

    const beforeTotal = mgr.getTokenBreakdown().total;
    const beforeUsed = mgr.getContextUsageForDisplay().used;
    mgr.applyColdCacheClear();
    const afterTotal = mgr.getTokenBreakdown().total;
    const afterUsed = mgr.getContextUsageForDisplay().used;

    expect(afterTotal).toBeLessThan(beforeTotal);
    // 两个展示出口的减量必须相等 —— 这正是「同源」的可观测形式
    expect(beforeTotal - afterTotal).toBe(beforeUsed - afterUsed);
  });

  test("释放量从 toolResult 分类里扣（三类记账来源释放的都是 tool_result）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    mgr.applyColdCacheClear();

    const b = mgr.getTokenBreakdown();
    const toolResultCat = b.categories.find((c) => c.key === "toolResult");
    expect(toolResultCat).toBeDefined();
    // 分类不得为负（自相矛盾的展示比数字偏大更糟）
    expect(toolResultCat!.tokens).toBeGreaterThanOrEqual(0);
    // total 恒等于各分类之和 —— 扣减不能破坏这个不变量
    expect(b.total).toBe(b.categories.reduce((sum, c) => sum + c.tokens, 0));
  });

  test("校准时按 factor 缩放后仍保持 total = 各分类之和（扣减顺序不破坏不变量）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    // 喂一次真实 usage 让 calibrationFactor 生效，覆盖「先扣后缩放」这条路径
    mgr.recordActualTokens(50_000, 10);
    mgr.applyColdCacheClear();

    const b = mgr.getTokenBreakdown();
    expect(b.total).toBe(b.categories.reduce((sum, c) => sum + c.tokens, 0));
    expect(b.categories.every((c) => c.tokens >= 0)).toBe(true);
  });
});
