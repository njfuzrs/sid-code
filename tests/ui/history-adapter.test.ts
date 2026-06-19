/**
 * history-adapter 单元测试
 *
 * 验证 LLM Message → HistoryItem 的转换逻辑
 */

import { describe, test, expect } from "bun:test";
import {
  messagesToHistoryItems,
  messagesToHistoryItemsWithMap,
  buildToolNameMapFromMessages,
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

describe("buildToolNameMapFromMessages", () => {
  test("从消息中构建 toolNameMap", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "Read", input: {} },
          { type: "tool_use", id: "c2", name: "Bash", input: {} },
        ],
      },
    ];
    const map = buildToolNameMapFromMessages(msgs);
    expect(map.get("c1")).toBe("Read");
    expect(map.get("c2")).toBe("Bash");
  });
});

describe("messagesToHistoryItemsWithMap - user 消息", () => {
  test("纯文本用户消息 → HistoryItemUser", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "帮我写个函数" }],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("user");
    if (items[0].type === "user") {
      expect(items[0].text).toBe("帮我写个函数");
    }
  });

  test("占位消息被过滤", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[系统] 自动插入占位消息以保持角色交替" }],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(0);
  });

  test("tool_result 与 pending tool_use 合并", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/test.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "文件内容..." },
        ],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    // 合并后只有一个 tool_group（不再是两个）
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool_group");
    if (items[0].type === "tool_group") {
      expect(items[0].tools).toHaveLength(1);
      expect(items[0].tools[0].name).toBe("Read");
      expect(items[0].tools[0].status).toBe(ToolCallStatus.Success);
    }
  });

  test("错误的 tool_result → status=Error", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_2", content: "command not found", is_error: true },
        ],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_group") {
      expect(items[0].tools[0].status).toBe(ToolCallStatus.Error);
      expect(items[0].tools[0].resultDisplay?.isError).toBe(true);
    }
  });

  test("文本 + tool_result 混合 → 两个 HistoryItem", () => {
    const toolNameMap = new Map([["call_3", "Glob"]]);
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "用户输入" },
          { type: "tool_result", tool_use_id: "call_3", content: "file1.ts\nfile2.ts" },
        ],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, toolNameMap);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("user");
    expect(items[1].type).toBe("tool_group");
  });
});

