/**
 * P0-1 回归：compactWithSummary no-op 时不得谎报「已压缩」
 *
 * 来源：docs-research/sid-code/bugfixes/todo/20261016-手动compact本地截断兜底谎报成功.md
 *
 * compactWithSummary 有三条 no-op 路径（no_split_point / invalid_result_rolled_back /
 * no_reduction），触发时消息一字不动。此前两个手动 /compact 调用方都不读返回值、
 * 固定报「对话已压缩」，no-op 时用户看到「156 → 156 条消息」的自相矛盾文案，
 * 以为上下文已释放，下一次请求直接撞溢出。
 *
 * 本文件锁：commands/compact/compact.ts 的本地截断兜底（runLocalTruncationFallback）
 * no-op 时文案必须如实报「未生效」，且不再 fire PostCompact hook。
 * （旧版 builtins.ts 的 CompactCommand 及其用例已随旧 Registry 回退路径一并删除。）
 *
 * mock 前提对齐真实契约：compactWithSummary 返回 CompactionOutcome，
 * success 由「消息数是否真的下降」唯一决定。
 */

import { describe, test, expect } from "bun:test";
import compactMod from "@sid-code/cli/command/commands/compact/compact.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 构造 round 边界干净的消息历史（user/assistant 交替，无工具往返） */
function buildMessages(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `问题${i}` }] });
    msgs.push({ role: "assistant", content: [{ type: "text", text: `回答${i}` }] });
  }
  return msgs;
}

/** LLM 摘要必失败的无参场景用 provider：抛错触发本地截断兜底 */
const failingProvider = {
  async *sendMessageStream() {
    throw new Error("network down");
  },
};

interface CompactOutcomeShape {
  success: boolean;
  messageCountBefore: number;
  messageCountAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  splitPoint: number;
  reason?: string;
}

/** mock ctxMgr：compactWithSummary 可配置为 no-op（消息不动、success:false） */
function makeCtx(messages: Message[], opts: { noopReason?: string } = {}) {
  let msgs = messages;
  const noopReason = opts.noopReason;
  const compactWithSummary = (summary: string): CompactOutcomeShape => {
    const before = msgs.length;
    if (noopReason) {
      // no-op：消息一字不动（对齐 manager.ts 的三条失败路径）
      return {
        success: false,
        messageCountBefore: before,
        messageCountAfter: before,
        tokensBefore: before * 10,
        tokensAfter: before * 10,
        splitPoint: 0,
        reason: noopReason,
      };
    }
    msgs = [
      { role: "user", content: [{ type: "text", text: summary }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    return {
      success: msgs.length < before,
      messageCountBefore: before,
      messageCountAfter: msgs.length,
      tokensBefore: before * 10,
      tokensAfter: msgs.length * 10,
      splitPoint: before - 1,
    };
  };
  const ctxMgr = {
    messageCount: () => msgs.length,
    estimateTokens: () => msgs.length * 10,
    acquireCompactLock: () => true,
    releaseCompactLock: () => {},
    getMessages: () => msgs,
    setMessages: (m: Message[]) => {
      msgs = m;
    },
    compactWithSummary,
    getTranscriptPath: () => undefined,
    appendReattachMessages: (m: Message[]) => {
      msgs = [...msgs, ...m];
    },
  };
  return {
    ctxMgr,
    provider: failingProvider,
    config: { model: "test-model" },
    providerRegistry: undefined,
    hookSystem: undefined,
    getCurrentMessages: () => msgs,
  } as any;
}

describe("P0-1 手动 /compact 兜底 no-op 不得谎报成功（新版命令）", () => {
  test("no_split_point → 文案报「未生效」+ reason，不含「已压缩」，历史未变", async () => {
    const ctx = makeCtx(buildMessages(8), { noopReason: "no_split_point" });

    const result = await compactMod.call("", ctx);

    expect(result.type).toBe("text");
    const value = (result as any).value as string;
    expect(value).toContain("压缩未生效");
    expect(value).toContain("no_split_point");
    expect(value).not.toContain("已压缩");
    // 消息一字不动
    expect(ctx.ctxMgr.messageCount()).toBe(16);
  });

  test("invalid_result_rolled_back → 同型如实报失败", async () => {
    const ctx = makeCtx(buildMessages(8), { noopReason: "invalid_result_rolled_back" });
    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("压缩未生效");
    expect((result as any).value).toContain("invalid_result_rolled_back");
    expect((result as any).value).not.toContain("已压缩");
  });

  test("no_reduction → 同型如实报失败", async () => {
    const ctx = makeCtx(buildMessages(8), { noopReason: "no_reduction" });
    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("压缩未生效");
    expect((result as any).value).toContain("no_reduction");
    expect((result as any).value).not.toContain("已压缩");
  });

  test("no-op 时不得 fire PostCompact hook（hook 语义是「压缩已完成」）", async () => {
    const ctx = makeCtx(buildMessages(8), { noopReason: "no_split_point" });
    const postTriggers: string[] = [];
    ctx.hookSystem = {
      firePreCompactEvent: async () => ({}),
      firePostCompactEvent: async (trigger: string) => {
        postTriggers.push(trigger);
        return {};
      },
    };

    await compactMod.call("", ctx);
    expect(postTriggers.length).toBe(0);
  });

  test("兜底真正压动 → 文案保持「已降级为本地截断」（回归保护）", async () => {
    const ctx = makeCtx(buildMessages(8)); // 无 noopReason → 兜底成功
    const result = await compactMod.call("", ctx);
    const value = (result as any).value as string;
    expect(value).toContain("已降级为本地截断");
    expect(value).toContain("16 → 2 条消息");
    expect(ctx.ctxMgr.messageCount()).toBe(2);
  });
});
