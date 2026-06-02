/**
 * 中间位置命令补全检测测试（Task 5）
 */

import { describe, test, expect } from "bun:test";
import { findMidInputSlashCommand } from "../../src/command/mid-input.ts";

describe("findMidInputSlashCommand", () => {
  test("识别中间位置的斜杠命令", () => {
    const input = "help me /com";
    const r = findMidInputSlashCommand(input, input.length);
    expect(r).not.toBeNull();
    expect(r?.token).toBe("/com");
    expect(r?.partialCommand).toBe("com");
    expect(r?.startPos).toBe(8);
  });

  test("行首斜杠命令不在此处理（返回 null）", () => {
    expect(findMidInputSlashCommand("/compact", 8)).toBeNull();
  });

  test("光标不在 token 末尾时不触发", () => {
    const input = "help me /com and more";
    // 光标在 "more" 之后
    expect(findMidInputSlashCommand(input, input.length)).toBeNull();
  });

  test("空 token（只输入 /）也能识别", () => {
    const input = "do /";
    const r = findMidInputSlashCommand(input, input.length);
    expect(r?.token).toBe("/");
    expect(r?.partialCommand).toBe("");
  });

  test("无斜杠返回 null", () => {
    expect(findMidInputSlashCommand("just text", 9)).toBeNull();
  });

  test("斜杠前无空白（如 a/b 路径）不触发", () => {
    const input = "path a/b";
    expect(findMidInputSlashCommand(input, input.length)).toBeNull();
  });
});
