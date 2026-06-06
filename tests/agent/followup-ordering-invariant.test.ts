/**
 * followup / plan-mode 时序不变量测试 — D1-3
 *
 * 背景：loop.ts:609-616 的 ADR-019 约束"followup 的 user 消息必须排在 tool_result 之后"
 * 此前只靠注释提醒、无机制强制（系统级查漏补缺方案 §1.2）。本测试把它升级为"测试强制"：
 * 直接驱动**真实 AgentLoopRunner.run()**，断言 executeTools 返回 followup 时，
 * 最终 ctxMgr 历史中 tool_result 一定排在 followup 之前，且整体无孤儿（D1-4 不变量）。
 *
 * 与 plan-approval-ordering.test.ts 的区别：那个测试重新实现了 loop 步骤（MockCtxMgr +
 * runLoopStepWithFollowup）；本测试跑真实 loop.ts，覆盖"真实时序"而非"模拟时序"。
 *
 * fix_type: core_code（L3，测试）
 */

import { describe, test, expect } from "bun:test";
import { AgentLoopRunner, type AgentLoopDeps } from "../../src/agent/loop.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { ThinkingManager } from "../../src/llm/thinking.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type {
  StreamEvent,
  AccumulatedResponse,
  ContentBlock,
  Message,
} from "../../src/llm/types.ts";
import { checkMessageHistoryIntegrity } from "../../src/agent/message-invariants.ts";

function makeProvider(): Provider {
  const provider: any = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    capabilities: () => ({
      streaming: true, tools: true, thinking: false,
      vision: false, promptCaching: false, parallelToolCalls: true,
    }),
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "message_stop" };
    },
  };
  return provider as Provider;
}

/**
 * deps：第一轮返回 tool_use（触发 executeTools），第二轮返回 end_turn（结束循环）。
 * executeTools 返回 results + followup，模拟 plan-mode 批准反馈。
 */
function makeDeps(opts: {
  ctxMgr: ContextManager;
  results: ContentBlock[];
  followup: ContentBlock[];
}): AgentLoopDeps {
  const config: any = { provider: "mock", model: "mock-model", maxTokens: 4096, maxTurns: 10 };

  let call = 0;
  const processStream = async (): Promise<AccumulatedResponse> => {
    call++;
    if (call === 1) {
      return {
        role: "assistant",
        content: [
          { type: "text", text: "提交计划" },
          { type: "tool_use", id: "plan_1", name: "exit_plan_mode", input: {} },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    // 第二轮：正常结束
    return {
      role: "assistant",
      content: [{ type: "text", text: "已按计划执行完毕" }],
      stopReason: "end_turn",
      usage: { inputTokens: 8, outputTokens: 4 },
    };
  };

  const executeTools = async () => ({
    results: opts.results,
    followup: opts.followup,
  });

  return {
    config,
    provider: makeProvider(),
    ctxMgr: opts.ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session-d13"),
    fallback: new ModelFallback(),
    thinkingMgr: new ThinkingManager(false),
    executeTools,
    processStream,
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
  };
}

function makeCallbacks() {
  return {
    onStreamText: () => {}, onToolStart: () => {}, onToolEnd: () => {},
    onCompact: () => {}, onComplete: () => {},
  };
}

/** 在消息序列中找某 block 类型首次出现的消息下标 */
function firstIndexOfBlockType(messages: Message[], pred: (b: ContentBlock) => boolean): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].content.some(pred)) return i;
  }
  return -1;
}

describe("D1-3 — followup / plan-mode 时序不变量", () => {
  test("executeTools 返回 followup：tool_result 排在 followup 之前，历史无孤儿", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });

    const results: ContentBlock[] = [
      { type: "tool_result", tool_use_id: "plan_1", content: "plan submitted" },
    ];
    const followup: ContentBlock[] = [
      { type: "text", text: "用户已批准计划，请按计划执行。" },
    ];

    const runner = new AgentLoopRunner(makeDeps({ ctxMgr, results, followup }));
    await runner.run("做个计划", makeCallbacks());

    const messages = ctxMgr.getMessages();

    // 1. 整体无孤儿（plan_1 的 tool_use 有对应 tool_result）
    const integrity = checkMessageHistoryIntegrity(messages);
    expect(integrity.intact).toBe(true);

    // 2. tool_result 必须排在 followup(plan_approved text) 之前
    const toolResultIdx = firstIndexOfBlockType(messages, b => b.type === "tool_result");
    const followupIdx = firstIndexOfBlockType(
      messages,
      b => b.type === "text" && b.text.includes("批准"),
    );
    expect(toolResultIdx).toBeGreaterThanOrEqual(0);
    expect(followupIdx).toBeGreaterThanOrEqual(0);
    expect(toolResultIdx).toBeLessThan(followupIdx);

    // 3. tool_result 紧贴 assistant(tool_use)：assistant < tool_result
    const assistantToolUseIdx = firstIndexOfBlockType(messages, b => b.type === "tool_use");
    expect(assistantToolUseIdx).toBeLessThan(toolResultIdx);
  });

  test("无 followup 时：历史仍合法（基线对照）", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    const results: ContentBlock[] = [
      { type: "tool_result", tool_use_id: "plan_1", content: "ok" },
    ];
    const runner = new AgentLoopRunner(makeDeps({ ctxMgr, results, followup: [] }));
    await runner.run("做个计划", makeCallbacks());
    expect(checkMessageHistoryIntegrity(ctxMgr.getMessages()).intact).toBe(true);
  });
});
