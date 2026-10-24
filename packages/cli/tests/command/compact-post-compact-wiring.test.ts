/**
 * P1-12：手动 /compact 的压缩后收尾接线回归
 *
 * 来源：`docs-research/sid-code/bugfixes/todo/20260920-上下文工程-顺着sc-02-context核出的缺陷.md`
 *
 *   P1-12 质量校验把「完整保留、从未进摘要」的尾部原文算进锚点分母 → 覆盖率系统性偏低，
 *         本该合格的部分压缩被报成「摘要质量塌陷」。
 *
 * （P1-11「手动路径漏传 cachedMicrocompactState」的用例已随该模块删除：冷清理决策
 *  现在是 ContextManager 的会话状态，压缩时由 resetLocalCompactState 统一清空，
 *  见 packages/core/tests/context/cold-cache-clear.test.ts。）
 */

import { describe, test, expect } from "bun:test";
import compactMod from "@sid-code/cli/command/commands/compact/compact.ts";
import { checkCompactQuality } from "@sid-code/core/query/compact/quality-check.ts";
import { resolvePartialSplitIndex } from "@sid-code/core/query/compact/partial-compact.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 够长、round 边界干净的历史；每轮 user 文本带一个独特路径锚点 */
function buildMessages(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "user",
      content: [{ type: "text", text: `改一下 src/mod${i}.ts 这个文件` }],
    });
    msgs.push({ role: "assistant", content: [{ type: "text", text: `回答${i}` }] });
  }
  return msgs;
}

function makeMockProvider() {
  return {
    async *sendMessageStream() {
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "<summary>摘要内容</summary>" },
      };
      yield { type: "message_stop", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

function makeCtx(messages: Message[]) {
  let msgs = messages;
  const ctxMgr = {
    messageCount: () => msgs.length,
    estimateTokens: () => msgs.length * 10,
    acquireCompactLock: () => true,
    releaseCompactLock: () => {},
    getMessages: () => msgs,
    setMessages: (m: Message[]) => {
      msgs = m;
    },
    compactWithSummary: (summary: string) => {
      const before = msgs.length;
      msgs = [{ role: "user", content: [{ type: "text", text: summary }] }];
      // P0-1 契约：真实实现返回 CompactionOutcome，mock 必须同形状
      //（兜底路径据此分支文案）。
      return {
        success: msgs.length < before,
        messageCountBefore: before,
        messageCountAfter: msgs.length,
        tokensBefore: before * 10,
        tokensAfter: msgs.length * 10,
        splitPoint: before - 1,
      };
    },
    getTranscriptPath: () => undefined,
    appendReattachMessages: (m: Message[]) => {
      msgs = [...msgs, ...m];
    },
  };
  return {
    ctxMgr,
    provider: makeMockProvider(),
    config: { model: "test-model" },
    providerRegistry: undefined,
    hookSystem: undefined,
    getCurrentMessages: () => msgs,
  } as any;
}

describe("手动 /compact 收尾", () => {
  test("收尾照常完成，不抛错", async () => {
    const result = await compactMod.call("0.5", makeCtx(buildMessages(8)));
    expect(result.type).toBe("text");
    expect((result as any).value).not.toContain("压缩未执行");
  });
});

describe("P1-12 — 质量校验分母只含真正进摘要的那一段", () => {
  test("保留段的锚点算进分母会压低覆盖率（缺陷的直接后果）", () => {
    const msgs = buildMessages(8);
    const splitIndex = resolvePartialSplitIndex(msgs, 0.5);
    expect(splitIndex).toBeGreaterThan(0);

    const toCompact = msgs.slice(0, splitIndex);
    // 摘要只可能覆盖被压段的锚点——它根本没看到保留段
    const summary = toCompact
      .flatMap((m) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    const correct = checkCompactQuality(toCompact, summary);
    const buggy = checkCompactQuality(msgs, summary);

    // 正确分母下覆盖率满分；错误分母（含保留段）必然更低
    expect(correct.coverage).toBe(1);
    expect(buggy.coverage).toBeLessThan(correct.coverage);
    expect(buggy.totalAnchors).toBeGreaterThan(correct.totalAnchors);
  });

  test("保留段越大，错误分母的失真越严重（随 upTo 变小而增大）", () => {
    const msgs = buildMessages(12);
    const coverageAt = (ratio: number): number => {
      const idx = resolvePartialSplitIndex(msgs, ratio);
      const toCompact = msgs.slice(0, idx);
      const summary = toCompact
        .flatMap((m) => m.content)
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      return checkCompactQuality(msgs, summary).coverage; // 刻意用错误分母
    };
    // 压得越少（保留段越大）→ 错误分母算出的覆盖率越低
    expect(coverageAt(0.3)).toBeLessThan(coverageAt(0.8));
  });
});
