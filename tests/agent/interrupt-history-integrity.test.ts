/**
 * 中断路径消息历史完整性测试 — D1-2
 *
 * 本次 bug（2026-06-04 deepseek 第 19 次 API call 触发 400）的真实路径：
 *   assistant tool_calls 已 addMessage → executeTools 被 AbortError 切开 →
 *   loop.ts 的 catch 兜底必须补齐 tool_result，使 ctxMgr.getMessages() 无孤儿。
 *
 * 当前零覆盖（tool-result-invariant.test.ts 只测 executeTools 单函数，
 * plan-approval-ordering.test.ts 重新实现了 loop 步骤而非跑真实 loop）。
 * 本测试直接驱动**真实 AgentLoopRunner.run()** + 真实 ContextManager，
 * 让 loop.ts:591-607 的 catch 真正执行，再用 D1-4 共享不变量断言无孤儿。
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

/** 最小 Provider：sendMessageStream 永远返回一个含 2 个 tool_use 的响应 */
function makeToolUseProvider(): Provider {
  const provider: any = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    capabilities: () => ({
      streaming: true,
      tools: true,
      thinking: false,
      vision: false,
      promptCaching: false,
      parallelToolCalls: true,
    }),
    // eslint-disable-next-line require-yield
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      // 真实 loop 不直接消费这个流（processStream 被我们 mock），
      // 但 fallback.executeWithFallback 会调用它拿 stream 对象，故需可迭代。
      yield { type: "message_stop" };
    },
  };
  return provider as Provider;
}

/** 构造一个会被中断的 loop deps */
function makeDeps(opts: {
  ctxMgr: ContextManager;
  toolResponse: ContentBlock[];
  executeTools: (content: ContentBlock[]) => Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }>;
}): AgentLoopDeps {
  const config: any = {
    provider: "mock",
    model: "mock-model",
    maxTokens: 4096,
    maxTurns: 10,
  };

  // processStream 直接返回预设的 tool_use 响应（不真正解析流）
  const processStream = async (
    _stream: AsyncIterable<StreamEvent>,
    _onText?: (t: string) => void,
  ): Promise<AccumulatedResponse> => {
    return {
      role: "assistant",
      content: opts.toolResponse,
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };

  return {
    config,
    provider: makeToolUseProvider(),
    ctxMgr: opts.ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session-d12"),
    fallback: new ModelFallback(),
    thinkingMgr: new ThinkingManager(false),
    executeTools: opts.executeTools,
    processStream,
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
  };
}

/** 收集 callbacks（只关心是否完成 / 异常） */
function makeCallbacks() {
  return {
    onStreamText: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onCompact: () => {},
    onComplete: () => {},
  };
}

describe("D1-2 — 中断路径消息历史完整性", () => {
  test("executeTools 抛 AbortError：loop catch 兜底后 ctxMgr 无孤儿 tool_use", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });

    const toolResponse: ContentBlock[] = [
      { type: "text", text: "我需要读两个文件" },
      { type: "tool_use", id: "tu_1", name: "read", input: { file: "a.ts" } },
      { type: "tool_use", id: "tu_2", name: "read", input: { file: "b.ts" } },
    ];

    // 模拟中断：executeTools 在执行过程中被 AbortError 切开（本次 bug 的真实触发）
    const executeTools = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };

    const runner = new AgentLoopRunner(makeDeps({ ctxMgr, toolResponse, executeTools }));

    // run 会因 AbortError 上抛（loop.ts:606 throw err），catch 它
    let thrown: unknown = null;
    try {
      await runner.run("帮我读文件", makeCallbacks());
    } catch (e) {
      thrown = e;
    }

    // AbortError 应被上抛
    expect(thrown).not.toBeNull();
    expect((thrown as Error).name).toBe("AbortError");

    // 关键不变量：catch 兜底（yieldMissingToolResults）后，消息历史无孤儿
    const messages: Message[] = ctxMgr.getMessages();
    const integrity = checkMessageHistoryIntegrity(messages);
    expect(integrity.intact).toBe(true);
    expect(integrity.orphans).toHaveLength(0);

    // 进一步坐实：assistant 的 tu_1/tu_2 都有对应 tool_result
    const resultIds = messages
      .filter(m => m.role === "user")
      .flatMap(m => m.content)
      .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map(b => b.tool_use_id)
      .sort();
    expect(resultIds).toContain("tu_1");
    expect(resultIds).toContain("tu_2");
  });

  test("executeTools 抛普通异常：catch 兜底后同样无孤儿", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });

    const toolResponse: ContentBlock[] = [
      { type: "tool_use", id: "x_1", name: "edit", input: {} },
    ];

    const executeTools = async () => {
      throw new Error("工具执行炸了（非 abort）");
    };

    const runner = new AgentLoopRunner(makeDeps({ ctxMgr, toolResponse, executeTools }));

    let thrown: unknown = null;
    try {
      await runner.run("改个文件", makeCallbacks());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();

    const integrity = checkMessageHistoryIntegrity(ctxMgr.getMessages());
    expect(integrity.intact).toBe(true);
  });
});
