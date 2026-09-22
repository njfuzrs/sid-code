/**
 * P1-5：autoCompact 必须读 compactWithSummary().success。
 *
 * 切点无效时不得 recordSuccess / 不得报 summarized；熔断器不得被假成功复位。
 * 隔离手段同 false-compaction-report.test.ts：桩掉 compactWithSummary。
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  autoCompact,
  resetCircuitBreaker,
  peekCircuitBreaker,
} from "@sid-code/core/query/auto-compact.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { Message, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { CompactionOutcome } from "@sid-code/core/context/manager.ts";

const noopHookSystem: any = {
  firePreCompactEvent: async () => ({ finalOutput: null }),
  firePostCompactEvent: async () => ({ finalOutput: null }),
};

function buildMessages(n: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `消息 ${i} `.repeat(20) }],
    });
  }
  return msgs;
}

class NoopCompactManager extends ContextManager {
  compactCalls = 0;
  constructor(msgs: Message[]) {
    super({ maxTokens: 100_000 });
    this.setMessages(msgs);
  }
  override compactWithSummary(): CompactionOutcome {
    this.compactCalls++;
    const n = this.messageCount();
    return {
      success: false,
      messageCountBefore: n,
      messageCountAfter: n,
      tokensBefore: 0,
      tokensAfter: 0,
      splitPoint: 0,
      reason: "no_split_point",
    };
  }
}

function summaryProvider(text: string): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      } as StreamEvent;
      yield { type: "message_stop" } as StreamEvent;
    },
  } as Provider;
}

function throwingProvider(): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      throw new Error("摘要请求失败（模拟）");
    },
  } as Provider;
}

afterEach(() => {
  resetCircuitBreaker();
});

describe("P1-5 · compactWithSummary 失败不得宣告成功", () => {
  test("LLM 产出摘要但切点无效 → skipped，熔断器记失败不复位", async () => {
    resetCircuitBreaker();
    const ctx = new NoopCompactManager(buildMessages(20));
    const outcome = await autoCompact({
      provider: summaryProvider("一份看起来很完整的摘要"),
      config: { model: "mock-model", provider: "mock" },
      ctxMgr: ctx,
      hookSystem: noopHookSystem,
      getAbortSignal: () => undefined,
      isMainAgent: true,
    } as any);

    expect(outcome).toBe("skipped");
    // 摘要生成成功后切点无效 → LLM 压缩 1 次 + 降级截断 1 次。若 provider 抛错只会 1 次，那是测错路径。
    expect(ctx.compactCalls).toBe(2);
    expect(ctx.messageCount()).toBe(20);
    const br = peekCircuitBreaker();
    expect(br).not.toBeNull();
    expect(br!.state).toBe("closed");
    expect(br!.failures).toBeGreaterThanOrEqual(1);
  });

  test("Session Memory 有内容但切点无效 → 回退 LLM；LLM 也压不动 → skipped", async () => {
    resetCircuitBreaker();
    const ctx = new NoopCompactManager(buildMessages(20));
    const outcome = await autoCompact({
      provider: summaryProvider("LLM 摘要"),
      config: { model: "mock-model", provider: "mock" },
      ctxMgr: ctx,
      hookSystem: noopHookSystem,
      getAbortSignal: () => undefined,
      isMainAgent: true,
      sessionMemory: {
        getContent: async () => "# Current State\n正在修 P1 闸门。",
        waitForExtraction: async () => {},
      },
    } as any);

    expect(outcome).toBe("skipped");
    expect(ctx.messageCount()).toBe(20);
    // Session Memory 1 次 + LLM 摘要 1 次 + 降级截断 1 次
    expect(ctx.compactCalls).toBe(3);
    const br = peekCircuitBreaker();
    expect(br!.failures).toBeGreaterThanOrEqual(1);
  });

  test("切点无效不得把已 open 的熔断器 recordSuccess 复位", async () => {
    resetCircuitBreaker();
    // 先用会抛错的 provider 把熔断器打到 open（默认阈值 3）
    const priming = new NoopCompactManager(buildMessages(20));
    for (let i = 0; i < 3; i++) {
      await autoCompact({
        provider: throwingProvider(),
        config: { model: "mock-model", provider: "mock" },
        ctxMgr: priming,
        hookSystem: noopHookSystem,
        getAbortSignal: () => undefined,
        isMainAgent: true,
      } as any);
    }
    expect(peekCircuitBreaker()?.state).toBe("open");

    const ctx = new NoopCompactManager(buildMessages(20));
    const outcome = await autoCompact({
      provider: summaryProvider("假摘要"),
      config: { model: "mock-model", provider: "mock" },
      ctxMgr: ctx,
      hookSystem: noopHookSystem,
      getAbortSignal: () => undefined,
      isMainAgent: true,
    } as any);

    expect(outcome).toBe("skipped");
    expect(peekCircuitBreaker()?.state).toBe("open");
  });
});
