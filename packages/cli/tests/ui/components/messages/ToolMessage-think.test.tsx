/**
 * ToolMessage / ToolGroupMessage 的 think 工具渲染测试
 *
 * 锁定本次修复的可见结果（见 docs/_template/已记录思考的显示功能上不清晰不明确.txt）：
 *
 * 修复前屏幕上是这样，用户完全不知道记了什么、有什么用：
 *   ⏺ think
 *     ⎿ 已记录思考。
 *
 * 修复后：header 给用途标签，结果区给真实思考正文：
 *   ⏺ think 思考记录
 *     ⎿ 先读 config.ts 确认默认值来源，再决定是改 schema 还是改运行时兜底…
 *
 * 关键点：思考内容存在**工具输入**（input.thought）里，工具**结果**只是一句无信息的
 * 确认语。展示链路一直携带 input 却从未用它——这是缺陷根因，故测试从 ToolGroupMessage
 * （产线唯一入口 HistoryItemDisplay → ToolGroupMessage）出发，覆盖完整取值链路。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import {
  ToolGroupMessage,
  type ToolCallDisplay,
} from "@sid-code/cli/ui/components/messages/ToolGroupMessage.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";

const THOUGHT = "先读 config.ts 确认默认值来源，再决定是改 schema 还是改运行时兜底。";

/** think 工具调用的典型形态：input 带 thought，result 是那句无信息确认语。 */
function thinkTool(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    id: "call_think_1",
    name: "think",
    input: { thought: THOUGHT },
    status: "success",
    result: "已记录思考。",
    ...overrides,
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

describe("think 渲染 — 思考内容可见", () => {
  test("结果区展示思考正文，不再是无信息的「已记录思考。」（核心回归点）", () => {
    const frame = renderTools([thinkTool()]);
    expect(frame).toContain("先读 config.ts 确认默认值来源");
    expect(frame).not.toContain("已记录思考");
  });

  test("header 不再是光秃秃的 `think`，带用途标签", () => {
    const frame = renderTools([thinkTool()]);
    expect(frame).toContain("think");
    expect(frame).toContain("思考记录");
  });

  test("header 与正文不重复同一段文字（短思考尤其明显）", () => {
    const short = "先读配置再动手";
    const frame = renderTools([thinkTool({ input: { thought: short } })]);
    // 思考正文出现且只出现一次——修复中途曾出现 header 摘要与正文一模一样的"卡带"观感
    const occurrences = frame.split(short).length - 1;
    expect(occurrences).toBe(1);
  });

  test("结果区带 ⎿ 树枝缩进（与其它工具结果的视觉节奏一致）", () => {
    const frame = renderTools([thinkTool()]);
    expect(frame).toContain("⎿");
  });

  test("长思考折叠并给统一的展开提示，不灌满屏幕", () => {
    const longThought = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行推理内容`).join("\n");
    const frame = renderTools([thinkTool({ input: { thought: longThought } })]);
    expect(frame).toContain("第 1 行推理内容");
    // 统一折叠文案（collapse.ts formatCollapsedSummary）
    expect(frame).toContain("已折叠");
    expect(frame).toContain("ctrl+o");
    // 末尾行应被折叠掉
    expect(frame).not.toContain("第 30 行推理内容");
  });

  test("空思考 → 工具报错时仍走错误渲染路径，错误可见", () => {
    const frame = renderTools([
      thinkTool({
        input: { thought: "   " },
        status: "error",
        isError: true,
        result: "（未提供思考内容）",
      }),
    ]);
    expect(frame).toContain("未提供思考内容");
  });

  test("不影响其它工具：bash 仍展示命令与输出", () => {
    const frame = renderTools([
      {
        id: "call_bash_1",
        name: "bash",
        input: { command: "echo hi" },
        status: "success",
        result: "hi",
      },
    ]);
    expect(frame).toContain("echo hi");
    expect(frame).toContain("hi");
    expect(frame).not.toContain("思考记录");
  });

  test("多次连续 think 各自展示自己的思考（截图里正是连续 6 条无差别的 think）", () => {
    const frame = renderTools([
      thinkTool({ id: "t1", input: { thought: "第一次思考：先定位根因" } }),
      thinkTool({ id: "t2", input: { thought: "第二次思考：再验证假设" } }),
    ]);
    expect(frame).toContain("第一次思考：先定位根因");
    expect(frame).toContain("第二次思考：再验证假设");
  });
});
