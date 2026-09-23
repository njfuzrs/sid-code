/**
 * P1-1 / P1-2：Stop Hook 聚合与 preventContinuation
 *
 * 文档缺口：packages/core/tests 下原先零 handleStopHooks / forceStop 测试，
 * 也无 Stop 事件 OR 语义测试。本文件锁住两条契约：
 *   1. continue===false 优先于 decision:block（两者同时时走 forceStop，不进自动修复）
 *   2. 多枚 Stop Hook 走 OR：先 block 后 allow 仍整体拦，且收集全部 block 原因
 */
import { describe, test, expect } from "bun:test";
import { handleStopHooks } from "@sid-code/core/query/stop-hooks.ts";
import { HookAggregator } from "@sid-code/core/hook/aggregator.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { HookExecutionResult } from "@sid-code/core/hook/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

function hookResult(
  eventName: HookEventName,
  output: HookExecutionResult["output"],
  command = "hook",
): HookExecutionResult {
  return {
    hookConfig: { type: "command", command },
    eventName,
    success: true,
    output,
    duration: 1,
  };
}

async function drainStop(gen: AsyncGenerator<unknown, unknown>) {
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

function makeCtx(): ContextManager {
  const ctx = new ContextManager({ maxTokens: 200_000 });
  ctx.setSystemPrompt("test");
  ctx.addMessage({
    role: "user",
    content: [{ type: "text", text: "请完成任务" }],
  } as Message);
  return ctx;
}

describe("P1-2 · Stop 事件聚合走 OR", () => {
  test("先 block 后 allow → 整体拦（Ralph 验证器互相覆盖的原形态）", () => {
    const agg = new HookAggregator();
    const result = agg.aggregateResults(
      [
        hookResult(HookEventName.Stop, { decision: "block", reason: "lint 失败" }, "lint"),
        hookResult(HookEventName.Stop, { decision: "allow" }, "test"),
      ],
      HookEventName.Stop,
    );
    expect(result.finalOutput?.isBlockingDecision()).toBe(true);
    expect(result.finalOutput?.getEffectiveReason()).toContain("lint 失败");
    expect(result.allOutputs.length).toBe(2);
  });

  test("任一 continue===false → shouldStopExecution", () => {
    const agg = new HookAggregator();
    const result = agg.aggregateResults(
      [
        hookResult(HookEventName.Stop, { continue: false, stopReason: "别再试" }, "stop"),
        hookResult(HookEventName.Stop, { decision: "allow" }, "pass"),
      ],
      HookEventName.Stop,
    );
    expect(result.finalOutput?.shouldStopExecution()).toBe(true);
  });
});

describe("P1-1 / P1-2 · handleStopHooks", () => {
  test("continue===false 优先于 decision:block → forceStop，不注入修复", async () => {
    const ctx = makeCtx();
    const before = ctx.messageCount();
    const hookSystem = {
      fireStopEvent: async () => ({
        finalOutput: {
          shouldStopExecution: () => true,
          isBlockingDecision: () => true,
          getEffectiveReason: () => "lint 失败",
        },
        allOutputs: [{ continue: false, decision: "block", reason: "lint 失败" }],
      }),
    } as any;

    const result = await drainStop(handleStopHooks(hookSystem, ctx, "做完了", 0));
    // P2-3：passed 区分"真跑了验证且全通过"与其它 shouldContinue=false 成因。
    // forceStop 走的是 preventContinuation，不是"验证通过"，故 passed=false。
    expect(result).toEqual({
      shouldContinue: false,
      forceStop: true,
      errorMessages: [],
      passed: false,
    });
    expect(ctx.messageCount()).toBe(before);
  });

  test("多枚 Stop Hook：allOutputs 里先 block 后 allow → 收集全部 block 原因并续修", async () => {
    const ctx = makeCtx();
    const hookSystem = {
      fireStopEvent: async () => ({
        // 聚合器修好后 finalOutput 也会 block；这里故意让它也 block，
        // 同时 allOutputs 含两条 block + 一条 allow，断言原因去重拼接。
        finalOutput: {
          shouldStopExecution: () => false,
          isBlockingDecision: () => true,
          getEffectiveReason: () => "lint 失败",
        },
        allOutputs: [
          { decision: "block", reason: "lint 失败" },
          { decision: "block", reason: "typecheck 失败" },
          { decision: "allow" },
        ],
      }),
    } as any;

    const result = (await drainStop(handleStopHooks(hookSystem, ctx, "做完了", 0))) as {
      shouldContinue: boolean;
      forceStop: boolean;
      errorMessages: string[];
    };
    expect(result.shouldContinue).toBe(true);
    expect(result.forceStop).toBe(false);
    expect(result.errorMessages).toEqual(["lint 失败", "typecheck 失败"]);

    const injected = ctx
      .getMessages()
      .filter(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) =>
              b.type === "text" &&
              typeof b.text === "string" &&
              b.text.includes("lint 失败") &&
              b.text.includes("typecheck 失败"),
          ),
      );
    expect(injected.length).toBe(1);
  });

  test("全部 allow → 正常结束", async () => {
    const ctx = makeCtx();
    const hookSystem = {
      fireStopEvent: async () => ({
        finalOutput: {
          shouldStopExecution: () => false,
          isBlockingDecision: () => false,
          getEffectiveReason: () => "",
        },
        allOutputs: [{ decision: "allow" }, { decision: "allow" }],
      }),
    } as any;

    const result = await drainStop(handleStopHooks(hookSystem, ctx, "做完了", 0));
    // P2-3：这是唯一该置 passed=true 的形态（真跑了 hook、全部 allow）——
    // loop.ts 据此清零 stopHookRetryCount。
    expect(result).toEqual({
      shouldContinue: false,
      forceStop: false,
      errorMessages: [],
      passed: true,
    });
  });
});
