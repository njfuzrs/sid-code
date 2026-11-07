/**
 * 定时唤醒消息的渲染与分流（F3，2026-11-07）
 *
 * 缺陷形态：`schedule_wakeup` / `/loop` / `cron_create` 到点后注入的 prompt 在 TUI 里
 * 渲染成 `> …` 普通用户消息，用户看到的是「根本不是我输入的话」。修法是**结构化标记**
 * （`_meta.origin = "scheduled-prompt"`）走专用分流 + 专用组件，不靠文本前缀猜。
 *
 * 三条不变量（本文件逐个锁住）：
 *  1. 带标记的消息产出 `type:"scheduled"`，**不再**产出 `type:"user"`（含 resume 重建）；
 *  2. 同消息里的兄弟块（tool_result）照常渲染，不因分流丢块（留 pending 气泡）；
 *  3. 专用渲染靠字形（`›` vs `>`）+ 颜色两个通道区分，单行不超宽。
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { messagesToHistoryItems } from "@sid-code/cli/ui/history-adapter.ts";
import { ScheduledPromptMessage } from "@sid-code/cli/ui/components/messages/ScheduledPromptMessage.tsx";
import { HistoryItemDisplay } from "@sid-code/cli/ui/components/HistoryItemDisplay.tsx";
import { ToolCallStatus } from "@sid-code/cli/ui/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  INTERNAL_ORIGINS,
  INTERNAL_RENDER_ORIGINS,
} from "@sid-code/core/context/internal-message.ts";
import {
  formatScheduledPromptHeader,
  stripScheduledPromptHeader,
  withScheduledPromptHeader,
  type ScheduledPromptSource,
} from "@sid-code/core/query/scheduled-prompt.ts";
import { stringWidth } from "@sid-code/cli/ui/render-port/text.ts";
import { ARROW_PROMPT } from "@sid-code/cli/ui/constants/figures.ts";

const SRC: ScheduledPromptSource = { taskId: "a825f8ab", origin: "schedule_wakeup" };

/** 构造一条「引擎落盘后」的定时注入 user 消息（首行带来源头） */
function scheduledMessage(prompt: string, meta: ScheduledPromptSource = SRC): Message {
  return {
    role: "user",
    content: [{ type: "text", text: withScheduledPromptHeader(prompt, meta, "zh") }],
    _meta: {
      origin: "scheduled-prompt",
      scheduledTaskId: meta.taskId,
      scheduledOrigin: meta.origin,
    },
  };
}

describe("T-F3-4 history-adapter 分流", () => {
  test("产出 type:scheduled，不产出 type:user，preview 是原始 prompt 首行", () => {
    const items = messagesToHistoryItems([scheduledMessage("继续 T3 第二步收尾\n第二行不进预览")]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("scheduled");
    const item = items[0] as Extract<(typeof items)[number], { type: "scheduled" }>;
    expect(item.taskId).toBe("a825f8ab");
    expect(item.origin).toBe("schedule_wakeup");
    // 预览剥掉了来源头，且只取首行
    expect(item.preview).toBe("继续 T3 第二步收尾");
    expect(item.preview).not.toContain("[定时唤醒");
    // 绝不产出普通用户消息
    expect(items.some((i) => i.type === "user")).toBe(false);
  });

  test("resume：从持久化消息重建结果相同（_meta 随消息落盘）", () => {
    const persisted = JSON.parse(JSON.stringify([scheduledMessage("继续检查 CI")])) as Message[];
    const items = messagesToHistoryItems(persisted);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("scheduled");
    expect((items[0] as any).preview).toBe("继续检查 CI");
  });

  test("origin=loop 也走同一分支，标签可区分", () => {
    const items = messagesToHistoryItems([
      scheduledMessage("/loop 每小时检查一次", { taskId: "l1", origin: "loop" }),
    ]);
    expect(items[0].type).toBe("scheduled");
    expect((items[0] as any).origin).toBe("loop");
  });

  test("没有 scheduled-prompt 标记的普通输入仍是 type:user（不动普通人）", () => {
    const items = messagesToHistoryItems([
      { role: "user", content: [{ type: "text", text: "你好" }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("user");
  });
});

describe("T-F3-6 分流但不丢兄弟块", () => {
  test("同一条 user 消息挂 tool_result + 定时 prompt：tool_result 照常渲染", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "命令输出" },
          {
            type: "text",
            text: withScheduledPromptHeader("到点检查", SRC, "zh"),
          },
        ],
        _meta: {
          origin: "scheduled-prompt",
          scheduledTaskId: SRC.taskId,
          scheduledOrigin: SRC.origin,
        },
      },
    ];
    const items = messagesToHistoryItems(msgs);
    const types = items.map((i) => i.type);
    expect(types).toContain("scheduled");
    // ⚠️ 只断言「有 tool_group」不够：末尾的兜底逻辑（pendingToolCalls 非空）也会产出
    // 一个 tool_group，把「兄弟块被吞掉」伪装成通过。必须断言**合并了 tool_result**：
    // status 是 success（不是兜底的 executing）且带真实结果正文。
    const group = items.find((i) => i.type === "tool_group") as any;
    expect(group).toBeDefined();
    expect(group.tools[0].status).toBe(ToolCallStatus.Success);
    expect(group.tools[0].resultDisplay?.content).toBe("命令输出");
  });
});

