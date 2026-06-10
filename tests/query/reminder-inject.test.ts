/**
 * System-reminder 注入单测（query/reminder-inject.ts）
 *
 * 重点回归：plan mode 连续工具调用场景——最后一条 user 消息只含 tool_result、
 * 无 text block 时，必须**追加** text block 注入 reminder，而不是放弃。
 * 这是修复"工具探索轮漏注入 reminder"回归的核心保障。
 */

import { describe, test, expect } from "bun:test";
import { injectReminders } from "../../src/query/reminder-inject.ts";
import type { Message } from "../../src/llm/types.ts";

const REMINDER = "<system-reminder>[计划模式] 只允许只读操作。</system-reminder>";

describe("injectReminders — 基础行为", () => {
  test("reminderParts 为空时原样返回（同引用）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "你好" }] },
    ];
    const out = injectReminders(msgs, []);
    expect(out).toBe(msgs); // 同引用，零拷贝
  });

  test("user 消息含 text block 时，reminder 前置到 text 开头", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "实现登录功能" }] },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    const textBlock = out[0].content.find((c) => c.type === "text");
    expect(textBlock?.type).toBe("text");
    if (textBlock?.type === "text") {
      expect(textBlock.text.startsWith(REMINDER)).toBe(true);
      expect(textBlock.text).toContain("实现登录功能");
    }
  });

  test("多个 reminderParts 以双换行拼接", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "原文" }] },
    ];
    const out = injectReminders(msgs, ["A 提醒", "B 提醒"]);
    const textBlock = out[0].content.find((c) => c.type === "text");
    if (textBlock?.type === "text") {
      expect(textBlock.text).toBe("A 提醒\n\nB 提醒\n\n原文");
    }
  });
});

describe("injectReminders — 回归：纯 tool_result 轮（无 text block）", () => {
  test("最后一条 user 只含 tool_result 时，追加独立 text block 承载 reminder", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "实现 X" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "文件内容" },
        ],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);

    // 最后一条 user 消息应被注入
    const lastUser = out[2];
    expect(lastUser.role).toBe("user");
    // 原 tool_result 保留
    expect(lastUser.content[0].type).toBe("tool_result");
    // 末尾追加了 text block
    const textBlock = lastUser.content.find((c) => c.type === "text");
    expect(textBlock).toBeDefined();
    if (textBlock?.type === "text") {
      expect(textBlock.text).toBe(REMINDER);
    }
    // text block 在 tool_result 之后（顺序：tool_result, text），OpenAI 转换合法
    expect(lastUser.content[lastUser.content.length - 1].type).toBe("text");
  });

  test("注入目标是最后一条 user 消息，而非靠前的带 text 的 user 消息", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "首条带文本" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "grep", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "结果" }],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);

    // 首条不应被改动
    const first = out[0].content.find((c) => c.type === "text");
    if (first?.type === "text") {
      expect(first.text).toBe("首条带文本");
    }
    // 最后一条 user（tool_result 轮）被注入
    const lastText = out[2].content.find((c) => c.type === "text");
    expect(lastText).toBeDefined();
  });

  test("多个 tool_result block 也只追加一个 text block 到末尾", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r1" },
          { type: "tool_result", tool_use_id: "t2", content: "r2" },
        ],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    const textBlocks = out[0].content.filter((c) => c.type === "text");
    expect(textBlocks.length).toBe(1);
    expect(out[0].content.length).toBe(3); // 2 tool_result + 1 text
  });
});

describe("injectReminders — 不变量", () => {
  test("不修改入参（in-place 安全）", () => {
    const original: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
      },
    ];
    const snapshot = JSON.stringify(original);
    injectReminders(original, [REMINDER]);
    expect(JSON.stringify(original)).toBe(snapshot); // 入参未被改动
  });

  test("无 user 消息时原样返回（不抛错）", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "只有 assistant" }],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    // 无 user 可注入，返回时未崩溃；assistant 文本未被污染
    const text = out[0].content.find((c) => c.type === "text");
    if (text?.type === "text") {
      expect(text.text).toBe("只有 assistant");
    }
  });
});
