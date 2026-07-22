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
import type { HistoryItem } from "../../src/ui/types.ts";
import { REATTACH_ORIGIN } from "../../src/query/compact/reattach-markers.ts";
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

  test("压缩注入的摘要/skill/ack 消息对按 _meta.origin 整条隐藏", () => {
    // compactWithSummary 注入的 [对话摘要] user 消息
    expect(isHiddenFromDisplay({
      role: "user",
      content: [{ type: "text", text: "[对话摘要]\n之前聊了很多" }],
      _meta: { origin: "compact-summary" },
    })).toBe(true);
    // 配套的固定 ack assistant 消息(前缀匹配无法覆盖 assistant 侧,必须靠 _meta)
    expect(isHiddenFromDisplay({
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      _meta: { origin: "compact-summary" },
    })).toBe(true);
    // 压缩时重注入的 [已调用 Skill] user 消息
    expect(isHiddenFromDisplay({
      role: "user",
      content: [{ type: "text", text: "[已调用 Skill: code-review]\n..." }],
      _meta: { origin: "compact-summary" },
    })).toBe(true);
  });

  test("恢复会话(有摘要)注入的 buildResumeMessage/ack 消息对按 _meta.origin 整条隐藏", () => {
    // buildResumeMessage 是裸文本(非 system-reminder、不含 RESUME_MARKER_SIGNATURE),
    // 仅靠 _meta.origin 隐藏——回归此前作为 `> ...` 泄漏的缺口。
    expect(isHiddenFromDisplay({
      role: "user",
      content: [{ type: "text", text: "本次会话是从之前的对话中恢复的，之前的对话因上下文窗口限制而中断。" }],
      _meta: { origin: "resume-summary" },
    })).toBe(true);
    expect(isHiddenFromDisplay({
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      _meta: { origin: "resume-summary" },
    })).toBe(true);
  });

  test("无 _meta.origin 的同款 ack 文案不被误隐藏(只认标记,不认文案)", () => {
    // 模型真的说了这句话(无标记)时,不应被隐藏——隐藏只针对带来源标记的内部注入。
    expect(isHiddenFromDisplay({
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
    })).toBe(false);
    // 未知 origin 不命中白名单
    expect(isHiddenFromDisplay({
      role: "user",
      content: [{ type: "text", text: "随便什么" }],
      _meta: { origin: "some-other-origin" },
    })).toBe(false);
  });

  test("压缩后重注入锚点(compact-reattach)整条隐藏——文件正文/Plan/决策/原始任务 + ack", () => {
    // 回归:这四类 reattach 消息都打了 _meta.origin="compact-reattach",但 INTERNAL_ORIGINS
    // 曾漏登记该 origin → 整段文件正文/Plan 正文以 `> [压缩后…]…` 泄漏到屏幕(长任务每次压缩必现)。
    expect(isHiddenFromDisplay({
      role: "user",
      content: [{ type: "text", text: "[压缩后自动恢复] 以下是你压缩前最近访问的 3 个文件的当前内容：\n\n<大段文件正文>" }],
      _meta: { origin: "compact-reattach" },
    })).toBe(true);
    expect(isHiddenFromDisplay({
      role: "assistant",
      content: [{ type: "text", text: "好的，已重新加载最近的文件内容，我会继续之前的工作。" }],
      _meta: { origin: "compact-reattach" },
    })).toBe(true);
  });

  test("snipCompact 裁剪摘要按 _meta.origin 隐藏(文案前缀是防重入承重标识,不能靠它隐藏)", () => {
    // 回归:snipCompact 摘要曾无 _meta.origin,且 [snipCompact] 前缀不在 isInternalOnlyText,
    // → 以 `> [snipCompact] 裁剪了 N 条…` 泄漏。改为打 compact-summary origin 隐藏。
    expect(isHiddenFromDisplay({
      role: "user",
      content: [{ type: "text", text: "[snipCompact] 裁剪了 8 条早期消息：\n[user] 早期消息..." }],
      _meta: { origin: "compact-summary" },
    })).toBe(true);
  });

  test("真实用户/助手消息不被隐藏", () => {
    expect(isHiddenFromDisplay(mkUser("帮我修个 bug"))).toBe(false);
    expect(isHiddenFromDisplay({ role: "assistant", content: [{ type: "text", text: "好的" }] })).toBe(false);
  });

  test("正文里偶然含 [压缩边界] 字样但非开头，不误判", () => {
    expect(isHiddenFromDisplay(mkUser("请解释一下 [压缩边界] 这个概念"))).toBe(false);
  });

  test("防漂移哨兵:产生端 origin 常量必须被隐藏端登记(杜绝'注入打 origin、隐藏漏登记')", () => {
    // 直接引产生端常量,而非硬编码字符串——若有人改了 REATTACH_ORIGIN 值或新增同类 origin
    // 却忘了在 history-adapter 的 INTERNAL_ORIGINS 登记,此断言立即红灯。
    // compact-reattach 泄漏(整段文件正文当 `> …` 显示)正是此类接线遗漏,本哨兵防其复发。
    const mkTagged = (origin: string): Message => ({
      role: "user",
      content: [{ type: "text", text: "任意内部锚点正文" }],
      _meta: { origin },
    });
    expect(isHiddenFromDisplay(mkTagged(REATTACH_ORIGIN))).toBe(true);
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

  // ─── Bug 1 根因回归：notification 与 tool_result 混合消息分离 ───
  // 背景：ctxMgr.addMessage 角色交替合并会把 notification text block 追加到含 tool_result
  // 的 user 消息里，形成 [tool_result, text(<task-notification>)] 混合结构。旧实现要求
  // 消息「只含文本块」，混合后匹配失败 → notification 走 UserMessage 裸 XML 泄漏到 TUI。
  // 修复：tryParseTaskNotifications 放宽匹配，分离出 notifications + remaining。
  test("混合消息 [tool_result, text(notification)] → 分离为 task_notification + tool_group", () => {
    const notif = buildNotification({
      taskId: "algff7z4w",
      status: "completed",
      summary: 'Agent "验证截断保护层次" 执行完成',
      result: "结论：截断保护三层均已落地。",
    });
    const msgs: Message[] = [
      // 先有 tool_use，让后续 tool_result 能合并成 tool_group
      { role: "assistant", content: [{ type: "tool_use", id: "call_x", name: "task_output", input: {} }] },
      // 角色交替合并后的真实形态：tool_result 与 notification 同处一条 user 消息
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_x", content: "task output ..." },
          { type: "text", text: notif },
        ],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    // notification 被分离为专用折叠项（不再裸 XML 泄漏）
    const notifItems = items.filter((i) => i.type === "task_notification");
    expect(notifItems).toHaveLength(1);
    if (notifItems[0].type === "task_notification") {
      expect(notifItems[0].taskId).toBe("algff7z4w");
      expect(notifItems[0].result).toBe("结论：截断保护三层均已落地。");
    }
    // 剩余 tool_result 仍正常合并展示，且绝不产出裸 user 项
    expect(items.some((i) => i.type === "tool_group")).toBe(true);
    expect(items.every((i) => i.type !== "user")).toBe(true);
  });

  test("混合消息中多个 notification block + tool_result 全部分离", () => {
    const text = [
      buildNotification({ taskId: "t1", status: "completed", summary: "S1", result: "R1" }),
      buildNotification({ taskId: "t2", status: "failed", summary: "S2", error: "E2" }),
    ].join("\n");
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "task_output", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "out" },
          { type: "text", text },
        ],
      },
    ];
    const items = messagesToHistoryItems(msgs);
    const notifItems = items.filter((i) => i.type === "task_notification");
    expect(notifItems).toHaveLength(2);
    expect(items.some((i) => i.type === "tool_group")).toBe(true);
  });

  // ─── 中期加固回归：_meta.origin 快速路径 ───
  // queryLoop 注入 notification 时打 _meta.origin="task-notification" 标记，
  // history-adapter 优先走快速路径识别，不依赖内容前缀匹配。
  test("_meta.origin='task-notification' 快速路径识别（即使前面有非通知文本块）", () => {
    const notif = buildNotification({ taskId: "meta1", status: "completed", summary: "完成", result: "R" });
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: notif }],
      _meta: { origin: "task-notification", isMeta: true },
    };
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("task_notification");
    if (items[0].type === "task_notification") {
      expect(items[0].taskId).toBe("meta1");
    }
  });

  // ─── 根治「点4」回归守卫：结构化优先 + 字面量不破坏 ───
  // 核心改造：query/loop.ts 注入时把结构化快照放进 _meta.notif，TUI 优先读它、
  // 不再解析 content 文本。这样子代理结论含 XML 闭合标签字面量也不破坏渲染。
  test("_meta.notif 结构化优先：直接读结构化字段，不解析 content 文本", () => {
    const msg: Message = {
      role: "user",
      // content 故意放一段畸形/不含闭合标签的文本——若还走正则会解析失败，
      // 走结构化则完全无视 content。
      content: [{ type: "text", text: "<task-notification> 残缺没有闭合" }],
      _meta: {
        origin: "task-notification",
        isMeta: true,
        notif: { taskId: "s1", status: "completed", summary: "结构化摘要", result: "结构化结论", outputFile: "/tmp/x.output" },
      },
    };
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("task_notification");
    if (items[0].type === "task_notification") {
      expect(items[0].taskId).toBe("s1");
      expect(items[0].status).toBe("completed");
      expect(items[0].summary).toBe("结构化摘要");
      expect(items[0].result).toBe("结构化结论");
      expect(items[0].outputFile).toBe("/tmp/x.output");
    }
  });

  test("结论含 </result> / </task-notification> 字面量 → 结构化路径完整保留（回归点4）", () => {
    // 子代理核查任务机制本身时，结论里极可能出现这些闭合标签字面量。
    // 旧实现用非贪婪正则 <result...>(.*?)</result> 会在第一个 </result> 处截断 → 内容腰斩。
    // 结构化路径不解析文本，字面量原样保留。
    const nastyResult = "分析 <result> 标签：遇到 </result> 会截断，</task-notification> 也是。完整保留才对。";
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "<task-notification>...</task-notification>" }],
      _meta: {
        origin: "task-notification",
        isMeta: true,
        notif: { taskId: "s2", status: "completed", summary: "核查完成", result: nastyResult, outputFile: "/tmp/y.output" },
      },
    };
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    if (items[0].type === "task_notification") {
      // 完整保留，不在 </result> / </task-notification> 处截断
      expect(items[0].result).toBe(nastyResult);
    }
  });

  test("旧会话 resume 兼容：无 _meta.notif 时回退正则解析 content", () => {
    // 旧持久化的会话消息带 _meta.origin 但没有 _meta.notif 结构化快照，
    // 必须仍能通过正则解析出通知（向后兼容）。
    const notif = buildNotification({ taskId: "legacy1", status: "failed", summary: "旧会话失败", result: "旧结论" });
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: notif }],
      _meta: { origin: "task-notification", isMeta: true }, // 无 notif 字段
    };
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("task_notification");
    if (items[0].type === "task_notification") {
      expect(items[0].taskId).toBe("legacy1");
      expect(items[0].status).toBe("failed");
    }
  });

  // ─── 回归守卫：多通知聚合（防「合并覆盖 _meta.notif 导致前面通知消失」）───
  // query/loop.ts 现把多条通知聚合为一条 user 消息注入：content 每条一个 text 块，
  // _meta.notif 为数组。history-adapter 必须遍历数组渲染出全部，不能只出最后一条。
  test("_meta.notif 数组 → 渲染出全部通知（多个后台任务同时完成）", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "<task-notification>...A...</task-notification>" },
        { type: "text", text: "<task-notification>...B...</task-notification>" },
      ],
      _meta: {
        origin: "task-notification",
        isMeta: true,
        notif: [
          { taskId: "A", status: "completed", summary: "任务A完成", result: "结论A" },
          { taskId: "B", status: "failed", summary: "任务B失败" },
        ],
      },
    };
    const items = messagesToHistoryItems([msg]);
    const notifs = items.filter(i => i.type === "task_notification");
    expect(notifs.length).toBe(2); // 两条都要在,不能只剩最后一条
    if (notifs[0].type === "task_notification" && notifs[1].type === "task_notification") {
      expect(notifs[0].taskId).toBe("A");
      expect(notifs[0].result).toBe("结论A");
      expect(notifs[1].taskId).toBe("B");
      expect(notifs[1].status).toBe("failed");
    }
  });

  test("_meta.notif 空数组 → 回退正则解析 content（防空数组吞掉通知）", () => {
    // 边界：若聚合后数组为空（理论上不该发生,防御性），必须回退正则不至于丢渲染。
    const notif = buildNotification({ taskId: "empty1", status: "completed", summary: "S", result: "R" });
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: notif }],
      _meta: { origin: "task-notification", isMeta: true, notif: [] },
    };
    const items = messagesToHistoryItems([msg]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("task_notification");
    if (items[0].type === "task_notification") {
      expect(items[0].taskId).toBe("empty1");
    }
  });
});
