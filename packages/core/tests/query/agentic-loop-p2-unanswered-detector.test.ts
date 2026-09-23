/**
 * P2-1 回归：unanswered 检测器的三处漏杀。
 *
 * 缺陷文档《20260920-AgenticLoop主循环审查》十、P2-1。形态 B 此前有一条硬条件
 * `totalTextLen === 0 && thinkingCount === 1`，另外判据里 isEndTurnLike 少了
 * `stop_sequence`（loop.ts 的白名单含它）。三种「空手 end_turn」因此被漏杀：
 *   ① thinkingCount >= 2（多段思考后直接收尾）
 *   ② thinkingCount === 0 且无 text 无 tool（空 content / 只有 redacted_thinking）
 *   ③ stop_sequence + 空答复（走完整收尾链，但 _unansweredEndTurn 永不置位）
 *
 * 用户可见形态一致：一个空白气泡被当成正常完成，重试链完全不启动。
 */

import { test, expect, describe } from "bun:test";
import {
  detectUnansweredEndTurn,
  SHORT_ANSWER_LEN,
} from "@sid-code/core/query/unanswered-end-turn.ts";
import { isEndTurnLikeStopReason } from "@sid-code/core/agent/message-invariants.ts";
import type { AccumulatedResponse } from "@sid-code/core/llm/types.ts";

function mkResp(partial: Partial<AccumulatedResponse>): AccumulatedResponse {
  return {
    role: "assistant",
    content: [],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial,
  };
}

describe("P2-1 · 多段 thinking 后空手 end_turn", () => {
  test("thinkingCount === 2 且无 text/tool → 判未答复（旧硬条件 ===1 会整条漏掉）", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: "先看看架构".repeat(200) },
        { type: "thinking", thinking: "再想想边界".repeat(200) },
      ],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
    // 多块时不转正文（转哪一块都是猜），保持折叠
    expect(resp.content.every((b) => b.type === "thinking")).toBe(true);
  });

  test("多段 thinking 但**有**正文 → 正常答复，不误伤", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: "思考一" },
        { type: "thinking", thinking: "思考二" },
        { type: "text", text: "这是给用户的答复" },
      ],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBeUndefined();
  });

  test("多段 thinking 都很短、但仍无正文 → 依然判未答复（短≠已答复）", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: "嗯" },
        { type: "thinking", thinking: "好" },
      ],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
  });
});

describe("P2-1 · 零 thinking 的空手 end_turn", () => {
  test("content 完全为空 → 判未答复（形态 A 要求超长 text，两形态此前同时漏）", () => {
    const resp = mkResp({ content: [] });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBe(true);
  });

  test("只有 redacted_thinking（无 text/thinking/tool）→ 判未答复", () => {
    const resp = mkResp({
      content: [{ type: "redacted_thinking", data: "encrypted-blob" } as never],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
  });

  test("有 tool_use → 正常推进，任何情况下都不判未答复", () => {
    const resp = mkResp({
      content: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "/a" } }],
    });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBeUndefined();
  });
});

describe("P2-1 · 判据与 loop.ts 共用同一个 isEndTurnLike", () => {
  test("stop_sequence + 空答复 → 判未答复（此前检测器不认 stop_sequence）", () => {
    const resp = mkResp({
      stopReason: "stop_sequence",
      content: [{ type: "thinking", thinking: "思".repeat(900) }],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
  });

  test("stop_sequence + 极短 thinking → 与 end_turn 同样转正文，两条 stopReason 行为一致", () => {
    const short = "好了，改完了。";
    expect(short.length).toBeLessThanOrEqual(SHORT_ANSWER_LEN);
    const resp = mkResp({
      stopReason: "stop_sequence",
      content: [{ type: "thinking", thinking: short }],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content[0]!.type).toBe("text");
  });

  test("反漂移：检测器认的 stopReason 集合 = isEndTurnLikeStopReason 的集合", () => {
    // 这条锁的是「两处不再各抄一份」。任一处收窄/放宽，这里立刻红。
    for (const sr of ["end_turn", "stop", "stop_sequence"]) {
      expect(isEndTurnLikeStopReason(sr)).toBe(true);
      const resp = mkResp({ stopReason: sr, content: [] });
      detectUnansweredEndTurn(resp, false);
      expect(resp._unansweredEndTurn).toBe(true);
    }
    for (const sr of ["tool_use", "max_tokens", "length", "content_filter", "pause_turn", null]) {
      expect(isEndTurnLikeStopReason(sr)).toBe(false);
      const resp = mkResp({ stopReason: sr, content: [] });
      detectUnansweredEndTurn(resp, false);
      expect(resp._unansweredEndTurn).toBeUndefined();
    }
  });
});
