/**
 * 补全列表布局回归：每项严格一行、描述列与标签列在所有可见项上对齐。
 *
 * 旧实现（命令名列 flexShrink=0 + 描述列 wrap）的三种错乱都在这里锁住：
 * 描述起点随命令名漂移 / 长描述一项占十行 / 长 argumentHint 把描述挤成一字一行竖排。
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import stringWidth from "string-width";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import {
  SuggestionsDisplay,
  truncateToWidth,
  type Suggestion,
} from "@sid-code/cli/ui/components/SuggestionsDisplay.tsx";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const ITEMS: Suggestion[] = [
  {
    label: "/permissions",
    value: "",
    description: "查看当前权限规则和模式",
    icon: "›",
    tag: "命令",
  },
  {
    label: "/eval-session",
    value: "",
    // skill description 常见形态：超长 + 内嵌换行
    description:
      "对一次已完成的 sid-code 任务会话做三段式评估(结果 + LLM 过程 + harness),\n通过轨迹找出 sid-code 自身的 bug 和可优化地方".repeat(
        3,
      ),
    icon: "›",
    tag: "命令",
  },
  {
    label: "/mcp",
    value: "",
    argumentHint:
      "[list|add|remove|enable|disable|test|authenticate|approve|prompts|prompt|resources] [参数]",
    description: "MCP 服务器管理（无参打开交互面板）",
    icon: "›",
    tag: "命令",
  },
  { label: "/clear", value: "", description: "清空对话历史", icon: "›", tag: "命令" },
];

function frameLines(width: number): string[] {
  const { lastFrame, unmount } = render(
    <SuggestionsDisplay suggestions={ITEMS} activeIndex={2} width={width} />,
    { columns: width },
  );
  const out = stripAnsi(lastFrame() ?? "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  unmount();
  return out;
}

describe("SuggestionsDisplay 布局", () => {
  for (const width of [60, 80, 120]) {
    test(`width=${width}：每项一行，不超宽`, () => {
      const lines = frameLines(width);
      expect(lines.length).toBe(ITEMS.length);
      for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(width);
    });

    test(`width=${width}：描述列与标签列对齐`, () => {
      const lines = frameLines(width);
      const tagCols = lines.map((l) => stringWidth(l.slice(0, l.indexOf("[命令]"))));
      expect(new Set(tagCols).size).toBe(1);
      // 描述起点：/permissions 与 /clear 的描述首字所在列必须相同
      const descCol = (l: string, d: string) => stringWidth(l.slice(0, l.indexOf(d)));
      expect(descCol(lines[0], "查看")).toBe(descCol(lines[3], "清空"));
    });
  }

  test("长 argumentHint 截断，不挤占描述", () => {
    const mcp = frameLines(80)[2];
    expect(mcp).toContain("…");
    expect(mcp).toContain("MCP 服务器管理");
  });

  test("truncateToWidth 按显示列宽截断（CJK 安全）", () => {
    expect(truncateToWidth("清空对话历史", 20)).toBe("清空对话历史");
    const t = truncateToWidth("清空对话历史", 7);
    expect(t).toBe("清空对…");
    expect(stringWidth(t)).toBeLessThanOrEqual(7);
    expect(truncateToWidth("abc", 0)).toBe("");
  });
});
