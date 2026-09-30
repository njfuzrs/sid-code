/**
 * N11 门禁：恢复期清洗管道必须切除「游离 tool_result」（有结果无调用）。
 *
 * 以前 6 层只修孤儿 tool_use 这一个方向，游离 tool_result 穿过管道，
 * 首屏先渲染、第一次发送时才被 finalizeMessagesForSend 切掉（日志还归到发送期）。
 * 断言：管道输出本身就满足 checkMessageHistoryIntegrity，且发送期兜底网不再需要动手。
 */

import { describe, test, expect } from "bun:test";
import { deserializeMessagesWithInterruptDetection } from "@sid-code/core/sdk/session-recovery.ts";
import {
  checkMessageHistoryIntegrity,
  finalizeMessagesForSend,
  stripDanglingToolResults,
} from "@sid-code/core/agent/message-invariants.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

describe("N11：恢复管道切除游离 tool_result", () => {
  test("assistant 那条没落盘、工具结果落盘了 ⇒ 管道后已完整，发送期兜底 stripped=0", () => {
    // 文档 N11.3 的形态：[user, assistant, user(tool_result 指向不存在的 tool_use)]
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "跑一下测试" }] },
      { role: "assistant", content: [{ type: "text", text: "好的" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "lost", content: "ok" }] },
    ];
    expect(checkMessageHistoryIntegrity(messages).dangling.length).toBe(1);

    const r = deserializeMessagesWithInterruptDetection(messages);
    const integrity = checkMessageHistoryIntegrity(r.messages);
    expect(integrity.dangling).toEqual([]);
    expect(integrity.intact).toBe(true);
    // 游离那条消息被剥空整条删除 ⇒ 末尾是 assistant，判为正常结束
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.turnInterruptionState.kind).toBe("none");

    const sent = finalizeMessagesForSend(r.messages);
    expect(sent.stripped).toEqual([]);
    expect(sent.changed).toBe(false);
  });

  test("同一条 user 消息里混有正常 tool_result 与游离 tool_result ⇒ 只剥游离，正常的保留", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a" },
          { type: "tool_result", tool_use_id: "ghost", content: "b" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    const results = r.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => (b as any).tool_use_id),
    );
    expect(results).toEqual(["t1"]);
    // tool_use t1 仍在（第 3 层没误删，第 7 层没误伤）
    expect(r.messages[1]!.content[0]!.type).toBe("tool_use");
  });

  test("前面层删掉 tool_use 所在消息后产生的新游离，也在第 7 层被切掉（顺序在最后）", () => {
    // 第 6 层会整条丢掉缺 name 的 tool_use 所在消息 ⇒ 它的 tool_result 变成游离
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "end" }] },
    ];
    const r = deserializeMessagesWithInterruptDetection(messages);
    expect(checkMessageHistoryIntegrity(r.messages).intact).toBe(true);
    expect(r.messages.some((m) => m.content.some((b) => b.type === "tool_result"))).toBe(false);
  });

  test("stripDanglingToolResults：无游离时原样返回入参引用（不白拷贝）", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] },
    ];
    const r = stripDanglingToolResults(messages);
    expect(r.messages).toBe(messages);
    expect(r.stripped).toEqual([]);
  });
});
