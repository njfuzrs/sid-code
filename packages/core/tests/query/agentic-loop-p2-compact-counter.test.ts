/**
 * P2-6 回归：压缩成功必须清零 `consecutiveCompactFailures`。
 *
 * 缺陷文档《20260920-AgenticLoop主循环审查》十、P2-6。熔断器读的是**连续**失败数
 * （MAX_CONSECUTIVE_COMPACT_FAILURES=3），但只有流式阶段的 reactiveCompact 成功路径
 * 清零，另外三条路径（连接阶段 reactiveCompact 成功、两处 autoCompact 真压动）只补失败、
 * 不清成功。于是「失败 → 成功 → 失败」会被累计，counter 名字里的"连续"被实现改成了"累计"，
 * 用户看到的错误文案（"连续 N 次自动压缩都未能减少历史"）也随之变成假话。
 *
 * 测法：让前两轮 prompt-too-long 且压不动（记 2 次失败），第三轮压得动（应清零），
 * 之后再失败若干次——若清零生效，熔断不会在"累计第 3 次"就触发。
 */
import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse } from "@sid-code/core/llm/types.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 30,
    maxTokens: 1_000_000,
    ...overrides,
  } as unknown as Config;
}

function endTurnResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "做完了" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

const PTL = "prompt is too long: 1200000 tokens > 1000000 maximum";

/**
 * 构造一个历史够长（> reactiveCompact 的 `<=4 条` 守卫）的 ctxMgr，
 * 使「压得动 / 压不动」可以由测试自己控制，而不是被守卫一刀切成恒失败。
 */
function makeCtxMgr(messagePairs: number): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
  ctxMgr.setSystemPrompt("test");
  for (let i = 0; i < messagePairs; i++) {
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: `问题 ${i}` }] });
    ctxMgr.addMessage({ role: "assistant", content: [{ type: "text", text: `回答 ${i}` }] });
  }
  return ctxMgr;
}

describe("P2-6 · 连接阶段压缩成功要清零连续失败计数", () => {
  test("失败2次 → 成功1次 → 再失败2次：不得在累计第3次就熔断", async () => {
    // 形态：autoCompact 前两次压不动（各记 1 次失败），第三次真压动（应清零）。
    // 旧实现：失败2 + 后续失败1 = 累计 3 → 熔断，且告诉用户"连续 3 次都未能减少历史"，
    // 其中一次其实成功了。清零生效后，这条路径要走到"成功之后再连续 3 次失败"才熔断。
    const ctxMgr = makeCtxMgr(12);

    let sendAttempts = 0;
    let compactCalls = 0;
    const deps = {
      sendWithRetry: () => {
        sendAttempts++;
        // 持续 prompt-too-long，把循环钉在压缩路径上
        throw new Error(PTL);
      },
      processStream: async () => endTurnResp(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {
        compactCalls++;
        // 第 3 次调用真压动（删两条），其余压不动
        if (compactCalls === 3) {
          const msgs = ctxMgr.getMessages();
          ctxMgr.setMessages(msgs.slice(2));
        }
      },
      handleContextOverflow: () => null,
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "u",
      traceAppendEvent: () => {},
    } as unknown as QueryDeps;

    const loopConfig: QueryLoopConfig = {
      config: makeConfig(),
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-p2-6"),
      fallback: new ModelFallback(),
      deps,
    };

    const systemTexts: string[] = [];
    let sawDone = false;
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system") systemTexts.push(ev.text);
      if (ev.kind === "done") sawDone = true;
    }

    // 仍然必须收敛（清零不能把熔断撤掉——那会换来 CC 踩过的空转 3272 次）
    expect(sawDone).toBe(true);
    const joined = systemTexts.join("\n");
    expect(joined).toContain("/compact");

    // ★核心：精确到次数，因为这条 bug 的全部内容就是"连续"被实现成了"累计"。
    //
    //   修复后（连续语义）：失败1、失败2、**成功3（清零）**、失败4、失败5、失败6
    //                       → 成功之后攒满 3 次连续失败才熔断 = 6 次
    //   旧实现（累计语义）：失败1、失败2、成功3（不清零，计数仍是 2）、失败4
    //                       → 累计到 3 立刻熔断 = 4 次
    //
    // 用区间断言（如 `> 3`）会正好落在 4 与 6 之间之外——实测两种实现分别是 4 和 6，
    // `> 3` 两边都满足，测试就什么都没锁住（第一版正是如此）。故这里断言确切值。
    expect(compactCalls).toBe(6);
    // 上界仍受熔断约束，不会失控空转
    expect(sendAttempts).toBeLessThanOrEqual(12);
  }, 20_000);

  test("压缩一直压不动 → 仍在 3 次连续失败后熔断（清零没把封顶撤掉）", async () => {
    // 反向保险：这条锁住"只在真成功时清零"。若误写成无条件清零，熔断永不触发，
    // 这个测试会跑到 maxTurns 甚至超时。
    const ctxMgr = makeCtxMgr(12);

    let compactCalls = 0;
    const deps = {
      sendWithRetry: () => {
        throw new Error(PTL);
      },
      processStream: async () => endTurnResp(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {
        compactCalls++; // 永不压动
      },
      handleContextOverflow: () => null,
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "u",
      traceAppendEvent: () => {},
    } as unknown as QueryDeps;

    const loopConfig: QueryLoopConfig = {
      config: makeConfig(),
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-p2-6b"),
      fallback: new ModelFallback(),
      deps,
    };

    const systemTexts: string[] = [];
    let sawDone = false;
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system") systemTexts.push(ev.text);
      if (ev.kind === "done") sawDone = true;
    }

    expect(sawDone).toBe(true);
    expect(systemTexts.join("\n")).toContain("/compact");
    // 阈值 3 + 少量兜底，不该无限空转
    expect(compactCalls).toBeLessThanOrEqual(8);
  }, 20_000);
});
