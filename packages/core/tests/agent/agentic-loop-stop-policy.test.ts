/**
 * 子循环停止判据与可观测性（2026-10-29）
 *
 * 锁住：
 *   1. 子循环与主循环用同一份 classifyStopReason（源码哨兵：不再自比 stopReason 字面量）
 *   2. 子循环每次模型响应落 SubagentLoopTurn（带 agent_id / 原始 stop_reason / tool_use_* 事实）
 *   3. F2 命中落 StopReasonMismatch、F1 命中落 EmptyParamRetry，均带 agent_id
 *   4. AgentLoopResult 带停止归因（stopAction / lastStopReason / f2MismatchCount / f1RetryCount）
 *   5. max_tokens 带完整 tool_use → 先执行工具（与主循环 P1-4 对齐，此前子循环直接续写）
 *
 * 驱动真实 runAgentLoop，不绕入口。
 *
 * fix_type: regression_guard
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

async function* textStream(text: string, stopReason: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { outputTokens: 5 },
  } as any;
}

async function* toolStream(
  id: string,
  input: Record<string, unknown>,
  stopReason: string,
): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name: "read" },
  } as any;
  if (Object.keys(input).length > 0) {
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    } as any;
  }
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { outputTokens: 5 },
  } as any;
}

class ReadTool implements LegacyTool {
  readonly calls: Array<Record<string, unknown>> = [];
  name() {
    return "read";
  }
  description() {
    return "read";
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
    this.calls.push(input);
    return { output: "ok" };
  }
}

function run(scripted: Array<() => AsyncIterable<StreamEvent>>) {
  let idx = 0;
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: () => scripted[Math.min(idx++, scripted.length - 1)](),
  } as unknown as Provider;
  const read = new ReadTool();
  const tools = new ToolRegistry();
  tools.register(read as any);
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const promise = runAgentLoop({
    provider,
    model: "mock-model",
    ctxMgr,
    tools,
    maxTurns: 10,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    permissionChecker: undefined,
    maxStreamRetries: 0,
    agentId: "agent-test-1",
    traceAppendEvent: (ev: { event: string; data?: Record<string, unknown> }) =>
      events.push({ event: ev.event, data: ev.data ?? {} }),
  } as any);
  return { promise, events, read };
}

describe("子循环停止判据与主循环同源", () => {
  test("源码哨兵：子循环经 classifyStopReason 分派，不再自比 end_turn/max_tokens/ctx_window 字面量", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/agentic-loop.ts"), "utf8");
    expect(src).toContain("classifyStopReason(");
    for (const lit of [
      "end_turn",
      "stop_sequence",
      "max_tokens",
      "length",
      "model_context_window_exceeded",
      "tool_use",
    ]) {
      expect(src).not.toContain(`response.stopReason === "${lit}"`);
    }
  });
});

describe("子循环事件通道与停止归因", () => {
  test("F2（end_turn + tool_use）→ 执行工具、落 StopReasonMismatch + SubagentLoopTurn，结果带归因", async () => {
    const { promise, events, read } = run([
      () => toolStream("t1", { file_path: "a" }, "end_turn"),
      () => textStream("完成", "end_turn"),
    ]);
    const r = await promise;
    expect(r.success).toBe(true);
    expect(read.calls.map((c) => c.file_path)).toEqual(["a"]);

    const turnsEv = events.filter((e) => e.event === "SubagentLoopTurn");
    expect(turnsEv.length).toBe(2);
    expect(turnsEv[0]!.data).toMatchObject({
      agent_id: "agent-test-1",
      stop_reason: "end_turn",
      stop_reason_kind: "raw",
      stop_action: "execute_tools:f2_end_turn",
      tool_use_total: 1,
      tool_use_empty_params: 0,
    });
    expect(turnsEv[1]!.data.stop_action).toBe("finalize");
    const mm = events.filter((e) => e.event === "StopReasonMismatch");
    expect(mm.length).toBe(1);
    expect(mm[0]!.data.agent_id).toBe("agent-test-1");

    expect(r.stopAction).toBe("finalize");
    expect(r.lastStopReason).toBe("end_turn");
    expect(r.f2MismatchCount).toBe(1);
    expect(r.f1RetryCount).toBe(0);
  });

  test("F1 空参数 → 落 EmptyParamRetry（带 agent_id），f1RetryCount 计数", async () => {
    const { promise, events, read } = run([
      () => toolStream("e1", {}, "tool_use"),
      () => toolStream("t2", { file_path: "b" }, "tool_use"),
      () => textStream("完成", "end_turn"),
    ]);
    const r = await promise;
    expect(read.calls.map((c) => c.file_path)).toEqual(["b"]);
    const ep = events.filter((e) => e.event === "EmptyParamRetry");
    expect(ep.length).toBe(1);
    expect(ep[0]!.data).toMatchObject({
      agent_id: "agent-test-1",
      attempt: 1,
      hits: [{ name: "read", truncated: false, has_required_params: true }],
    });
    expect(r.f1RetryCount).toBe(1);
  });

  test("max_tokens + 完整 tool_use → 先执行工具（P1-4 对齐主循环）", async () => {
    const { promise, read } = run([
      () => toolStream("t1", { file_path: "a" }, "max_tokens"),
      () => textStream("完成", "end_turn"),
    ]);
    const r = await promise;
    expect(read.calls.map((c) => c.file_path)).toEqual(["a"]);
    expect(r.f2MismatchCount).toBe(1);
  });

  test("未识别停止原因 → stopAction=unknown_stop_reason", async () => {
    const { promise } = run([() => textStream("半截", "content_filter")]);
    const r = await promise;
    expect(r.stopAction).toBe("unknown_stop_reason");
    expect(r.lastStopReason).toBe("content_filter");
  });
});
