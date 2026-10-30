/**
 * 停止归因 digest（2026-10-29）：v1 老会话（无 schema 版本、无新事件）→ undefined，
 * 不能被读成「0 次非正常收尾」；v2 数据按 incomplete_reason / F1 / 子循环 stop_action 聚合。
 *
 * fix_type: regression_guard
 */
import { describe, test, expect } from "bun:test";
import { aggregateStopAttributionStats } from "@sid-code/core/trace/digest.ts";

describe("aggregateStopAttributionStats", () => {
  test("v1 老会话：无新字段 → undefined（缺失不是 0）", () => {
    expect(
      aggregateStopAttributionStats([
        { event: "SessionStart", data: { source: "startup" } },
        { event: "TurnComplete", data: { stop_reason: "end_turn" } },
        { event: "TurnComplete", data: { stop_reason: "other" } },
      ]),
    ).toBeUndefined();
  });

  test("v2：按 incomplete_reason / F1 / 子循环 stop_action 聚合", () => {
    const s = aggregateStopAttributionStats([
      { event: "SessionStart", data: { trace_schema_version: 2 } },
      { event: "TurnComplete", data: { stop_reason: "end_turn", stop_reason_kind: "normalized" } },
      {
        event: "TurnComplete",
        data: { stop_reason: "other", incomplete_reason: "context_window_exhausted" },
      },
      {
        event: "TurnComplete",
        data: { stop_reason: "other", incomplete_reason: "empty_param_exhausted" },
      },
      {
        event: "EmptyParamRetry",
        data: { hits: [{ name: "write", truncated: true }], attempt: 1 },
      },
      {
        event: "EmptyParamRetry",
        data: { hits: [{ name: "write", truncated: false }], exhausted: true },
      },
      { event: "EmptyParamRetry", data: { hits: [], agent_id: "a1" } },
      { event: "SubagentLoopTurn", data: { stop_action: "finalize", agent_id: "a1" } },
      {
        event: "SubagentLoopTurn",
        data: { stop_action: "execute_tools:tool_use", agent_id: "a1" },
      },
    ]);
    expect(s).toEqual({
      schemaVersion: 2,
      incompleteByReason: { context_window_exhausted: 1, empty_param_exhausted: 1 },
      emptyParam: { hits: 3, truncatedHits: 1, exhausted: 1, subagent: 1 },
      subagentStopActions: { finalize: 1, "execute_tools:tool_use": 1 },
    });
  });
});
