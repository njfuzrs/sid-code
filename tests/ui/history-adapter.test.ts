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
  isResumeMarkerMessage,
  isHiddenFromDisplay,
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

describe("内部消息隐藏（仅供 LLM、不展示给用户）", () => {
  const mkUser = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

  test("续接标记消息被识别并隐藏", () => {
    const msg = mkUser(
      "<system-reminder>\n本次会话是从之前的对话恢复的续接会话（上方消息为之前的历史上下文）。\n</system-reminder>",
    );
    expect(isResumeMarkerMessage(msg)).toBe(true);
    expect(isHiddenFromDisplay(msg)).toBe(true);
  });

  test("system-reminder 包裹的内部提示整条隐藏（todo gate / 空参数重试等）", () => {
    expect(isHiddenFromDisplay(mkUser("<system-reminder>\n检测到你试图结束本轮对话，但任务清单中仍有 1 项未完成\n</system-reminder>"))).toBe(true);
    expect(isHiddenFromDisplay(mkUser("<system-reminder>\n检测到工具调用的参数为空\n</system-reminder>"))).toBe(true);
  });

  test("压缩边界 / GC 释放标记整条隐藏", () => {
    expect(isHiddenFromDisplay(mkUser("[压缩边界] 这是摘要"))).toBe(true);
    expect(isHiddenFromDisplay(mkUser("[已释放] user 消息内容已被 GC 回收，详情见 compact_boundary"))).toBe(true);
  });

  test("真实用户/助手消息不被隐藏", () => {
    expect(isHiddenFromDisplay(mkUser("帮我修个 bug"))).toBe(false);
    expect(isHiddenFromDisplay({ role: "assistant", content: [{ type: "text", text: "好的" }] })).toBe(false);
  });

  test("正文里偶然含 [压缩边界] 字样但非开头，不误判", () => {
    expect(isHiddenFromDisplay(mkUser("请解释一下 [压缩边界] 这个概念"))).toBe(false);
  });

  test("混合内容消息（tool_result + 内部提示）不整条隐藏，仅剥离内部文本块", () => {
    const loopMsg: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "占位结果" },
        { type: "text", text: "系统检测到你陷入了非生产性循环——连续多次以等价参数调用同一工具但未取得进展。" },
      ],
    };
    // 注意:循环恢复提示文本不以 <system-reminder>/[压缩边界]/[已释放] 开头,故不被 isInternalOnlyText 命中,
    // 这里仅验证"含 tool_result 的消息不会被整条隐藏"这一关键不变量。
    expect(isHiddenFromDisplay(loopMsg)).toBe(false);
    const items = messagesToHistoryItems([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      loopMsg,
    ]);
    // tool_result 仍正常合并为 tool_group 展示
    expect(items.some((i) => i.type === "tool_group")).toBe(true);
  });

  test("messagesToHistoryItems 跳过纯内部消息", () => {
    const items = messagesToHistoryItems([
      mkUser("帮我看下这个函数"),
      mkUser("<system-reminder>\n检测到你试图结束本轮对话\n</system-reminder>"),
      mkUser("[压缩边界] 摘要"),
    ]);
    const userItems = items.filter((i) => i.type === "user");
    expect(userItems.length).toBe(1);
    expect((userItems[0] as { text: string }).text).toBe("帮我看下这个函数");
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

describe("后台任务通知（<task-notification>）→ task_notification 历史项", () => {
  const buildNotification = (opts: {
    taskId: string;
    status: string;
    summary: string;
    result?: string;
    error?: string;
    outputFile?: string;
  }): string => {
    const lines = [
      "<task-notification>",
      `  <task-id>${opts.taskId}</task-id>`,
    ];
    if (opts.outputFile) lines.push(`  <output-file>${opts.outputFile}</output-file>`);
    lines.push(`  <status>${opts.status}</status>`, `  <summary>${opts.summary}</summary>`);
    if (opts.result !== undefined) lines.push(`  <result untrusted="true">${opts.result}</result>`);
    if (opts.error !== undefined) lines.push(`  <error>${opts.error}</error>`);
    lines.push("</task-notification>");
    return lines.join("\n");
  };

  test("completed 通知 → task_notification 项，解析 summary/status/result/outputFile", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{
          type: "text",
          text: buildNotification({
            taskId: "axcpyv1qa",
            status: "completed",
            summary: 'Agent "核查 oauth.ts" 执行完成',
            result: "核查结论：全部 12 项均已落地。",
            outputFile: "/tmp/axcpyv1qa.output",
          }),
        }],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("task_notification");
    if (items[0].type === "task_notification") {
      expect(items[0].taskId).toBe("axcpyv1qa");
      expect(items[0].status).toBe("completed");
      expect(items[0].summary).toBe('Agent "核查 oauth.ts" 执行完成');
      expect(items[0].result).toBe("核查结论：全部 12 项均已落地。");
      expect(items[0].outputFile).toBe("/tmp/axcpyv1qa.output");
    }
  });

  test("不再走 UserMessage 全量渲染（关键：解决折叠不统一）", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{
          type: "text",
          text: buildNotification({ taskId: "t1", status: "completed", summary: "完成", result: "x" }),
        }],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    // 不应产出 user 项（否则会走 UserMessage 全量渲染、不折叠）
    expect(items.every(i => i.type !== "user")).toBe(true);
    expect(items[0].type).toBe("task_notification");
  });

  test("failed 通知 → 取 <error> 作为 result，status=failed", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{
          type: "text",
          text: buildNotification({
            taskId: "t2",
            status: "failed",
            summary: 'Agent "X" 执行失败',
            error: "连接超时",
          }),
        }],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    expect(items).toHaveLength(1);
    if (items[0].type === "task_notification") {
      expect(items[0].status).toBe("failed");
      expect(items[0].result).toBe("连接超时");
    }
  });

  test("缺省正文（killed 无 result/error）→ result 为 undefined，仅显示摘要", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{
          type: "text",
          text: buildNotification({ taskId: "t3", status: "killed", summary: 'Agent "X" 已被终止' }),
        }],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    expect(items).toHaveLength(1);
    if (items[0].type === "task_notification") {
      expect(items[0].status).toBe("killed");
      expect(items[0].result).toBeUndefined();
    }
  });

  test("批量后台任务同轮完成（多个连续通知块）→ 每块一个项", () => {
    const text = [
      buildNotification({ taskId: "t1", status: "completed", summary: "S1", result: "R1" }),
      buildNotification({ taskId: "t2", status: "completed", summary: "S2", result: "R2" }),
    ].join("\n");
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text }] }];
    const items = messagesToHistoryItems(msgs);
    expect(items).toHaveLength(2);
    expect(items.every(i => i.type === "task_notification")).toBe(true);
    if (items[0].type === "task_notification" && items[1].type === "task_notification") {
      expect(items[0].taskId).toBe("t1");
      expect(items[1].taskId).toBe("t2");
    }
  });

  test("含换行/表格的多行 result 被完整保留（不截断）", () => {
    const longResult = "结论：\n| # | 条目 | 结论 |\n|---|------|------|\n| 1 | A | ✅ |\n| 2 | B | ✅ |";
    const msgs: Message[] = [
      {
        role: "user",
        content: [{
          type: "text",
          text: buildNotification({ taskId: "t4", status: "completed", summary: "完成", result: longResult }),
        }],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    if (items[0].type === "task_notification") {
      expect(items[0].result).toBe(longResult);
    }
  });

  test("真实用户消息不被误判为通知", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "帮我看看 <task-notification> 这个标签怎么用" }] },
    ];
    const items = messagesToHistoryItems(msgs);
    // 以普通文本开头（非 <task-notification> 起始），应走 user 项
    expect(items[0].type).toBe("user");
  });
});