describe("T-F3-7 ScheduledPromptMessage 整帧渲染", () => {
  const preview = "继续 T3 第二步收尾：检查 PR #633 的 CI 与合并状态";

  test("columns=120：行首是 › 不是 >，含任务 id", () => {
    const { lastFrame } = render(
      <ScheduledPromptMessage
        taskId="a825f8ab"
        origin="schedule_wakeup"
        preview={preview}
        width={120}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "").trimEnd();
    expect(frame.startsWith(ARROW_PROMPT)).toBe(true);
    expect(frame.startsWith(">")).toBe(false);
    expect(frame).toContain("a825f8ab");
    expect(frame).toContain("定时唤醒");
  });

  test("columns=40：单行不超宽（stringWidth 判），中文不错位", () => {
    const width = 40;
    const { lastFrame } = render(
      <ScheduledPromptMessage
        taskId="a825f8ab"
        origin="schedule_wakeup"
        preview={preview}
        width={width}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? "")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(stringWidth(lines[0])).toBeLessThanOrEqual(width);
    // 截断后保留任务 id 与省略号，不是把中文切成半个字
    expect(lines[0]).toContain("a825f8ab");
    expect(lines[0]).toContain("…");
  });

  test("HistoryItemDisplay 分发到专用组件（不是 UserMessage）", () => {
    const { lastFrame } = render(
      <HistoryItemDisplay
        item={{
          id: 1,
          type: "scheduled",
          taskId: "abcdef12",
          origin: "loop",
          preview: "/loop 定时任务示例",
        }}
        terminalWidth={100}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "").trimEnd();
    expect(frame.startsWith(ARROW_PROMPT)).toBe(true);
    expect(frame).toContain("abcdef12");
    // origin=loop 的标签与 schedule_wakeup 不同（同一函数产出，不会各自漂移）
    expect(frame).toContain("/loop");
  });
});

describe("T-F3-8 内部 origin 哨兵", () => {
  test("scheduled-prompt 在「专用渲染」清单里", () => {
    expect(INTERNAL_RENDER_ORIGINS).toContain("scheduled-prompt");
  });

  test("scheduled-prompt 绝不能进「整条隐藏」清单", () => {
    // 进 INTERNAL_ORIGINS 就会被 isHiddenFromDisplay 整条吞掉，
    // 用户连「有一次唤醒」都看不到 —— 那比多显示一行更糟。
    expect(INTERNAL_ORIGINS).not.toContain("scheduled-prompt");
  });
});

describe("来源头文案（单一事实源）", () => {
  test("中文头含 origin 与任务 id，且明说不是用户新输入", () => {
    const header = formatScheduledPromptHeader(SRC, "zh");
    expect(header).toContain("schedule_wakeup");
    expect(header).toContain("a825f8ab");
    expect(header).toContain("不是用户新输入");
  });

  test("英文偏好出英文头", () => {
    const header = formatScheduledPromptHeader(SRC, "en");
    expect(header).toContain("Scheduled wakeup");
    expect(header).toContain("not a new user message");
  });

  test("loop / cron_create 的标签不同（区分来源）", () => {
    expect(formatScheduledPromptHeader({ taskId: "x", origin: "loop" }, "zh")).toContain("/loop");
    expect(formatScheduledPromptHeader({ taskId: "x", origin: "cron_create" }, "zh")).toContain(
      "cron_create",
    );
  });

  test("strip 能把两种语言的头都剥掉；无头时原样返回", () => {
    expect(stripScheduledPromptHeader(withScheduledPromptHeader("正文", SRC, "zh"), SRC)).toBe(
      "正文",
    );
    expect(stripScheduledPromptHeader(withScheduledPromptHeader("body", SRC, "en"), SRC)).toBe(
      "body",
    );
    expect(stripScheduledPromptHeader("裸正文", SRC)).toBe("裸正文");
  });
});
