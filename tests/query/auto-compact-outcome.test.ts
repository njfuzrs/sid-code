/**
 * 静默-9 回归：autoCompact 返回压缩结果（summarized / truncated / skipped），
 * loop 侧据此对 truncated（有损降级）yield warning。
 *
 * 这里聚焦 autoCompact 的返回契约：
 *   - 消息太少 → "skipped"
 *   - LLM 摘要 provider 抛错 → 降级简单截断 → "truncated"
 */

import { describe, test, expect } from "bun:test";
import { autoCompact } from "../../src/query/auto-compact.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import type { Message, StreamEvent } from "../../src/llm/types.ts";
import type { Provider } from "../../src/llm/provider.ts";

/** 最小 HookSystem 桩：pre/post compact 均不阻止 */
const noopHookSystem: any = {
  firePreCompactEvent: async () => ({ finalOutput: null }),
  firePostCompactEvent: async () => ({ finalOutput: null }),
};

/** 抛错的 provider：模拟 LLM 摘要失败 */
const throwingProvider: Provider = {
  name: () => "mock",
  async *sendMessageStream(): AsyncIterable<StreamEvent> {
    throw new Error("摘要请求失败（模拟）");
  },
} as any;

function buildCtx(msgCount: number): ContextManager {
  const ctx = new ContextManager({ maxTokens: 100_000 });
  for (let i = 0; i < msgCount; i++) {
    ctx.addMessage({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `消息 ${i}` }] } as Message);
  }
  return ctx;
}

function buildDeps(ctx: ContextManager): any {
  return {
    provider: throwingProvider,
    config: { model: "mock-model", provider: "mock" },
    ctxMgr: ctx,
    hookSystem: noopHookSystem,
    getAbortSignal: () => undefined,
    isMainAgent: false, // 不污染全局熔断器
  };
}

describe("autoCompact — 返回压缩结果（静默-9）", () => {
  test("消息太少 → skipped", async () => {
    const ctx = buildCtx(2);
    const outcome = await autoCompact(buildDeps(ctx));
    expect(outcome).toBe("skipped");
  });

  test("LLM 摘要失败 → 降级简单截断 → truncated", async () => {
    const ctx = buildCtx(20);
    const outcome = await autoCompact(buildDeps(ctx));
    expect(outcome).toBe("truncated");
  });
});