describe("messagesToHistoryItemsWithMap - assistant 消息", () => {
  test("纯文本助手消息 → HistoryItemAssistant", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "好的，我来帮你实现。" }],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("assistant");
    if (items[0].type === "assistant") {
      expect(items[0].text).toBe("好的，我来帮你实现。");
    }
  });

  test("tool_use 暂存为 pending（无 tool_result 时输出为 Executing）", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_4", name: "Read", input: { file_path: "/tmp/test.ts" } },
        ],
      },
    ];
    // 没有后续 tool_result，pending 会在末尾输出
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool_group");
    if (items[0].type === "tool_group") {
      expect(items[0].tools).toHaveLength(1);
      expect(items[0].tools[0].name).toBe("Read");
      expect(items[0].tools[0].status).toBe(ToolCallStatus.Executing);
      expect(items[0].tools[0].description).toBe("/tmp/test.ts");
    }
  });

  test("文本 + tool_use 混合 → 文本在前，工具 pending", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "让我先读取文件。" },
          { type: "tool_use", id: "call_5", name: "Read", input: { file_path: "/tmp/a.ts" } },
        ],
      },
    ];
    // 没有 tool_result，pending 在末尾输出
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("assistant");
    expect(items[1].type).toBe("tool_group");
  });

  test("多个 tool_use 无 result → 合并到一个 pending ToolGroup", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.ts" } },
          { type: "tool_use", id: "c2", name: "Read", input: { file_path: "b.ts" } },
        ],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_group") {
      expect(items[0].tools).toHaveLength(2);
    }
  });

  // P2-1 回归守卫：多工具并行执行时（tool_start 时刻 ctxMgr 已含 assistant+tool_use、
  // 尚无 tool_result），两个工具都必须渲染成 Executing 占位行 —— 这正是「逐个 executing
  // 中间态」可见的数据基础。曾被误判为「pending 工具不进消息流、看不到哪个在跑」，
  // 实则 messagesToHistoryItems 的 leftover-pending flush 已把它们输出为 executing group。
  test("P2-1：多工具并行 pending → 全部渲染为 Executing 中间态（不卡 toolName 单值/spinner）", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "并行读取两个文件" },
          { type: "tool_use", id: "p1", name: "Read", input: { file_path: "a.ts" } },
          { type: "tool_use", id: "p2", name: "Bash", input: { command: "ls" } },
        ],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    // assistant 文本 + 一个含两条 executing 工具的 tool_group
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("assistant");
    expect(items[1].type).toBe("tool_group");
    if (items[1].type === "tool_group") {
      expect(items[1].tools).toHaveLength(2);
      expect(items[1].tools.every(t => t.status === ToolCallStatus.Executing)).toBe(true);
      expect(items[1].tools.map(t => t.name)).toEqual(["Read", "Bash"]);
    }
  });

  test("文本 → tool_use → 文本（无 result）→ 产出 3 个 HistoryItem", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "先读取" },
          { type: "tool_use", id: "c3", name: "Read", input: {} },
          { type: "text", text: "读取完成" },
        ],
      },
    ];
    // tool_use 暂存为 pending，但后面有文本，pending 在末尾输出
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    // assistant(先读取) + assistant(读取完成) + tool_group(pending)
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("assistant");
    expect(items[1].type).toBe("assistant");
    expect(items[2].type).toBe("tool_group");
  });

  // SP1：思考耗时持久化
  test("thinking 块带 durationMs → thought.durationSeconds（向下取整秒）", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "让我想想这个问题", durationMs: 3500 },
          { type: "text", text: "答案是 42。" },
        ],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("thinking");
    if (items[0].type === "thinking") {
      expect(items[0].thought.text).toBe("让我想想这个问题");
      // 3500ms → 3s
      expect(items[0].thought.durationSeconds).toBe(3);
    }
  });

  test("thinking 块无 durationMs → thought.durationSeconds 缺省（旧数据兼容）", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "无耗时的旧思考块" }],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("thinking");
    if (items[0].type === "thinking") {
      expect(items[0].thought.text).toBe("无耗时的旧思考块");
      expect(items[0].thought.durationSeconds).toBeUndefined();
    }
  });

  test("thinking durationMs 不足 1 秒 → durationSeconds 为 0", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "瞬间的念头", durationMs: 800 }],
      },
    ];
    const items = messagesToHistoryItemsWithMap(msgs, new Map());
    expect(items[0].type).toBe("thinking");
    if (items[0].type === "thinking") {
      expect(items[0].thought.durationSeconds).toBe(0);
    }
  });
});

describe("messagesToHistoryItems - 完整对话（合并模式）", () => {
  test("user → assistant(tool_use) → user(tool_result) → 合并为单条", () => {
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
    // user(text) + assistant(text) + tool_group(合并后 Success)
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("user");
    expect(items[1].type).toBe("assistant");
    expect(items[2].type).toBe("tool_group");

    // 合并后的 tool_group 直接是 Success
    if (items[2].type === "tool_group") {
      expect(items[2].tools[0].status).toBe(ToolCallStatus.Success);
      expect(items[2].tools[0].name).toBe("Read");
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

  test("增量同步时使用外部 toolNameMap 避免 unknown", () => {
    // 模拟增量同步：只传入 tool_result 消息，但有外部 toolNameMap
    const toolNameMap = new Map([["c20", "Read"]]);
    const newMsgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c20", content: "文件内容" },
        ],
      },
    ];
    const items = messagesToHistoryItemsWithMap(newMsgs, toolNameMap);
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_group") {
      expect(items[0].tools[0].name).toBe("Read"); // 不是 "unknown"
    }
  });
});
