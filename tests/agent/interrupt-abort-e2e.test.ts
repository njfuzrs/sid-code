/**
 * 中断 / abort 端到端测试 — D2-3
 *
 * 对应 ADR-039 Follow-up B-Followup-1 + 系统级查漏补缺方案 D2-3。
 * 串起三道防线，验证完整链路：
 *   中断（executeTools 抛 AbortError）
 *     → queryLoop 优雅收尾：补 cancel tool_result（A2 / D1-2）
 *     → 退出时把完整历史落 messages.json（D3-1，用真实 TraceWriter）
 *     → 重新加载落盘历史
 *     → 断言：无孤儿 tool_use，且 strict 模式下能再次安全发送（= 可恢复，不会 400）
 *
 * "可恢复"的判据：落盘历史喂回 guardOutgoingMessages(strict) 不抛——
 * 即这段历史可以直接作为 resume 的起点重新发给 provider 而不触发协议 400。
 *
 * 注：原测试驱动已删除的 AgentLoopRunner（生产死代码，abort 时 throw 穿透）；
 * 迁移到真实 queryLoop 后，abort 是"用户主动中断"的正常路径——补 cancel result
 * 后 yield done 优雅收尾，不抛异常（对标 claude-code）。落盘→重载→可恢复的硬判据不变。
 *
 * fix_type: case_design（L1）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import { TraceWriter } from "../../src/trace/writer.ts";
import { toAbortError } from "../../src/llm/errors.ts";
import type { Config } from "../../src/config/config.ts";
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

function makeConfig(): Config {
  return { model: "mock-model", provider: "mock", maxTokens: 4096, maxTurns: 10 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  // 不 yield 任何事件——真实 abort 时 SDK 已被 signal 中断
}

function makeLoopConfig(opts: {
  ctxMgr: ContextManager;
  toolResponse: ContentBlock[];
}): QueryLoopConfig {
  const processStream = async (): Promise<AccumulatedResponse> => ({
    role: "assistant",
    content: opts.toolResponse,
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  // 中断：executeTools 在执行中被 AbortError 切开
  const executeTools = async () => {
    throw toAbortError();
  };
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream,
    executeTools,
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
  };
  return {
    config: makeConfig(),
    ctxMgr: opts.ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session-d23"),
    fallback: new ModelFallback(),
    deps,
  };
}

describe("D2-3 — 中断 / abort 端到端", () => {
  test("中断 → 兜底 → 落盘 → 重载：历史无孤儿且可恢复（可再次安全发送）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "sid-d23-"));
    tmpDirs.push(baseDir);

    // 1. 真实 queryLoop 跑一轮带 2 个 tool_use 的响应，executeTools 中断
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "帮我改两个文件" }] });
    const toolResponse: ContentBlock[] = [
      { type: "text", text: "开始执行" },
      { type: "tool_use", id: "tu_a", name: "edit", input: { file: "a.ts" } },
      { type: "tool_use", id: "tu_b", name: "write", input: { file: "b.ts" } },
    ];
    const loopConfig = makeLoopConfig({ ctxMgr, toolResponse });

    // queryLoop 对 abort 是优雅收尾（yield done），不抛异常
    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }
    expect(kinds).toContain("done");

    // 2. 中断后历史已被 queryLoop 兜底（A2 / D1-2）：无孤儿
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

    // 7. 进一步坐实：tu_a/tu_b 都有对应 tool_result（兜底填的 cancel 占位）
    const resultIds = reloadedMessages
      .filter(m => m.role === "user")
      .flatMap(m => m.content)
      .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map(b => b.tool_use_id);
    expect(resultIds).toContain("tu_a");
    expect(resultIds).toContain("tu_b");
  });
});
