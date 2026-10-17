/**
 * MarkdownAnsi 代码块「复制即可执行」回归测试。
 *
 * 根因：markdown 代码块经 colorizeCode 渲染时默认带行号（且外层 paddingLeft=1），
 * 默认主屏模式下复制走终端原生选择，行号与前导空格原样进剪贴板，
 * 多行命令粘贴即执行失败。对齐 CC：markdown 代码块只高亮，不画 gutter。
 * 行号只属于 diff / 文件内容展示（DiffRenderer），不受本修复影响。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { MarkdownAnsi } from "@sid-code/cli/ui/components/MarkdownAnsi.tsx";
import { SettingsProvider } from "@sid-code/cli/ui/contexts/SettingsContext.tsx";

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

function nonEmptyLines(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.trimEnd());
}

describe("MarkdownAnsi 代码块可直接复制", () => {
  test("多行命令代码块：每行原样输出，无行号、无前导空格", () => {
    const cmds = ["git switch main", "bun run affected-tests:run", "make build"];
    // 整行比对而非 toContain —— toContain 对「1 git switch main」也会放行
    expect(nonEmptyLines(renderMd(["```bash", ...cmds, "```"].join("\n")))).toEqual(cmds);
  });

  test("缩进敏感内容保持原缩进（不被整体右移）", () => {
    const py = ["def f():", "    return 1"];
    expect(nonEmptyLines(renderMd(["```python", ...py, "```"].join("\n")))).toEqual(py);
  });

  test("原始故障形态：标题后接无语言围栏块，内容不得带行号前缀", () => {
    const md = [
      "## 验证证据",
      "",
      "```",
      "docs:gen-reference --check   → ✓ 参考页与源码一致",
      "make build                   → 成功",
      "```",
    ].join("\n");
    const lines = nonEmptyLines(renderMd(md));
    expect(lines).toContain("docs:gen-reference --check   → ✓ 参考页与源码一致");
    expect(lines).toContain("make build                   → 成功");
  });
});
