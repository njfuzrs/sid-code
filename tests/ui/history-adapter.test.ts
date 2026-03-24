/**
 * history-adapter 单元测试
 *
 * 验证 LLM Message → HistoryItem 的转换逻辑
 */

import { describe, test, expect } from "bun:test";
import {
  messageToHistoryItems,
  messagesToHistoryItems,
  isPlaceholderMessage,
} from "../../src/ui/history-adapter.ts";
import type { Message } from "../../src/llm/types.ts";
import { ToolCallStatus } from "../../src/ui/types.ts";

describe("isPlaceholderMessage", () => {
  test("识别占位消息", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "[系统] 自动插入占位消息以保持角色交替" }],
    };
    expect(isPlaceholderMessage(msg)).toBe(true);
  });

  test("非占位消息返回 false", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "你好" }],
    };
    expect(isPlaceholderMessage(msg)).toBe(false);
  });

  test("多内容块不是占位消息", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "[系统] 自动插入占位消息以保持角色交替" },
        { type: "text", text: "额外内容" },
      ],
    };
    expect(isPlaceholderMessage(msg)).toBe(false);
  });
});

describe("messageToHistoryItems - user 消息", () => {
  test("纯文本用户消息 → HistoryItemUser", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "帮我写个函数" }],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("user");
    if (items[0].type === "user") {
      expect(items[0].text).toBe("帮我写个函数");
    }
  });

  test("占位消息被过滤", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "[系统] 自动插入占位消息以保持角色交替" }],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(0);
  });

  test("tool_result → HistoryItemToolGroup", () => {
    const toolNameMap = new Map([["call_1", "Read"]]);
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "文件内容...",
        },
      ],
    };
    const items = messageToHistoryItems(msg, toolNameMap);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool_group");
    if (items[0].type === "tool_group") {
      expect(items[0].tools).toHaveLength(1);
      expect(items[0].tools[0].name).toBe("Read");
      expect(items[0].tools[0].status).toBe(ToolCallStatus.Success);
    }
  });

  test("错误的 tool_result → status=Error", () => {
    const toolNameMap = new Map([["call_2", "Bash"]]);
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: "command not found",
          is_error: true,
        },
      ],
    };
    const items = messageToHistoryItems(msg, toolNameMap);
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_group") {
      expect(items[0].tools[0].status).toBe(ToolCallStatus.Error);
      expect(items[0].tools[0].resultDisplay?.isError).toBe(true);
    }
  });

  test("文本 + tool_result 混合 → 两个 HistoryItem", () => {
    const toolNameMap = new Map([["call_3", "Glob"]]);
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "用户输入" },
        {
          type: "tool_result",
          tool_use_id: "call_3",
          content: "file1.ts\nfile2.ts",
        },
      ],
    };
    const items = messageToHistoryItems(msg, toolNameMap);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("user");
    expect(items[1].type).toBe("tool_group");
  });
});

describe("messageToHistoryItems - assistant 消息", () => {
  test("纯文本助手消息 → HistoryItemAssistant", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的，我来帮你实现。" }],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("assistant");
    if (items[0].type === "assistant") {
      expect(items[0].text).toBe("好的，我来帮你实现。");
    }
  });

  test("tool_use → HistoryItemToolGroup (status=Executing)", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_4",
          name: "Read",
          input: { file_path: "/tmp/test.ts" },
        },
      ],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool_group");
    if (items[0].type === "tool_group") {
      expect(items[0].tools).toHaveLength(1);
      expect(items[0].tools[0].name).toBe("Read");
      expect(items[0].tools[0].status).toBe(ToolCallStatus.Executing);
      expect(items[0].tools[0].description).toBe("/tmp/test.ts");
    }
  });

  test("文本 + tool_use 混合 → 文本在前，工具在后", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "让我先读取文件。" },
        {
          type: "tool_use",
          id: "call_5",
          name: "Read",
          input: { file_path: "/tmp/a.ts" },
        },
      ],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("assistant");
    expect(items[1].type).toBe("tool_group");
  });

  test("多个 tool_use → 合并到一个 ToolGroup", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "c2", name: "Read", input: { file_path: "b.ts" } },
      ],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_group") {
      expect(items[0].tools).toHaveLength(2);
    }
  });

  test("文本 → tool_use → 文本 → 产出 3 个 HistoryItem", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "先读取" },
        { type: "tool_use", id: "c3", name: "Read", input: {} },
        { type: "text", text: "读取完成" },
      ],
    };
    const items = messageToHistoryItems(msg, new Map());
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("assistant");
    expect(items[1].type).toBe("tool_group");
    expect(items[2].type).toBe("assistant");
  });
});

describe("messagesToHistoryItems - 完整对话", () => {
  test("user → assistant → user(tool_result) 完整流程", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "读取 test.ts" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_use", id: "c10", name: "Read", input: { file_path: "test.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c10", content: "const x = 1;" },
        ],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    // user(text) + assistant(text) + tool_group(executing) + tool_group(success)
    expect(items).toHaveLength(4);
    expect(items[0].type).toBe("user");
    expect(items[1].type).toBe("assistant");
    expect(items[2].type).toBe("tool_group");
    expect(items[3].type).toBe("tool_group");

    // 第一个 tool_group 来自 assistant 的 tool_use（Executing）
    if (items[2].type === "tool_group") {
      expect(items[2].tools[0].status).toBe(ToolCallStatus.Executing);
    }
    // 第二个 tool_group 来自 user 的 tool_result（Success）
    if (items[3].type === "tool_group") {
      expect(items[3].tools[0].status).toBe(ToolCallStatus.Success);
      expect(items[3].tools[0].name).toBe("Read");
    }
  });

  test("占位消息被过滤", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[系统] 自动插入占位消息以保持角色交替" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "回复" }],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("assistant");
  });

  test("空消息数组 → 空结果", () => {
    const items = messagesToHistoryItems([]);
    expect(items).toHaveLength(0);
  });
});
