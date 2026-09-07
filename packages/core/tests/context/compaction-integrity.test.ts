/**
 * 压缩边界消息历史完整性测试 — D2-4 盲区闭合
 *
 * 背景：D2-4 盲区扫描发现 auto-compact / compaction 会话级零专测。压缩会截断并重组
 * 消息数组（findCompressSplitPoint → compactWithSummary / emergencyTruncate），若在
 * tool_use/tool_result 对中间切割，就会产生与本次 400 同类的孤儿 tool_use。
 *
 * findCompressSplitPoint 的设计承诺"只在不含 tool_result 的 user 消息处分割"以避免切对，
 * 但此前无测试强制该承诺。本测试用 D1-4 共享不变量，断言各种压缩后历史仍 intact。
 *
 * fix_type: infra_bug（L1，测试）
 */

import { describe, test, expect } from "bun:test";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";

/** 构造一轮完整工具对话：user(text) → assistant(tool_use) → user(tool_result) */
function pushToolRound(ctx: ContextManager, idBase: string, toolName: string, padding = "") {
  ctx.addMessage({ role: "user", content: [{ type: "text", text: `请求 ${idBase} ${padding}` }] });
  ctx.addMessage({
    role: "assistant",
    content: [
      { type: "text", text: `调用 ${toolName}` },
      { type: "tool_use", id: idBase, name: toolName, input: { k: padding } },
    ],
  });
  ctx.addMessage({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: idBase, content: `结果 ${idBase} ${padding}` }],
  });
}

