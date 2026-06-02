/**
 * Phase 2 单测：消息转换器（QueryEngineEvent → SDKMessage）
 */

import { describe, test, expect } from "bun:test";
import { convertToSDKMessage, type ConvertContext } from "../../src/sdk/message-converter.ts";
import type { QueryEngineEvent } from "../../src/query/types.ts";

const ctx: ConvertContext = {
  sessionId: "s1",
  totalUsage: { inputTokens: 10, outputTokens: 20 },
  startTime: 1000,
  turnCount: 2,
  totalCostUsd: 0.05,
  now: () => 2000,
  uuid: () => "fixed-uuid",
};

describe("convertToSDKMessage", () => {
  test("user_message_added → null（不转发）", () => {
    expect(convertToSDKMessage({ kind: "user_message_added" }, ctx)).toBeNull();
  });

  test("tombstone → null（内部信号）", () => {
    const ev: QueryEngineEvent = {
      kind: "tombstone",
      message: { role: "assistant", content: [] },
      reason: "downgrade",
    };
    expect(convertToSDKMessage(ev, ctx)).toBeNull();
  });

  test("assistant_message → assistant", () => {
    const ev: QueryEngineEvent = {
      kind: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    };
    const out = convertToSDKMessage(ev, ctx);
    expect(out).toMatchObject({
      type: "assistant",
      uuid: "fixed-uuid",
      session_id: "s1",
      stop_reason: null,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  test("stream_text → stream_event", () => {
    const out = convertToSDKMessage({ kind: "stream_text", text: "abc" }, ctx);
    expect(out?.type).toBe("stream_event");
  });

  test("tool_start → tool_progress(start)", () => {
    const out = convertToSDKMessage(
      { kind: "tool_start", toolName: "Bash", toolInput: { command: "ls" } },
      ctx,
    );
    expect(out).toMatchObject({
      type: "tool_progress",
      tool_name: "Bash",
      status: "start",
      input: { command: "ls" },
    });
  });

  test("tool_end → tool_progress(end)", () => {
    const out = convertToSDKMessage(
      { kind: "tool_end", toolName: "Bash", result: { isError: false, elapsedMs: 12 } },
      ctx,
    );
    expect(out).toMatchObject({
      type: "tool_progress",
      tool_name: "Bash",
      status: "end",
      result: { is_error: false, elapsed_ms: 12 },
    });
  });

  test("compact → compact_boundary", () => {
    const out = convertToSDKMessage({ kind: "compact" }, ctx);
    expect(out).toMatchObject({ type: "system", subtype: "compact_boundary" });
  });

  test("context_warning → status", () => {
    const out = convertToSDKMessage({ kind: "context_warning", remaining: 15 }, ctx);
    expect(out).toMatchObject({ type: "system", subtype: "status" });
    expect((out as { message: string }).message).toContain("15");
  });

  test("max_turns → result(error_max_turns)", () => {
    const out = convertToSDKMessage({ kind: "max_turns", maxTurns: 30 }, ctx);
    expect(out).toMatchObject({
      type: "result",
      subtype: "error_max_turns",
      num_turns: 2,
      session_id: "s1",
      total_cost_usd: 0.05,
    });
    // 注入的 now() = 2000, startTime = 1000
    expect((out as { duration_ms: number }).duration_ms).toBe(1000);
  });

  test("done → result(success) 骨架", () => {
    const out = convertToSDKMessage({ kind: "done", turns: 3 }, ctx);
    expect(out).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      stop_reason: "end_turn",
    });
  });

  test("hook_blocked → hook_response", () => {
    const out = convertToSDKMessage({ kind: "hook_blocked", reason: "denied" }, ctx);
    expect(out).toMatchObject({
      type: "system",
      subtype: "hook_response",
      decision: "denied",
    });
  });

  test("loop_detected → status", () => {
    const out = convertToSDKMessage({ kind: "loop_detected", detail: "repeat" }, ctx);
    expect(out).toMatchObject({ type: "system", subtype: "status" });
  });

  test("loop_recovery → status", () => {
    const out = convertToSDKMessage(
      { kind: "loop_recovery", attempt: 1, maxAttempts: 3 },
      ctx,
    );
    expect(out).toMatchObject({ type: "system", subtype: "status" });
  });

  test("system → status", () => {
    const out = convertToSDKMessage(
      { kind: "system", level: "info", text: "note" },
      ctx,
    );
    expect(out).toMatchObject({ type: "system", subtype: "status", message: "note" });
  });
});
