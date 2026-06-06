/**
 * 循环恢复路径消息历史完整性测试 — 第四条孤儿来源（系统级查漏补缺方案）
 *
 * 真实 bug（2026-06-06 session 28b7eed7 21:28 崩溃）的路径：
 *   deepseek 连续等价工具调用 → ToolShapeLoopDetector/ToolCallLoopDetector 触发 →
 *   recoverFromLoop 注入纯 text 恢复提示并 continue → executeTools 被跳过 →
 *   assistant 的 tool_use 永远拿不到 tool_result → 孤儿 → 下一次发送 OpenAI 400。
 *
 * 本测试直接驱动**真实 AgentLoopRunner.run()**（app.ts 运行时用的就是它），
 * 让 stopReason=tool_use 的轮次触发循环检测 → recoverFromLoop，
 * 再用 D1-4 共享不变量断言 ctxMgr 历史无孤儿（修复前必红，修复后必绿）。
 *
 * 同时覆盖发送前 backstop：即便恢复路径漏补，发送前关卡也会兜底。
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
      streaming: true,
      tools: true,
      thinking: false,
      vision: false,
      promptCaching: false,
      parallelToolCalls: true,
    }),
    // eslint-disable-next-line require-yield
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield { type: "message_stop" };
    },
  };
  return provider as Provider;
}

/**
 * processStream 每次返回**等价的** tool_use（同 name + 同 input），
 * 让循环检测在 tool_use 轮次必然触发。每次用新的 tool_use id 模拟真实模型行为
 * （真实模型每轮 id 不同，但 name/input 相同 → 触发 exact/shape 检测）。
 */
function makeDeps(opts: {
  ctxMgr: ContextManager;
  toolName: string;
  toolInput: unknown;
  executeTools: AgentLoopDeps["executeTools"];
}): AgentLoopDeps {
  const config: any = {
    provider: "mock",
    model: "mock-model",
    maxTokens: 4096,
    maxTurns: 30,
  };

  let callIndex = 0;
  const processStream = async (): Promise<AccumulatedResponse> => {
    callIndex++;
    return {
      role: "assistant",
      content: [
        { type: "text", text: `第 ${callIndex} 次尝试` },
        { type: "tool_use", id: `call_${callIndex}`, name: opts.toolName, input: opts.toolInput },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };

  return {
    config,
    provider: makeProvider(),
    ctxMgr: opts.ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-loop-recovery"),
    fallback: new ModelFallback(),
    thinkingMgr: new ThinkingManager(false),
    executeTools: opts.executeTools,
    processStream,
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
  };
}

function makeCallbacks() {
  return {
    onStreamText: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onCompact: () => {},
    onComplete: () => {},
  };
}

describe("第四条孤儿来源 — 循环恢复路径历史完整性", () => {
  test("循环检测在 tool_use 轮次触发 → recoverFromLoop 跳过 executeTools → 历史仍无孤儿", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });

    // executeTools 正常返回（让循环能多轮累积，直到检测器触发）
    const executeTools = async (content: ContentBlock[]) => {
      const results: ContentBlock[] = content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map(b => ({ type: "tool_result" as const, tool_use_id: b.id, content: "未找到匹配的内容" }));
      return { results };
    };

    // 等价的重复 bash 调用（复刻崩溃现场：反复 rg 同一目标）
    const runner = new AgentLoopRunner(
      makeDeps({
        ctxMgr,
        toolName: "bash",
        toolInput: { command: "rg escape src/ui", description: "搜索" },
        executeTools,
      }),
    );

    await runner.run("反复搜索一个不存在的字符串", makeCallbacks());

    // 关键不变量：无论循环检测在哪一轮触发、是否跳过 executeTools，
    // 最终 ctxMgr 历史都不能残留孤儿 tool_use（否则下一次发送即 400）。
    const messages: Message[] = ctxMgr.getMessages();
    const integrity = checkMessageHistoryIntegrity(messages);
    expect(integrity.intact).toBe(true);
    expect(integrity.orphans).toHaveLength(0);

    // 同时不能出现相邻同角色（恢复占位合并不破坏交替）
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
  });

  test("多轮工具调用全程无 400 成因：每条 assistant tool_use 都有应答", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });

    const executeTools = async (content: ContentBlock[]) => {
      const results: ContentBlock[] = content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map(b => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" }));
      return { results };
    };

    const runner = new AgentLoopRunner(
      makeDeps({
        ctxMgr,
        toolName: "grep",
        toolInput: { pattern: "escape", path: "src/ui" },
        executeTools,
      }),
    );

    await runner.run("查找", makeCallbacks());

    // 收集所有 assistant.tool_use id 与所有 tool_result id，断言前者 ⊆ 后者
    const messages = ctxMgr.getMessages();
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.tool_use_id);
      }
    }
    for (const id of useIds) {
      expect(resultIds.has(id)).toBe(true);
    }
  });
});
