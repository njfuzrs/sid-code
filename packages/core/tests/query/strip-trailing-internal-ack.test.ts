import { describe, it, expect } from "bun:test";
import { stripTrailingInternalAck } from "@sid-code/core/query/loop.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const u: Message = { role: "user", content: [{ type: "text", text: "q" }] };

describe("S5 发请求前剥离末尾内部 ack（避免 Anthropic 族当预填发出）", () => {
  it("末尾是带内部 origin 的 assistant → 剥掉", () => {
    const ack: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的" }],
      _meta: { origin: "compact-reattach" },
    };
    expect(stripTrailingInternalAck([u, ack])).toEqual([u]);
  });
  it("末尾是真实 assistant / user → 原样", () => {
    const a: Message = { role: "assistant", content: [{ type: "text", text: "答" }] };
    expect(stripTrailingInternalAck([u, a])).toHaveLength(2);
    expect(stripTrailingInternalAck([u])).toHaveLength(1);
  });
});
