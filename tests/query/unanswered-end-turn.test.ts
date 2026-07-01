/**
 * 「未答复的 end_turn」识别回归测试（方案①/②，deepseek-reasoning-leak 修复）
 *
 * 覆盖三例（例① 英文单发 / 例② 中文连环 / 例③ 重试无反应）同一根因的两种下游形态：
 *   形态 A：思考漂移进 content 通道（text 块）——end_turn + 无 tool_use + 原始usage=0 + text 超长。
 *   形态 B：只思考不答复（唯一 thinking 块，content 通道空）。
 *
 * 直接测纯函数 detectUnansweredEndTurn，避免依赖完整 SSE 流构造。
 */

import { test, expect, describe } from "bun:test";
import { detectUnansweredEndTurn } from "../../src/query/unanswered-end-turn.ts";
import type { AccumulatedResponse } from "../../src/llm/types.ts";

function mkResp(partial: Partial<AccumulatedResponse>): AccumulatedResponse {
  return {
    role: "assistant",
    content: [],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial,
  };
}

describe("detectUnansweredEndTurn — 形态 A：思考漂移进 content 通道", () => {
  test("end_turn + 无tool_use + 原始usage=0 + 超长 text → 转折叠思考块并标记未答复", () => {
    const drift = "Let me analyze... Wait... Hmm... ".repeat(200); // 数千字符独白
    const resp = mkResp({
      content: [{ type: "text", text: drift }],
      stopReason: "end_turn",
    });
    detectUnansweredEndTurn(resp, /* rawOutputTokensZero */ true);

    expect(resp._unansweredEndTurn).toBe(true);
    // text 块已原地转型为 thinking 块（默认折叠，不当正文刷屏）
    expect(resp.content.every((b) => b.type === "thinking")).toBe(true);
    expect(resp.content.find((b) => b.type === "text")).toBeUndefined();
  });

  test("中文思考同样命中（不依赖英文特征词）", () => {
    const zhDrift = "现在我理解了整个架构。用户的需求是……".repeat(200);
    const resp = mkResp({ content: [{ type: "text", text: zhDrift }] });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBe(true);
    expect(resp.content[0]!.type).toBe("thinking");
  });

  test("usage 原始非 0（正常答复）→ 不误判，即使 text 很长", () => {
    const longAnswer = "这是一段很长但正常的答复。".repeat(300);
    const resp = mkResp({ content: [{ type: "text", text: longAnswer }] });
    detectUnansweredEndTurn(resp, /* rawOutputTokensZero */ false);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content[0]!.type).toBe("text"); // 保持正文
  });

  test("短 text（< 阈值）+ 原始usage=0 → 不误判为思考漂移", () => {
    const resp = mkResp({ content: [{ type: "text", text: "好的，已完成。" }] });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content[0]!.type).toBe("text");
  });

  test("有 tool_use → 正常推进，不判未答复", () => {
    const drift = "Let me think... ".repeat(300);
    const resp = mkResp({
      content: [
        { type: "text", text: drift },
        { type: "tool_use", id: "c1", name: "read", input: {} },
      ],
    });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content.find((b) => b.type === "tool_use")).toBeDefined();
  });

  test("stop_reason 非 end_turn/stop（如 max_tokens）→ 不触发", () => {
    const drift = "推演推演推演".repeat(500);
    const resp = mkResp({
      content: [{ type: "text", text: drift }],
      stopReason: "max_tokens",
    });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content[0]!.type).toBe("text");
  });
});

describe("detectUnansweredEndTurn — 形态 B：只思考不答复", () => {
  test("唯一长思考块（970 字，> 旧 500 上限）→ 保持折叠并标记未答复（例② 第56轮）", () => {
    const think = "思".repeat(970);
    const resp = mkResp({ content: [{ type: "thinking", thinking: think }] });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
    expect(resp.content[0]!.type).toBe("thinking"); // 保持折叠，不转正文
  });

  test("极短思考（≤500）→ 原地转型为正文让用户看到，不标记未答复", () => {
    const resp = mkResp({
      content: [{ type: "thinking", thinking: "你好，有什么可以帮你？" }],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content[0]!.type).toBe("text");
    if (resp.content[0]!.type === "text") {
      expect(resp.content[0]!.text).toBe("你好，有什么可以帮你？");
    }
  });

  test("思考 + 正文都有 → 正常答复，不触发", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: "思考".repeat(600) },
        { type: "text", text: "这是正式答复" },
      ],
    });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredEndTurn).toBeUndefined();
  });
});
