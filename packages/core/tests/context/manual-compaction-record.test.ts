/**
 * 手动 `/compact` 的落盘出口（recordManualCompaction）契约测试。
 *
 * 背景（2026-11-10 分诊，别把这个文件当"顺手加的测试"）：
 * 手动 `/compact` 走 `partialCompact` → `setMessages`，既不经 `compactWithSummary`
 * 也不经压缩管道，此前整条路径不通知观察者 ⇒ 会话 JSONL 无 `context_compact` 记录，
 * 且观察者同时承载的会话摘要写入 / rewind 锚点失效 / Session Memory 常驻注入一起丢失。
 * 实测本机两次 manual 压缩（遥测 outcome=summarized）对应的会话 JSONL 记录数为 0、
 * `summaries/` 无同名文件。
 *
 * 这里锁的是出口契约本身，不是「函数存在」：
 *   - 落盘元数据必须是 source="summary" + summaryIsRestorable=true
 *     （手动压缩的摘要是**历史内容摘要**，可作恢复用会话摘要；管道压缩那种步骤描述不行）；
 *   - removedCount 必须是**实际净减少**，且没真压动时不通知 —— 否则诊断记录会宣告
 *     一次没发生的压缩（2026-07-29 假压缩误报事故的同类形态）；
 *   - 观察者抛错不得影响已完成的压缩（best-effort）。
 *
 * 落盘隔离：本测试只注入内存 observer，不碰真实 `~/.sid-code/`。
 */

import { describe, test, expect } from "bun:test";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { CompactionRecordMeta } from "@sid-code/core/context/manager.ts";

/** 构造 n 条 user/assistant 交替的干净历史 */
function seed(ctx: ContextManager, rounds: number): void {
  for (let i = 0; i < rounds; i++) {
    ctx.addMessage({ role: "user", content: [{ type: "text", text: `问题${i}` }] });
    ctx.addMessage({ role: "assistant", content: [{ type: "text", text: `回答${i}` }] });
  }
}

type Captured = { summary: string; removedCount: number; meta: CompactionRecordMeta };

describe("recordManualCompaction — 手动压缩落盘出口", () => {
  test("压缩成功后通知 observer：source=summary、summaryIsRestorable=true、removedCount=净减少", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    seed(ctx, 5); // 10 条
    const captured: Captured[] = [];
    ctx.setCompactObserver((summary, removedCount, meta) => {
      captured.push({ summary, removedCount, meta });
    });

    // 模拟 partialCompact 的产出：把 10 条压成 2 条（摘要 + ack）
    ctx.setMessages([
      { role: "user", content: [{ type: "text", text: "[对话摘要]\n前面聊了五轮问题" }] },
      { role: "assistant", content: [{ type: "text", text: "好的，我已了解之前的对话内容。" }] },
    ]);
    ctx.recordManualCompaction("前面聊了五轮问题", 10);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.summary).toBe("前面聊了五轮问题");
    // 10 → 2 条，净减少 8（不是 splitPoint，也不是「压了多少轮」）
    expect(captured[0]!.removedCount).toBe(8);
    expect(captured[0]!.meta).toEqual({ source: "summary", summaryIsRestorable: true });
  });

  test("没真压动（消息数未下降）时不通知 —— 不得宣告一次没发生的压缩", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    seed(ctx, 3); // 6 条
    const captured: Captured[] = [];
    ctx.setCompactObserver((summary, removedCount, meta) => {
      captured.push({ summary, removedCount, meta });
    });

    // 压缩前消息数等于当前条数：净减少 0
    ctx.recordManualCompaction("什么都没压", 6);
    // 甚至传一个更小的「压缩前条数」（净减少为负）：同样不落
    ctx.recordManualCompaction("负数更不该落", 4);

    expect(captured).toHaveLength(0);
  });

  test("观察者抛错不影响压缩本身（best-effort，不外溢）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    seed(ctx, 4);
    ctx.setMessages([{ role: "user", content: [{ type: "text", text: "摘要" }] }]);
    ctx.setCompactObserver(() => {
      throw new Error("磁盘满了");
    });

    // 不抛异常即通过：落盘失败绝不能回滚已完成的内存压缩
    expect(() => ctx.recordManualCompaction("摘要", 8)).not.toThrow();
    expect(ctx.messageCount()).toBe(1);
  });

  test("未注入 observer 时安全 no-op（headless / 早期初始化路径）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    seed(ctx, 3);
    ctx.setMessages([{ role: "user", content: [{ type: "text", text: "摘要" }] }]);
    expect(() => ctx.recordManualCompaction("摘要", 6)).not.toThrow();
  });
});
