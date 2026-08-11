/**
 * Phase 2 单测：消息转换器（QueryEngineEvent → SDKMessage）
 */

import { describe, test, expect } from "bun:test";
import { convertToSDKMessage, type ConvertContext } from "@sid-code/core/sdk/message-converter.ts";
import type { QueryEngineEvent } from "@sid-code/core/query/types.ts";

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

  test("tombstone → status warning（模型降级可见，静默-7）", () => {
    const ev: QueryEngineEvent = {
      kind: "tombstone",
      message: { role: "assistant", content: [] },
      reason: "downgrade",
    };
    const out = convertToSDKMessage(ev, ctx);
    expect(out).toMatchObject({
      type: "system",
      subtype: "status",
      level: "warning",
    });
    expect((out as any).message).toContain("降级");
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
    // compact 事件必须携带压缩实据（messageCountBefore/After 均为必填，且
    // after < before 是不变式）——零字段的 `{ kind: "compact" }` 正是 2026-07-29
    // 假压缩误报事故的写法，字段设为必填就是为了让它编译不过。见 src/query/types.ts:69。
    const out = convertToSDKMessage(
      { kind: "compact", messageCountBefore: 20, messageCountAfter: 6 },
      ctx,
    );
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

  test("system → status（含 level 透传，静默-7）", () => {
    const out = convertToSDKMessage(
      { kind: "system", level: "info", text: "note" },
      ctx,
    );
    expect(out).toMatchObject({ type: "system", subtype: "status", message: "note", level: "info" });
    // 验证 warning/error 也正确透传
    const warn = convertToSDKMessage({ kind: "system", level: "warning", text: "w" }, ctx);
    expect((warn as any).level).toBe("warning");
    const err = convertToSDKMessage({ kind: "system", level: "error", text: "e" }, ctx);
    expect((err as any).level).toBe("error");
  });

  test("fatal_error → result(error_during_execution)（不再谎报 success）", () => {
    const out = convertToSDKMessage(
      { kind: "fatal_error", message: "boom", recoverable: false },
      ctx,
    );
    expect(out).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      num_turns: 2,
      session_id: "s1",
      total_cost_usd: 0.05,
    });
    // 关键回归断言：不能是 success
    expect((out as { subtype: string }).subtype).not.toBe("success");
    expect((out as { errors: string[] }).errors).toEqual(["boom"]);
    // 注入的 now() = 2000, startTime = 1000
    expect((out as { duration_ms: number }).duration_ms).toBe(1000);
  });

  test("fatal_error 带 stack → errors 含堆栈", () => {
    const out = convertToSDKMessage(
      { kind: "fatal_error", message: "boom", stack: "at foo\nat bar", recoverable: false },
      ctx,
    );
    expect((out as { errors: string[] }).errors[0]).toContain("boom");
    expect((out as { errors: string[] }).errors[0]).toContain("at foo");
  });
});
