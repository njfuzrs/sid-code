/**
 * P1-11 / P1-12：手动 /compact 的压缩后收尾接线回归
 *
 * 来源：`docs-research/sid-code/bugfixes/todo/20260920-上下文工程-顺着sc-02-context核出的缺陷.md`
 *
 *   P1-11 手动路径漏传 `cachedMicrocompactState` → runPostCompact 第 2 步
 *         （重置 microcompact 状态机）永远走不到，两个 Map/Set 跨多次手动压缩无界增长。
 *   P1-12 质量校验把「完整保留、从未进摘要」的尾部原文算进锚点分母 → 覆盖率系统性偏低，
 *         本该合格的部分压缩被报成「摘要质量塌陷」。
 *
 * 断言对着「缺陷的可观察后果」写：state 是否真被清空、覆盖率分母是否只含被压段。
 */

import { describe, test, expect } from "bun:test";
import compactMod from "@sid-code/cli/command/commands/compact/compact.ts";
import {
  createCachedMicrocompactState,
  type CachedMicrocompactState,
} from "@sid-code/core/query/compact/cached-microcompact.ts";
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

function makeCtx(messages: Message[], mcState?: CachedMicrocompactState) {
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
      msgs = [{ role: "user", content: [{ type: "text", text: summary }] }];
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
    cachedMicrocompactState: mcState,
    getCurrentMessages: () => msgs,
  } as any;
}

describe("P1-11 — 手动 /compact 重置 microcompact 状态机", () => {
  test("传入 state → 手动压缩后被清空（此前静默跳过，长会话里是真实内存泄漏）", async () => {
    const state = createCachedMicrocompactState();
    state.tools.set("toolu_old_1", { name: "read_file", tokens: 100 } as any);
    state.deleted.add("toolu_old_2");

    const result = await compactMod.call("0.5", makeCtx(buildMessages(8), state));

    expect(result.type).toBe("text");
    expect(state.tools.size).toBe(0);
    expect(state.deleted.size).toBe(0);
  });

  test("未传 state（本会话没跑过 microcompact）→ 收尾照常完成，不抛错", async () => {
    const result = await compactMod.call("0.5", makeCtx(buildMessages(8), undefined));
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
