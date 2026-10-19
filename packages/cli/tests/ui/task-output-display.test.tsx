/**
 * task_output 的两条展示回归（20261019 follow-up）：
 *
 * 1. **整帧接线**（原方案 §5 最后一行要求、#358 漏掉的那道）：只测
 *    `extractTaskOutputDisplay` 纯函数时，把 `history-adapter` 里
 *    `toolName === "task_output"` 的接线整个删掉，测试仍然全绿（变异实测 25 pass）。
 *    这里必须从 `buildCompletedToolCall` / `ToolGroupMessage` 走完整链路。
 * 2. **等待进度行**：`task_output` 阻塞等待时上报的
 *    「等待任务完成 · 已等 Ns · esc 可中断」必须出现在卡片下方（不是 header 尾部）。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { buildCompletedToolCall } from "@sid-code/cli/ui/history-adapter.ts";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import {
  ToolGroupMessage,
  type ToolCallDisplay,
} from "@sid-code/cli/ui/components/messages/ToolGroupMessage.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { TREE_BRANCH } from "@sid-code/cli/ui/constants/figures.ts";

/** TaskOutputTool 终态 agent 的返回体（与 task-output.ts 的 F2 标签块同形态）。 */
const LABEL_BLOCK = [
  "<task-output>",
  "  <task-id>t1</task-id>",
  "  <task-type>local_agent</task-type>",
  "  <status>completed</status>",
  "  <description>排查方向</description>",
  "  <output-file>/tmp/t1.output</output-file>",
  '  <result untrusted="true">## 结论',
  "第一行",
  "第二行</result>",
  "  <usage>",
  "    <total_tokens>9</total_tokens>",
  "  </usage>",
  "</task-output>",
].join("\n");

function resultBlock(toolUseId: string, content: string) {
  return { type: "tool_result" as const, tool_use_id: toolUseId, content };
}

function toToolCall(card: ReturnType<typeof buildCompletedToolCall>): ToolCallDisplay {
  return {
    id: card.callId,
    name: card.name,
    input: card.input,
    // ui/types 的 ToolCallStatus 是 enum，ToolCallDisplay 用的是字符串联合；值域相同。
    status: card.status as string as ToolCallDisplay["status"],
    result: card.resultDisplay?.content,
    isError: card.resultDisplay?.isError,
    resultSummary: card.resultSummary,
  };
}

function renderTools(tools: ToolCallDisplay[], width = 100): string {
  const { lastFrame } = render(
    <UIStateProvider>
      <ToolGroupMessage tools={tools} terminalWidth={width} />
    </UIStateProvider>,
  );
  return lastFrame() ?? "";
}

describe("task_output 展示接线（整帧）", () => {
  test("resultDisplay.content 只含结论正文；元数据标签 / JSON / 字面 \\n 都不上屏", () => {
    const card = buildCompletedToolCall(resultBlock("c1", LABEL_BLOCK), "task_output");

    expect(card.resultDisplay?.content).toBe("## 结论\n第一行\n第二行");
    expect(card.resultDisplay?.content).not.toContain("<task-id>");
    expect(card.resultDisplay?.content).not.toContain("<status>");
    expect(card.resultDisplay?.content).not.toContain("<usage>");
    expect(card.resultDisplay?.content).not.toContain('{"task_id"');
    // 旧 JSON 形态的 `\n` 转义（字面反斜杠 + n）不得出现；真实换行是允许的。
    expect(card.resultDisplay?.content).not.toContain("\\n");
    expect(card.resultSummary).toBe("已读取结果 · 3 行");
  });

  test("渲染整帧：卡片正文是结论，不含 JSON / 元数据标签", () => {
    const card = buildCompletedToolCall(resultBlock("c1", LABEL_BLOCK), "task_output");
    const frame = renderTools([toToolCall(card)]);

    expect(frame).toContain("## 结论");
    expect(frame).not.toContain('{"task_id"');
    expect(frame).not.toContain("<task-id>");
    expect(frame).not.toContain("<usage>");
    expect(frame).not.toContain("\\n");
  });

  test("错误结果不提取正文（错误必须原样可见，不能被展示层吞掉）", () => {
    const card = buildCompletedToolCall(
      {
        ...resultBlock("c2", "<task-output>\n  <status>failed</status>\n</task-output>"),
        is_error: true,
      },
      "task_output",
    );
    expect(card.resultDisplay?.content).toContain("<task-output>");
  });
});

describe("task_output 等待进度行", () => {
  const waiting = (progressMessage?: string): ToolCallDisplay => ({
    id: "c9",
    name: "task_output",
    input: { task_id: "t1", block: true },
    status: "executing",
    progressMessage,
  });

  test("executing + progressMessage → 卡片下方出现「等待任务完成 · 已等 Ns · esc 可中断」", () => {
    const frame = renderTools([waiting("等待任务完成 · 已等 3s · esc 可中断")]);
    expect(frame).toContain("等待任务完成");
    expect(frame).toContain("已等 3s");
    expect(frame).toContain("esc 可中断");
    // 锁「在卡片下方一行，而非 header 尾部」：进度文字所在行必须是树枝行，且不含 header 的工具名
    const lines = frame.split("\n");
    const headerIdx = lines.findIndex((l) => l.includes("task_output") || l.includes("t1"));
    const progressIdx = lines.findIndex((l) => l.includes("等待任务完成"));
    expect(progressIdx).toBeGreaterThan(headerIdx);
    expect(lines[progressIdx]!).toContain(TREE_BRANCH);
    expect(lines[progressIdx]!).not.toContain("task_output");
  });

  test("没有 progressMessage 时不出等待行（不产生假信号）", () => {
    const frame = renderTools([waiting(undefined)]);
    expect(frame).not.toContain("等待任务完成");
  });
});

describe("非 shell 工具的执行中进度行（推广范围）", () => {
  // hasProgressLine 对所有无结构化进度的非 shell 工具生效，不只 task_output。
  // LSP 的阶段文案（「等待语言服务器就绪…」）同样从 header 尾部移到下方一行——
  // 这是有意的推广，这里锁住它，免得范围再静默漂移。
  test("lsp 执行中的阶段文案渲染在 header 下方树枝行", () => {
    const frame = renderTools([
      {
        id: "l1",
        name: "lsp",
        input: { operation: "hover", file_path: "/tmp/a.ts" },
        status: "executing",
        progressMessage: "等待语言服务器就绪…",
      },
    ]);
    const lines = frame.split("\n");
    const progressIdx = lines.findIndex((l) => l.includes("等待语言服务器就绪"));
    expect(progressIdx).toBeGreaterThan(0);
    expect(lines[progressIdx]!).toContain(TREE_BRANCH);
  });

  test("有结构化进度（progress 数值）的工具不走下方进度行", () => {
    const frame = renderTools([
      {
        id: "m1",
        name: "mcp__srv__tool",
        input: {},
        status: "executing",
        progressMessage: "下载中",
        progress: 3,
        progressTotal: 10,
      } as ToolCallDisplay,
    ]);
    const lines = frame.split("\n").filter((l) => l.includes("下载中"));
    expect(lines.every((l) => !l.trimStart().startsWith(TREE_BRANCH))).toBe(true);
  });
});
