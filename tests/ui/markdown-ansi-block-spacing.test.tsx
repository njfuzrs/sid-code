/**
 * MarkdownAnsi 块间距回归测试。
 *
 * 根因：blocks useMemo 循环里非表格/非代码 token 曾用 `ansiBuffer +=
 * formatTokenToAnsi(token)` 直接拼接，相邻 token（标题/段落/分割线）之间
 * 没有插入任何分隔符，导致连续输出被揉成一整段无格式文本（真实用户报告：
 * docs/_template/回答消息渲染格式错乱.txt）。
 * 修复为收集进 ansiParts 数组，flush 时 `.join("\n\n")`，与 markdown.ts
 * 的 renderTokens() 语义保持一致。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "../../src/ink/_vendor/testing.tsx";
import { MarkdownAnsi } from "../../src/ui/components/MarkdownAnsi.tsx";
import { SettingsProvider } from "../../src/ui/contexts/SettingsContext.tsx";

function renderMd(text: string, width = 80): string {
  const { lastFrame, unmount } = render(
    React.createElement(
      SettingsProvider,
      null,
      React.createElement(MarkdownAnsi, { text, terminalWidth: width }),
    ),
    { columns: width },
  );
  const frame = stripAnsi(lastFrame() ?? "");
  unmount();
  return frame;
}

describe("MarkdownAnsi 块间距（真实故障复现）", () => {
  test("标题 + 段落 + 分割线 + 标题 + 段落：块之间不应粘连", () => {
    const md = [
      "# 为什么会报错",
      "",
      "这是第一段说明文字。",
      "",
      "---",
      "",
      "## 第二部分",
      "",
      "这是第二段说明文字。",
    ].join("\n");

    const out = renderMd(md);

    // 核心回归点：标题文本后必须换行，不能与紧跟的段落文本连在同一行
    expect(out).not.toContain("为什么会报错这是第一段说明文字");
    // 段落与分割线之间不能粘连
    expect(out).not.toContain("说明文字。---");
    // 分割线与下一个标题不能粘连
    expect(out).not.toContain("---第二部分");
    // 第二个标题与其后段落不能粘连
    expect(out).not.toContain("第二部分这是第二段说明文字");

    // 内容本身应完整保留
    expect(out).toContain("为什么会报错");
    expect(out).toContain("这是第一段说明文字。");
    expect(out).toContain("第二部分");
    expect(out).toContain("这是第二段说明文字。");
  });

  test("连续多段落之间应有空行分隔（非表格/非代码 token 连续出现）", () => {
    const md = "第一段落内容\n\n第二段落内容\n\n第三段落内容";
    const out = renderMd(md);

    expect(out).not.toContain("第一段落内容第二段落内容");
    expect(out).not.toContain("第二段落内容第三段落内容");
    // 段落间应存在空行（两个连续换行）
    expect(out).toMatch(/第一段落内容\n\n第二段落内容/);
    expect(out).toMatch(/第二段落内容\n\n第三段落内容/);
  });

  test("列表与相邻段落不应粘连", () => {
    const md = "说明文字：\n\n- 项目一\n- 项目二\n\n结尾文字";
    const out = renderMd(md);

    expect(out).not.toContain("说明文字：- 项目一");
    expect(out).not.toContain("项目二结尾文字");
  });

  test("表格穿插在段落之间时，表格前后的段落仍需各自换行（不受影响的既有路径）", () => {
    const md = [
      "前言段落",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "结尾段落",
    ].join("\n");
    const out = renderMd(md);

    expect(out).toContain("前言段落");
    expect(out).toContain("结尾段落");
    expect(out).toContain("┌");
    expect(out).not.toContain("前言段落┌");
  });
});
