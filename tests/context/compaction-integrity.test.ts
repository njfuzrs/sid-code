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
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { checkMessageHistoryIntegrity } from "../../src/agent/message-invariants.ts";

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
});
