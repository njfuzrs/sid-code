/**
 * compact 档（read / grep / glob / bash）的整帧渲染测试
 *
 * 锁的是「默认折叠成零行正文」在**真实布局**下的结果——纯函数单测只能验数据层
 * （`history-adapter` 有没有保留正文），验不了「标题行到底占几行、正文有没有漏出来」。
 *
 * 设计依据：`packages/core/src/tool/types.ts` 的 `resultDisplayMode` 注释与
 * docs-research/bugfixes/…TUI主屏历史被截断。三件事必须同时成立：
 *   1. level 0（折叠）：整帧**只有一行**，不含正文、不含「已折叠」，含结果规模；
 *   2. level 1（ctrl+o）：正文出现——这是 compact 与 summary 的本质区别；
 *   3. 错误结果 / 单行结果照常显示正文（硬约束 ② 与负收益规避）。
 *
 * 从 `ToolGroupMessage` 出发（产线唯一入口 HistoryItemDisplay → ToolGroupMessage），
 * 覆盖 displayMode 的完整传参链路。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import {
  ToolGroupMessage,
  type ToolCallDisplay,
} from "@sid-code/cli/ui/components/messages/ToolGroupMessage.tsx";
import { UIStateProvider, type ExpandLevel } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";

const BODY = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行文件内容`).join("\n");

/** read 工具的典型 compact 卡片：正文是文件内容，一次读十几行。 */
function readTool(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    id: "call_read_1",
    name: "read",
    input: { file_path: "src/ui/app.tsx" },
    status: "success",
    result: BODY,
    displayMode: "compact",
    ...overrides,
  };
}

/** bash 工具的典型 compact 卡片：命令 + 54 行输出。 */
function bashTool(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    id: "call_bash_1",
    name: "bash",
    input: { command: 'grep -rn "resultDisplayMode" packages/core/src' },
    status: "success",
    result: Array.from({ length: 54 }, (_, i) => `packages/core/src/tool/x.ts:${i}: 命中`).join(
      "\n",
    ),
    displayMode: "compact",
    ...overrides,
  };
}

function renderTools(tools: ToolCallDisplay[], level: ExpandLevel = 0, width = 100): string {
  const { lastFrame } = render(
    <UIStateProvider initialExpandLevel={level}>
      <ToolGroupMessage tools={tools} terminalWidth={width} />
    </UIStateProvider>,
  );
  return stripAnsi(lastFrame() ?? "");
}

/** 整帧的非空行（`lastFrame` 末尾常带一个换行）。 */
function lines(frame: string): string[] {
  return frame.split("\n").filter((l) => l.trim() !== "");
}

describe("compact 折叠态（level 0）— 零行正文", () => {
  test("read 卡片整帧只有一行，不含正文，含结果规模「12 行」", () => {
    const frame = renderTools([readTool()]);
    expect(lines(frame)).toHaveLength(1);
    expect(frame).not.toContain("第 1 行文件内容");
    expect(frame).not.toContain("已折叠");
    expect(frame).toContain("12 行");
  });

  test("bash 卡片整帧只有一行，命令并进标题行、不含输出正文", () => {
    const frame = renderTools([bashTool()]);
    expect(lines(frame)).toHaveLength(1);
    expect(frame).toContain("grep -rn");
    expect(frame).toContain("54 行输出");
    expect(frame).not.toContain("命中");
    expect(frame).not.toContain("已折叠");
  });

  test("bash 多行命令压成一行（否则会撞破 height={1} 的 header）", () => {
    const frame = renderTools([
      bashTool({
        input: { command: 'cd packages/core && grep -rn "x" src\n  | head -5' },
        result: "a\nb\nc",
      }),
    ]);
    expect(lines(frame)).toHaveLength(1);
    expect(frame).toContain("cd packages/core && grep");
  });

  test("多张 compact 卡片并列：各占一行，一条正文都不漏", () => {
    const frame = renderTools([
      readTool({ id: "r1" }),
      readTool({ id: "r2", input: { file_path: "src/ui/app2.tsx" } }),
      bashTool(),
    ]);
    expect(lines(frame)).toHaveLength(3);
    expect(frame).not.toContain("第 1 行文件内容");
  });

  test("未声明档位的工具不受影响（默认原样展示正文）", () => {
    const frame = renderTools([readTool({ displayMode: undefined })]);
    expect(frame).toContain("第 1 行文件内容");
  });
});

describe("compact 展开态（level 1 = ctrl+o）— 正文回来", () => {
  test("read 卡片正文出现（与 summary 的本质区别：正文从未丢）", () => {
    const frame = renderTools([readTool()], 1);
    expect(frame).toContain("第 1 行文件内容");
    expect(frame).toContain("第 12 行文件内容");
    // 正文不再被折叠，标题行的「12 行」摘要让位
    expect(frame).not.toContain("已折叠");
  });

  test("bash 卡片正文出现且命令仍在标题行（不被展开态挤掉）", () => {
    const frame = renderTools([bashTool()], 1);
    expect(frame).toContain("命中");
    expect(frame).toContain("grep -rn");
  });
});

describe("compact 档的边界：错误与单行", () => {
  test("硬约束②：错误结果照常显示正文（渲染层第二道防线）", () => {
    // 数据层已保证错误结果不带档位；这里手工构造一个「误带 compact 的错误卡」，
    // 断言 ToolMessage 自己也挡住——错误被折起来比啰嗦严重得多。
    const frame = renderTools([
      readTool({
        status: "error",
        isError: true,
        result: "文件不存在\n第二行错误细节",
      }),
    ]);
    expect(frame).toContain("文件不存在");
    expect(frame).toContain("第二行错误细节");
  });

  test("单行结果照常显示正文（「未找到匹配的内容」不该折成「1 行输出」）", () => {
    const frame = renderTools([
      readTool({ name: "grep", result: "未找到匹配的内容", displayMode: undefined }),
    ]);
    expect(frame).toContain("未找到匹配的内容");
  });
});
