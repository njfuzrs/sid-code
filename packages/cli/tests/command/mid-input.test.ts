/**
 * 中间位置命令补全检测测试（Task 5）
 */

import { describe, test, expect } from "bun:test";
import { resolveSlashCompletionTarget } from "@sid-code/cli/command/mid-input.ts";

/** 单行输入的中间位置检测（findMidInputSlashCommand 已不导出，经公开入口测） */
function findMid(input: string, col: number) {
  const t = resolveSlashCompletionTarget([input], 0, col);
  // 行首命令由主逻辑处理，不属于「中间位置」
  if (!t || t.replaceFrom === null) return null;
  return {
    token: input.slice(t.replaceFrom, col),
    startPos: t.replaceFrom,
    partialCommand: t.query,
  };
}

describe("中间位置斜杠命令检测", () => {
  test("识别中间位置的斜杠命令", () => {
    const input = "help me /com";
    const r = findMid(input, input.length);
    expect(r).not.toBeNull();
    expect(r?.token).toBe("/com");
    expect(r?.partialCommand).toBe("com");
    expect(r?.startPos).toBe(8);
  });

  test("行首斜杠命令不在此处理（返回 null）", () => {
    expect(findMid("/compact", 8)).toBeNull();
  });

  test("光标不在 token 末尾时不触发", () => {
    const input = "help me /com and more";
    // 光标在 "more" 之后
    expect(findMid(input, input.length)).toBeNull();
  });

  test("空 token（只输入 /）也能识别", () => {
    const input = "do /";
    const r = findMid(input, input.length);
    expect(r?.token).toBe("/");
    expect(r?.partialCommand).toBe("");
  });

  test("无斜杠返回 null", () => {
    expect(findMid("just text", 9)).toBeNull();
  });

  test("斜杠前无空白（如 a/b 路径）不触发", () => {
    const input = "path a/b";
    expect(findMid(input, input.length)).toBeNull();
  });
});
