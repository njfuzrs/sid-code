/**
 * G22 落地回归测试：partialCompact 边界解析（resolvePartialSplitIndex）
 *
 * partialCompact 已挂进 /compact 命令（带参模式）。此测试守护其核心安全不变量——
 * 边界必须落在干净的 round 边界（user 消息、不含 tool_result、非内部注入），
 * 绝不切碎 tool_use/tool_result 对；无法安全切分时返回 -1（调用方保持历史不变）。
 */

import { describe, test, expect } from "bun:test";
import { resolvePartialSplitIndex } from "../../../src/query/compact/partial-compact.ts";
import type { Message } from "../../../src/llm/types.ts";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function toolResultMsg(id: string): Message {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" } as any] };
}

describe("G22 — resolvePartialSplitIndex 安全边界", () => {
  test("消息太少（<4）返回 -1", () => {
    expect(resolvePartialSplitIndex([userMsg("a"), asstMsg("b")], 0.5)).toBe(-1);
  });

  test("比例模式：0.5 对齐到 <= 期望点的安全 user 边界", () => {
    const msgs = [
      userMsg("q1"), asstMsg("a1"),
      userMsg("q2"), asstMsg("a2"),
      userMsg("q3"), asstMsg("a3"),
    ];
    // 期望 floor(6*0.5)=3，<=3 的最靠后安全边界是下标 2（user q2）
    const idx = resolvePartialSplitIndex(msgs, 0.5);
    expect(idx).toBe(2);
    expect(msgs[idx].role).toBe("user");
  });

  test("绝不落在 tool_result 消息上（避免切碎工具往返）", () => {
    const msgs = [
      userMsg("q1"), asstMsg("call"),
      toolResultMsg("t1"),           // 下标 2：tool_result，不是安全边界
      asstMsg("after-tool"),
      userMsg("q2"), asstMsg("a2"),
    ];
    // 期望点若落在 2，必须回退到下标更小的干净 user 边界（此处无 → 只有下标 0 但需 >=1）
    const idx = resolvePartialSplitIndex(msgs, 3);
    // 下标 3 是 assistant、2 是 tool_result 都不安全；<=3 无安全 user 边界（下标1是assistant）→ -1
    expect(idx).toBe(-1);
  });

  test("下标模式：对齐到 <= 期望下标的安全边界", () => {
    const msgs = [
      userMsg("q1"), asstMsg("a1"),
      userMsg("q2"), asstMsg("a2"),
      userMsg("q3"), asstMsg("a3"),
    ];
    // 期望下标 4（user q3），本身是安全边界
    expect(resolvePartialSplitIndex(msgs, 4)).toBe(4);
  });

  test("不允许把整段压掉：保留段至少留 2 条", () => {
    const msgs = [
      userMsg("q1"), asstMsg("a1"),
      userMsg("q2"), asstMsg("a2"),
    ];
    // 期望下标超出 length-2，会被钳到 length-2=2，对齐到 user 下标 2
    const idx = resolvePartialSplitIndex(msgs, 99);
    expect(idx).toBeLessThanOrEqual(msgs.length - 2);
  });
});
