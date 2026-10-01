/**
 * D4 / D5：斜杠补全的「判定按当前行」与「应用按 token」。
 *
 * D4 修复前：检测侧返回了 startPos，应用侧却一律 home + killLine 整行替换，
 * `帮我看下 /com` → Tab → `/compact `，前缀那句话被静默删除；Enter 更是直接提交 `/compact`。
 * D5 修复前：光标不在第 1 行时列被钳成 firstLine.length，第 2 行打字也按第 1 行结尾弹补全。
 */

import { describe, test, expect } from "bun:test";
import {
  resolveSlashCompletionTarget,
  applySlashCompletion,
  canSubmitSlashCompletionDirectly,
} from "@sid-code/cli/command/mid-input.ts";

/** 模拟一次完整的「判定 → Tab 回填」 */
function tab(lines: string[], row: number, col: number, value: string): string {
  const target = resolveSlashCompletionTarget(lines, row, col);
  expect(target).not.toBeNull();
  return applySlashCompletion(lines, row, col, target!.replaceFrom, value).lines.join("\n");
}

describe("D4 中间位置补全只替换 token", () => {
  test("Tab：保留前缀", () => {
    const line = "帮我看下 /com";
    expect(tab([line], 0, line.length, "/compact ")).toBe("帮我看下 /compact ");
  });

  test("Tab：光标后的内容也保留，光标落在补全值之后", () => {
    const lines = ["看 /co 然后继续"];
    const col = "看 /co".length;
    const target = resolveSlashCompletionTarget(lines, 0, col)!;
    const r = applySlashCompletion(lines, 0, col, target.replaceFrom, "/compact ");
    expect(r.lines[0]).toBe("看 /compact  然后继续");
    expect(r.cursorCol).toBe("看 /compact ".length);
  });

  test("行首命令仍整行替换（回归）", () => {
    expect(tab(["/com"], 0, 4, "/compact ")).toBe("/compact ");
  });

  test("Enter：中间位置不许直接提交（否则前缀凭空消失）", () => {
    const line = "帮我看下 /com";
    const target = resolveSlashCompletionTarget([line], 0, line.length)!;
    expect(canSubmitSlashCompletionDirectly([line], target.replaceFrom, false)).toBe(false);
  });

  test("Enter：整条输入就是一个命令 token 时才直接提交（回归）", () => {
    const target = resolveSlashCompletionTarget(["/com"], 0, 4)!;
    expect(canSubmitSlashCompletionDirectly(["/com"], target.replaceFrom, false)).toBe(true);
    // requiresArgs 的命令仍只回填
    expect(canSubmitSlashCompletionDirectly(["/com"], target.replaceFrom, true)).toBe(false);
  });

  test("Enter：多行输入不直接提交", () => {
    expect(canSubmitSlashCompletionDirectly(["/com", "第二行"], null, false)).toBe(false);
  });
});

describe("D5 斜杠补全按光标所在行判定", () => {
  test("光标在第 2 行时，第 1 行结尾的 /xxx 不再触发", () => {
    const lines = ["看下 /com", "我在第二行打字"];
    expect(resolveSlashCompletionTarget(lines, 1, lines[1].length)).toBeNull();
  });

  test("第 1 行是行首命令、光标在第 2 行时也不触发", () => {
    expect(resolveSlashCompletionTarget(["/com", "x"], 1, 1)).toBeNull();
  });

  test("第 2 行自己的中间位置 token 能触发，且只替换第 2 行的 token", () => {
    const lines = ["第一行保持不变", "再看 /com"];
    expect(tab(lines, 1, lines[1].length, "/compact ")).toBe("第一行保持不变\n再看 /compact ");
  });

  test("非首行以 / 开头不当行首命令（命令必须是整条输入开头）", () => {
    expect(resolveSlashCompletionTarget(["abc", "/com"], 1, 4)).toBeNull();
  });
});
