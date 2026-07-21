/**
 * P0-1：/compact 参数语义分流回归测试
 *
 * 三分支：
 *   1. 无参 → 全量摘要式压缩（走 ctxMgr.compactWithSummary）
 *   2. 数字参数 → 部分压缩（走 partialCompact，压前半段）
 *   3. 文本参数 → focus 压缩（走 partialCompact + customInstructions 注入 focus 文本）
 *
 * 关键断言：focus 文本进入了摘要请求的 prompt（mock provider 捕获 sendMessageStream 入参）。
 */

import { describe, test, expect } from "bun:test";
import compactMod from "../../src/command/commands/compact/compact.ts";
import type { Message } from "../../src/llm/types.ts";

/** 构造一段够长、round 边界干净的消息历史（user/assistant 交替，无工具往返） */
function buildMessages(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `问题${i}` }] });
    msgs.push({ role: "assistant", content: [{ type: "text", text: `回答${i}` }] });
  }
  return msgs;
}

/** mock provider：捕获摘要请求 prompt，返回固定摘要流 */
function makeMockProvider(capturedPrompts: string[]) {
  return {
    async *sendMessageStream(req: any) {
      const userText = req.messages
        .flatMap((m: any) => m.content)
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      capturedPrompts.push(userText);
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "<summary>摘要内容</summary>" } };
      yield { type: "message_stop", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

/** mock ctxMgr：持有可变消息数组，实现命令用到的方法 */
function makeCtx(messages: Message[], provider: any) {
  let msgs = messages;
  const ctxMgr = {
    messageCount: () => msgs.length,
    estimateTokens: () => msgs.length * 10,
    acquireCompactLock: () => true,
    releaseCompactLock: () => {},
    getMessages: () => msgs,
    setMessages: (m: Message[]) => { msgs = m; },
    compactWithSummary: (summary: string) => {
      msgs = [
        { role: "user", content: [{ type: "text", text: summary }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ];
    },
    getTranscriptPath: () => undefined,
  };
  return {
    ctxMgr,
    provider,
    config: { model: "test-model" },
    providerRegistry: undefined,
    hookSystem: undefined,
    getCurrentMessages: () => msgs,
  } as any;
}

describe("P0-1 /compact 参数分流", () => {
  test("文本参数 → focus 文本进入摘要 prompt", async () => {
    const captured: string[] = [];
    const provider = makeMockProvider(captured);
    const ctx = makeCtx(buildMessages(8), provider);

    const result = await compactMod.call("focus on auth errors", ctx);

    expect(result.type).toBe("text");
    expect((result as any).value).toContain("focus 压缩完成");
    // focus 文本必须出现在发给 provider 的摘要 prompt 里
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.join("\n")).toContain("focus on auth errors");
  });

  test("数字参数 → 部分压缩，不注入 focus 指令", async () => {
    const captured: string[] = [];
    const provider = makeMockProvider(captured);
    const ctx = makeCtx(buildMessages(8), provider);

    const result = await compactMod.call("0.5", ctx);

    expect(result.type).toBe("text");
    expect((result as any).value).toContain("部分压缩完成");
    // 不应包含 focus 提示语
    expect(captured.join("\n")).not.toContain("重点保留与");
  });

  test("无参 → 全量摘要式压缩，不调用 provider", async () => {
    const captured: string[] = [];
    const provider = makeMockProvider(captured);
    const ctx = makeCtx(buildMessages(8), provider);

    const result = await compactMod.call("", ctx);

    expect(result.type).toBe("text");
    expect((result as any).value).toContain("对话已压缩");
    // 无参走本地截断摘要，不发 LLM 请求
    expect(captured.length).toBe(0);
  });

  test("历史太短 → 拒绝压缩", async () => {
    const captured: string[] = [];
    const provider = makeMockProvider(captured);
    const ctx = makeCtx(buildMessages(1), provider);

    const result = await compactMod.call("focus on x", ctx);
    expect((result as any).value).toContain("太短");
  });
});