describe("D2-4 闭合 — 压缩边界消息历史完整性", () => {
  test("compactWithSummary 后历史无孤儿（多轮工具对话）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    // 制造足够长的历史，让压缩真正发生
    const bigPad = "x".repeat(500);
    for (let i = 0; i < 12; i++) {
      pushToolRound(ctx, `t${i}`, i % 2 === 0 ? "read" : "edit", bigPad);
    }

    // 压缩前先确认 intact（基线）
    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);

    ctx.compactWithSummary("【摘要】前面读写了若干文件。");

    // 压缩后：split point 只在不含 tool_result 的 user 处切，不应切断任何 tool_use/tool_result 对
    const after = ctx.getMessages();
    const integrity = checkMessageHistoryIntegrity(after);
    expect(integrity.intact).toBe(true);
    expect(integrity.orphans).toHaveLength(0);
    expect(integrity.dangling).toHaveLength(0);
  });

  test("emergencyTruncate 后历史无孤儿", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    const bigPad = "y".repeat(800);
    for (let i = 0; i < 15; i++) {
      pushToolRound(ctx, `e${i}`, "bash", bigPad);
    }
    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);

    ctx.emergencyTruncate();

    const integrity = checkMessageHistoryIntegrity(ctx.getMessages());
    expect(integrity.intact).toBe(true);
  });

  test("最坏构造：split 点附近紧贴 tool 对，压缩仍不产生孤儿", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    // 交替 padding，让累积刚好落在某个 tool 对附近，逼近边界 case
    for (let i = 0; i < 20; i++) {
      pushToolRound(ctx, `b${i}`, "read", "z".repeat(200 + (i % 3) * 150));
    }

    ctx.compactWithSummary("【摘要】大量读取。");
    const integrity = checkMessageHistoryIntegrity(ctx.getMessages());
    // 即便切在 tool 对密集区，findCompressSplitPoint 的"只在 user 无 tool_result 处切"承诺
    // 应保证 intact
    expect(integrity.intact).toBe(true);
  });

  test("连续两次压缩（多轮累积）后历史仍合法", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    const pad = "w".repeat(400);
    for (let i = 0; i < 10; i++) pushToolRound(ctx, `c${i}`, "read", pad);
    ctx.compactWithSummary("【摘要1】");
    // 再加几轮再压一次
    for (let i = 10; i < 18; i++) pushToolRound(ctx, `c${i}`, "edit", pad);
    ctx.compactWithSummary("【摘要2】");

    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);
  });

  // ─── P1-4a: 压缩观察者接线 ───

  // 纯文本对话轮：user(text) → assistant(text)。不含 tool 对，每条 user 都是安全分割点，
  // 能可靠制造 >0 的 findCompressSplitPoint（pushToolRound 会因连续 user 合并只剩 1 个安全点）。
  function pushTextRound(ctx: ContextManager, i: number, pad: string) {
    ctx.addMessage({ role: "user", content: [{ type: "text", text: `问题 ${i} ${pad}` }] });
    ctx.addMessage({ role: "assistant", content: [{ type: "text", text: `回答 ${i} ${pad}` }] });
  }

  test("P1-4a: compactWithSummary 触发 compactObserver 回调（summary + removedCount）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    const calls: Array<{ summary: string; removedCount: number }> = [];
    ctx.setCompactObserver((summary, removedCount) => calls.push({ summary, removedCount }));

    const bigPad = "z".repeat(800);
    for (let i = 0; i < 30; i++) pushTextRound(ctx, i, bigPad);
    // 前置断言：确有安全分割点（否则压缩被跳过，测的就不是观察者了）
    expect(ctx.findCompressSplitPoint()).toBeGreaterThan(0);
    ctx.compactWithSummary("【摘要】观察者应收到这条");

    expect(calls.length).toBe(1);
    expect(calls[0].summary).toBe("【摘要】观察者应收到这条");
    expect(calls[0].removedCount).toBeGreaterThan(0);
  });

  test("P1-4a: 无安全分割点时不触发 compactObserver（压缩被跳过）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    let called = false;
    ctx.setCompactObserver(() => {
      called = true;
    });
    // 历史太短，findCompressSplitPoint 返回 <=0，compactWithSummary 直接 return
    ctx.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    ctx.compactWithSummary("【摘要】不应触发");
    expect(called).toBe(false);
  });

  test("P1-4a: compactObserver 抛错不影响压缩完成", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    ctx.setCompactObserver(() => {
      throw new Error("落盘失败模拟");
    });
    const bigPad = "q".repeat(800);
    for (let i = 0; i < 30; i++) pushTextRound(ctx, i, bigPad);
    // 观察者抛错被 try/catch 吞掉，压缩正常完成、历史合法
    expect(() => ctx.compactWithSummary("【摘要】观察者抛错")).not.toThrow();
    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);
  });

  // ─── D10：三条压缩入口都要落盘 ───
  //
  // 此前只有 compactWithSummary 一条回调，注释却宣称「压缩状态已可观测」——
  // 实测磁盘 `context_compact` 记录恒为 0，而 compact-stats.json 里有大量真实压缩记录。
  // 这组用例按入口逐条钉住，并额外钉住那条**不能靠单测过就结案**的边界：
  // 紧急截断/管道压缩的 summary 不是历史内容摘要，不得覆盖会话摘要（见 summaryIsRestorable）。

  test("D10: emergencyTruncate 触发观察者（此前完全不落盘）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    const calls: Array<{ summary: string; removedCount: number; meta: any }> = [];
    ctx.setCompactObserver((summary, removedCount, meta) =>
      calls.push({ summary, removedCount, meta }),
    );

    const bigPad = "e".repeat(800);
    for (let i = 0; i < 30; i++) pushTextRound(ctx, i, bigPad);
    const before = ctx.messageCount();
    const outcome = ctx.emergencyTruncate();

    // 前置断言：真压动了（否则测的不是落盘而是 no-op 分支）
    expect(outcome.success).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].removedCount).toBe(before - ctx.messageCount());
    expect(calls[0].meta.source).toBe("emergency");
    // 承重断言：miniSummary 是操作性描述，不能被存成恢复用会话摘要
    expect(calls[0].meta.summaryIsRestorable).toBe(false);
  });

  test("D10: 渐进式管道经 recordPipelineCompaction 落盘，来源标 pipeline", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    const calls: Array<{ summary: string; removedCount: number; meta: any }> = [];
    ctx.setCompactObserver((summary, removedCount, meta) =>
      calls.push({ summary, removedCount, meta }),
    );

    const bigPad = "p".repeat(400);
    for (let i = 0; i < 20; i++) pushTextRound(ctx, i, bigPad);
    const before = ctx.messageCount();
    // 模拟管道：外部裁剪后整体 setMessages，再记账（与 loop.ts hard 档同序）
    ctx.setMessages(ctx.getMessages().slice(10));
    ctx.recordPipelineCompaction("snipCompact: 裁剪 10 条", before);

    expect(calls.length).toBe(1);
    expect(calls[0].removedCount).toBe(10);
    expect(calls[0].meta.source).toBe("pipeline");
    expect(calls[0].meta.summaryIsRestorable).toBe(false);
  });

  test("D10: compactWithSummary 的摘要可作会话摘要，且 removedCount 取净减少条数", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    const calls: Array<{ summary: string; removedCount: number; meta: any }> = [];
    ctx.setCompactObserver((summary, removedCount, meta) =>
      calls.push({ summary, removedCount, meta }),
    );

    const bigPad = "s".repeat(800);
    for (let i = 0; i < 30; i++) pushTextRound(ctx, i, bigPad);
    const before = ctx.messageCount();
    ctx.compactWithSummary("【摘要】这段历史讲了什么");
    const after = ctx.messageCount();

    expect(calls.length).toBe(1);
    expect(calls[0].meta.source).toBe("summary");
    expect(calls[0].meta.summaryIsRestorable).toBe(true);
    // removedCount 是**净减少**，不是 splitPoint —— 压缩会重注入摘要+ack，
    // 用 splitPoint 记账会与消息数变化对不上。
    expect(calls[0].removedCount).toBe(before - after);
  });

  test("D10: 没真压动就不落盘（紧急截断 no-op 不得记一次不存在的压缩）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    let called = false;
    ctx.setCompactObserver(() => {
      called = true;
    });
    // 历史太短 → 无安全分割点 → emergencyTruncate 静默 no-op
    ctx.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    const outcome = ctx.emergencyTruncate();

    expect(outcome.success).toBe(false);
    expect(called).toBe(false);
  });

  test("D10: 紧急路径只记一次（addCompactBoundary 不得与 emergencyTruncate 重复记账）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    let count = 0;
    ctx.setCompactObserver(() => {
      count++;
    });

    const bigPad = "d".repeat(800);
    for (let i = 0; i < 30; i++) pushTextRound(ctx, i, bigPad);
    const before = ctx.messageCount();
    // 复刻 loop.ts blocking/emergency 两档的调用序：截断 + 插边界
    ctx.emergencyTruncate();
    ctx.addCompactBoundary("紧急压缩", before);

    // 若把通知挂在 addCompactBoundary 上，这里会是 2 —— 诊断记录里多出一次不存在的压缩
    expect(count).toBe(1);
  });
});
