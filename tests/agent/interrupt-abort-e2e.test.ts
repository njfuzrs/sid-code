/**
 * 中断 / abort 端到端测试 — D2-3
 *
 * 对应 ADR-039 Follow-up B-Followup-1 + 系统级查漏补缺方案 D2-3。
 * 串起三道防线，验证完整链路：
 *   中断（executeTools 抛 AbortError）
 *     → loop.ts catch 兜底填齐 tool_result（D1-2）
 *     → 退出时把完整历史落 messages.json（D3-1，用真实 TraceWriter）
 *     → 重新加载落盘历史
 *     → 断言：无孤儿 tool_use，且 strict 模式下能再次安全发送（= 可恢复，不会 400）
 *
 * "可恢复"的判据：落盘历史喂回 guardOutgoingMessages(strict) 不抛——
 * 即这段历史可以直接作为 resume 的起点重新发给 provider 而不触发协议 400。
 *
 * fix_type: case_design（L1）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoopRunner, type AgentLoopDeps } from "../../src/agent/loop.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { ThinkingManager } from "../../src/llm/thinking.ts";
import { SessionState } from "../../src/session/state.ts";
import { TraceWriter } from "../../src/trace/writer.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type {
  StreamEvent,
  AccumulatedResponse,
  ContentBlock,
  Message,
} from "../../src/llm/types.ts";
import { checkMessageHistoryIntegrity } from "../../src/agent/message-invariants.ts";
import { guardOutgoingMessages } from "../../src/llm/protocol-sentinel.ts";

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tmpDirs = [];
});

function makeProvider(): Provider {
  const p: any = {
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
  return p as Provider;
}

function makeDeps(opts: {
  ctxMgr: ContextManager;
  toolResponse: ContentBlock[];
}): AgentLoopDeps {
  const config: any = { provider: "mock", model: "mock-model", maxTokens: 4096, maxTurns: 10 };
  const processStream = async (): Promise<AccumulatedResponse> => ({
    role: "assistant",
    content: opts.toolResponse,
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  // 中断：executeTools 在执行中被 AbortError 切开
  const executeTools = async () => {
    const e = new Error("aborted by user");
    e.name = "AbortError";
    throw e;
  };
  return {
    config,
    provider: makeProvider(),
    ctxMgr: opts.ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session-d23"),
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

describe("D2-3 — 中断 / abort 端到端", () => {
  test("中断 → 兜底 → 落盘 → 重载：历史无孤儿且可恢复（可再次安全发送）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "sid-d23-"));
    tmpDirs.push(baseDir);

    // 1. 真实 loop 跑一轮带 2 个 tool_use 的响应，executeTools 中断
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "帮我改两个文件" }] });
    const toolResponse: ContentBlock[] = [
      { type: "text", text: "开始执行" },
      { type: "tool_use", id: "tu_a", name: "edit", input: { file: "a.ts" } },
      { type: "tool_use", id: "tu_b", name: "write", input: { file: "b.ts" } },
    ];
    const runner = new AgentLoopRunner(makeDeps({ ctxMgr, toolResponse }));

    let aborted = false;
    try {
      await runner.run("帮我改两个文件", makeCallbacks());
    } catch (e) {
      aborted = (e as Error).name === "AbortError";
    }
    expect(aborted).toBe(true);

    // 2. 中断后历史已被 loop catch 兜底（D1-2）：无孤儿
    const liveMessages = ctxMgr.getMessages();
    expect(checkMessageHistoryIntegrity(liveMessages).intact).toBe(true);

    // 3. 落盘 messages.json（D3-1，用真实 TraceWriter）
    const sessionId = "sess-d23";
    const writer = new TraceWriter(baseDir, sessionId);
    writer.writeMessagesSnapshot({
      kind: "messages-snapshot",
      session_id: sessionId,
      reason: "abort",
      messages: liveMessages,
    });
    const msgPath = join(baseDir, "sessions", sessionId, "messages.json");
    expect(existsSync(msgPath)).toBe(true);

    // 4. 重新加载落盘历史
    const reloaded = JSON.parse(readFileSync(msgPath, "utf-8"));
    const reloadedMessages: Message[] = reloaded.messages;
    expect(Array.isArray(reloadedMessages)).toBe(true);

    // 5. 重载历史无孤儿
    expect(checkMessageHistoryIntegrity(reloadedMessages).intact).toBe(true);

    // 6. 可恢复：strict 模式下能再次安全发送（不会 400）。
    //    这是"中断后可 resume"的硬判据——落盘历史可直接作为下次请求的起点。
    expect(() =>
      guardOutgoingMessages(reloadedMessages, { providerName: "mock", strict: true }),
    ).not.toThrow();

    // 7. 进一步坐实：tu_a/tu_b 都有对应 tool_result（兜底填的 error 占位）
    const resultIds = reloadedMessages
      .filter(m => m.role === "user")
      .flatMap(m => m.content)
      .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map(b => b.tool_use_id);
    expect(resultIds).toContain("tu_a");
    expect(resultIds).toContain("tu_b");
  });
});
