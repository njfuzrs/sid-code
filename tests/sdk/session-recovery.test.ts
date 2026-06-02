/**
 * Phase 3 单测：会话中断检测与恢复
 */

import { describe, test, expect } from "bun:test";
import { deserializeMessagesWithInterruptDetection } from "../../src/sdk/session-recovery.ts";
import type { Message } from "../../src/llm/types.ts";

describe("deserializeMessagesWithInterruptDetection", () => {
  test("空历史", () => {
    const r = deserializeMessagesWithInterruptDetection([]);
    expect(r.messages).toEqual([]);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  test("过滤未解析的 tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
      // 注意：没有 t1 的 tool_result
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const assistant = r.messages.find((m) => m.role === "assistant")!;
    // tool_use 被过滤，只剩 text
    expect(assistant.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("保留已解析的 tool_use", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    const assistant = r.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content.some((b) => b.type === "tool_use")).toBe(true);
    expect(r.turnInterruptionState.kind).toBe("none");
  });

  test("过滤空白助手消息（全部 tool_use 未解析）", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    // 末尾用户消息也被识别为中断；助手消息因清空被丢弃
    expect(r.messages.every((m) => m.role !== "assistant")).toBe(true);
  });

  test("末尾纯用户输入 → interrupted_prompt", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2 中断了" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("interrupted_prompt");
    if (r.turnInterruptionState.kind === "interrupted_prompt") {
      expect(r.turnInterruptionState.message.content).toEqual([
        { type: "text", text: "q2 中断了" },
      ]);
    }
    // 中断的用户消息从 messages 中移除（交由 turnInterruptionState 持有）
    expect(r.messages.length).toBe(2);
  });

  test("末尾用户消息含 tool_result → 不算中断", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(r.turnInterruptionState.kind).toBe("none");
  });
});
