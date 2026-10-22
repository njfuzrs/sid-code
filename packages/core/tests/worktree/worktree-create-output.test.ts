/**
 * B5：WorktreeCreate hook 输出解析（对齐 CC：JSON worktreePath / 最后一个非空行 / 去 ANSI）
 * 来源：docs-research/sid-code/bugfixes/todo/20261019-hook文档核查发现的代码缺陷与文档问题.md
 */

import { describe, test, expect } from "bun:test";
import { parseWorktreeCreateOutput } from "@sid-code/core/worktree/hooks.ts";

describe("parseWorktreeCreateOutput", () => {
  test("纯 stdout：取最后一行", () => {
    expect(parseWorktreeCreateOutput("准备中\n/tmp/wt-a")).toBe("/tmp/wt-a");
  });

  test("CC JSON 形式：取 hookSpecificOutput.worktreePath", () => {
    const out = JSON.stringify({
      hookSpecificOutput: { hookEventName: "WorktreeCreate", worktreePath: "/tmp/wt-json" },
    });
    expect(parseWorktreeCreateOutput(out)).toBe("/tmp/wt-json");
  });

  test("多行格式化 JSON 也能识别", () => {
    const out = JSON.stringify({ hookSpecificOutput: { worktreePath: "/tmp/wt-pretty" } }, null, 2);
    expect(parseWorktreeCreateOutput(out)).toBe("/tmp/wt-pretty");
  });

  test("末尾有空行 / 带颜色的启动横幅：取最后一个非空行，去掉 ANSI", () => {
    expect(parseWorktreeCreateOutput("\x1b[32mbanner\x1b[0m\n\x1b[1m/tmp/wt-c\x1b[0m\n\n")).toBe(
      "/tmp/wt-c",
    );
  });

  test("非法 JSON 回落到纯文本，不误判", () => {
    expect(parseWorktreeCreateOutput("{not json}")).toBe("{not json}");
  });

  test("JSON 无 worktreePath：回落到最后一行（交给路径校验报错）", () => {
    expect(parseWorktreeCreateOutput('{"systemMessage":"x"}')).toBe('{"systemMessage":"x"}');
  });

  test("空输出 → 空串", () => {
    expect(parseWorktreeCreateOutput("  \n\n")).toBe("");
  });
});
