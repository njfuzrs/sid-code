/**
 * 发现 5：F2「stop_reason 与 content 不一致」告警按 (provider, model) 去重 + digest 计数
 *
 * fix_type: logic
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  noteStopReasonMismatch,
  resetStopReasonMismatchForTest,
} from "@sid-code/core/agent/stop-reason-mismatch.ts";
import { aggregateStopReasonMismatchStats } from "@sid-code/core/trace/digest.ts";
import { mapResponsesStatus } from "@sid-code/core/llm/openai-responses.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");

describe("noteStopReasonMismatch：按 (provider, model) 计数", () => {
  beforeEach(() => resetStopReasonMismatchForTest());

  test("同一对只有首次返回 1，不同对各自独立", () => {
    expect(noteStopReasonMismatch("openai", "gpt-6-luna")).toBe(1);
    expect(noteStopReasonMismatch("openai", "gpt-6-luna")).toBe(2);
    expect(noteStopReasonMismatch("openai", "gpt-6-sol")).toBe(1);
    expect(noteStopReasonMismatch("anthropic", "gpt-6-luna")).toBe(1);
  });
});

describe("aggregateStopReasonMismatchStats", () => {
  test("按 provider/model 计数；无事件返回 undefined", () => {
    expect(aggregateStopReasonMismatchStats([{ event: "Other" }])).toBeUndefined();
    const s = aggregateStopReasonMismatchStats([
      { event: "StopReasonMismatch", data: { provider: "openai", model: "a" } },
      { event: "StopReasonMismatch", data: { provider: "openai", model: "a" } },
      { event: "StopReasonMismatch", data: { provider: "openai", model: "b" } },
    ]);
    expect(s).toEqual({ total: 3, byModel: { "openai/a": 2, "openai/b": 1 } });
  });
});

describe("mapResponsesStatus：流式与非流式共用", () => {
  test("工具优先；incomplete 区分 content_filter", () => {
    expect(mapResponsesStatus("completed", undefined, true)).toBe("tool_use");
    expect(mapResponsesStatus("completed", undefined, false)).toBe("end_turn");
    expect(mapResponsesStatus("incomplete", "max_output_tokens", false)).toBe("max_tokens");
    expect(mapResponsesStatus("incomplete", "content_filter", false)).toBe("content_filter");
  });
});

describe("接线：主循环 / 子循环 / headless", () => {
  const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

  test("主循环 warn 受首次守卫，并发 StopReasonMismatch 事件", () => {
    const src = read("packages/core/src/query/loop.ts");
    expect(src).toContain("if (mismatchCount === 1) {");
    expect(src).toContain('event: "StopReasonMismatch"');
  });

  test("子循环 warn 受同一去重表守卫", () => {
    const src = read("packages/core/src/agent/agentic-loop.ts");
    expect(src).toContain(
      "if (f2FallThrough && noteStopReasonMismatch(provider.name(), model) === 1)",
    );
  });

  test("headless 收尾判据是 isEndTurnLike && !hasPendingToolUse，不是只看 end_turn", () => {
    const src = read("packages/cli/src/entrypoints/headless.ts");
    expect(src).toContain("isEndTurnLikeStopReason(response.stopReason) && !hasPendingToolUse");
    expect(src).not.toContain(
      'if (response.stopReason === "end_turn" || response.stopReason === "stop")',
    );
  });

  test("流式 response.completed 不再写死 end_turn", () => {
    const src = read("packages/core/src/llm/openai-responses.ts");
    expect(src).not.toContain('delta: { stop_reason: "end_turn" }');
  });
});
