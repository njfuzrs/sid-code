/**
 * S1 L1：`EndTurnShape` / `PromiseNudge` → digest 会话级指标 → session-index `short_text_end_turns`。
 * 分母 `end_turn_n` 必须与分子一起落（铁律 3）；没跑 digest 的增量路径不落键（缺失 ≠ 0）。
 */
import { describe, test, expect } from "bun:test";
import { aggregateSessionMetrics } from "@sid-code/core/trace/digest.ts";
import { buildSessionIndexEntry } from "@sid-code/core/trace/session-index.ts";

const ev = (event: string, data: Record<string, unknown>) => ({ event, data });

describe("short_text_end_turns", () => {
  const events = [
    ev("EndTurnShape", { kind: "answered", text_len: 900, promptSeq: 1, turn: 3 }),
    ev("EndTurnShape", { kind: "promise_after_tools", text_len: 37, promptSeq: 2, turn: 14 }),
    ev("PromiseNudge", { fired: true, outcome: "tool_use", lang: "zh" }),
    ev("EndTurnShape", { kind: "short_after_tools", text_len: 12, promptSeq: 2, turn: 16 }),
    ev("EndTurnShape", { kind: "empty", text_len: 0, promptSeq: 3, turn: 1 }),
    ev("PromiseNudge", { fired: false, outcome: "not_fired", skip_reason: "capped" }),
  ];

  test("digest 计分子 / 分母 / 续跑兑现，并给出证据指针", () => {
    const m = aggregateSessionMetrics(events, { trajCorrupt: false });
    expect(m.short_text_end_turns).toBe(2);
    expect(m.end_turn_n).toBe(4);
    expect(m.promise_nudge_fired).toBe(1);
    expect(m.promise_nudge_tool_use).toBe(1);
    expect(m.short_text_end_turn_samples[0]).toEqual({
      prompt_seq: 2,
      turn: 14,
      text_len: 37,
      kind: "promise_after_tools",
    });
  });

  test("索引：传了才落，且分母同落；不传不落键", () => {
    const withIt = buildSessionIndexEntry(
      { session_id: "s" },
      { ts: 1, short_text_end_turns: 2, end_turn_n: 4 },
    );
    expect(withIt.short_text_end_turns).toBe(2);
    expect(withIt.end_turn_n).toBe(4);
    const without = buildSessionIndexEntry({ session_id: "s" }, { ts: 1 });
    expect("short_text_end_turns" in without).toBe(false);
    expect("end_turn_n" in without).toBe(false);
  });
});
