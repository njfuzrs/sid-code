/**
 * P0-3 余项：子代理 loop_recovery 补 result + 发送前 finalizeMessagesForSend
 *
 * F1 连坐 / F2 fall-through 已由 #69（subagent-f1-f2-stop-reason.test.ts）锁住。
 * 本文件只锁 #69 明确没做的两道：
 *   - loopDetected 只注入 prompt、不补 tool_result → 下一轮 400
 *   - 发给 LLM 的是裸 getCleanedMessages()，无 finalizeMessagesForSend
 *
 * 直接驱动 runAgentLoop，不绕入口。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

beforeAll(() => {
  process.env.SID_ENABLE_LOOP_DETECTION = "1";
});
afterAll(() => {
  delete process.env.SID_ENABLE_LOOP_DETECTION;
});

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

class MockReadTool implements LegacyTool {
  executed: Array<Record<string, unknown>> = [];
  name() {
    return "read";
  }
  description() {
    return "读取文件";
  }
  inputSchema() {
    return {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    };
  }
  readOnly() {
    return true;
  }
  async execute(input: Record<string, unknown>): Promise<LegacyToolResult> {
    this.executed.push(input);
    return { output: `file ${String(input.file_path)}` };
  }
}

function yieldToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  stopReason: string,
): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name },
    } as StreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

function yieldText(text: string, stopReason = "end_turn"): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    { type: "content_block_start", index: 0, content_block: { type: "text" } } as StreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

function makeScriptedProvider(script: StreamEvent[][]): Provider {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const events = script[Math.min(call, script.length - 1)] ?? yieldText("完成");
      call++;
      for (const e of events) yield e;
    },
  } as unknown as Provider;
}

function allowAll() {
  return { check: async () => ({ allowed: true }) } as any;
}

describe("P0-3 loop_recovery — 跳过 executeTools 时必须补占位 result", () => {
  test("连续相同 tool_use 触发循环检测后历史无孤儿", async () => {
    const read = new MockReadTool();
    const tools = new ToolRegistry();
    tools.register(read as any);
    const same = { file_path: "/loop.ts" };
    const provider = makeScriptedProvider([
      yieldToolUse("c1", "read", same, "tool_use"),
      yieldToolUse("c2", "read", same, "tool_use"),
      yieldToolUse("c3", "read", same, "tool_use"),
      yieldText("换思路"),
    ]);
    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 8,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);
    const integrity = checkMessageHistoryIntegrity(result.messages as any);
    expect(integrity.orphans, "循环恢复必须补占位，不能留下孤儿").toHaveLength(0);
    // 至少有一轮被循环检测拦住没执行：executed < 发出的 tool_use 次数。
    expect(read.executed.length).toBeLessThan(3);
  });
});

describe("P0-3 发送前兜底 — 子代理必须走 finalizeMessagesForSend", () => {
  test("历史里已有孤儿 tool_use 时，发送前补占位，循环结束仍无孤儿", async () => {
    const ctxMgr = makeCtxMgr();
    ctxMgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "orphan1", name: "read", input: { file_path: "/x.ts" } }],
    });
    const tools = new ToolRegistry();
    tools.register(new MockReadTool() as any);
    const result = await runAgentLoop({
      provider: makeScriptedProvider([yieldText("看到占位了")]),
      model: "mock-model",
      ctxMgr,
      tools,
      maxTurns: 3,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);
    const integrity = checkMessageHistoryIntegrity(result.messages as any);
    expect(integrity.orphans, "发送前兜底必须补齐入口处已有的孤儿").toHaveLength(0);
    const placeholder = result.messages.some((m) =>
      m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "orphan1"),
    );
    expect(placeholder).toBe(true);
  });

  test("agentic-loop 发送前调用 finalizeMessagesForSend，并接线 injectLoopRecovery", () => {
    const src = readFileSync(
      new URL("../../src/agent/agentic-loop.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).toContain("finalizeMessagesForSend(");
    expect(src).toContain("injectLoopRecovery(");
    expect(src).toContain("buildPendingToolResults(");
  });
});
