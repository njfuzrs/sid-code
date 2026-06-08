import { describe, expect, test } from "bun:test";
import { sanitizeStrings } from "../../src/llm/sanitize-unicode.ts";

describe("sanitizeStrings", () => {
  test("空字符串不变", () => {
    expect(sanitizeStrings("")).toBe("");
  });

  test("纯 ASCII 字符串不变", () => {
    expect(sanitizeStrings("hello world")).toBe("hello world");
  });

  test("合法 emoji（完整 surrogate pair）保留", () => {
    const emoji = "\uD83D\uDE10"; // 😐
    expect(sanitizeStrings(emoji)).toBe(emoji);
  });

  test("孤立高位 surrogate → U+FFFD", () => {
    expect(sanitizeStrings("\uD83D")).toBe("\uFFFD");
  });

  test("孤立低位 surrogate → U+FFFD", () => {
    expect(sanitizeStrings("\uDE00")).toBe("\uFFFD");
  });

  test("混合：正常字符 + 孤立 + 完整 pair", () => {
    const input = "abc\uD83D\uDE10\uDE00xyz";
    // 😐 保留，孤立低位替换
    expect(sanitizeStrings(input)).toBe("abc\uD83D\uDE10\uFFFDxyz");
  });

  test("嵌套对象中所有字符串递归清理", () => {
    const input = {
      text: "\uD83D",
      nested: { deep: "\uDE00" },
      arr: ["keep", "\uD83D\uDE10", "\uDE00"],
      num: 42,
      bool: true,
      nil: null,
    };
    const output = sanitizeStrings(input) as typeof input;
    expect(output.text).toBe("\uFFFD");
    expect(output.nested.deep).toBe("\uFFFD");
    expect(output.arr[0]).toBe("keep");
    expect(output.arr[1]).toBe("\uD83D\uDE10"); // 完整 pair 保留
    expect(output.arr[2]).toBe("\uFFFD");
    expect(output.num).toBe(42);
    expect(output.bool).toBe(true);
    expect(output.nil).toBeNull();
  });

  test("JSON.stringify 输出可被解析", () => {
    const cleaned = sanitizeStrings({ msg: "\uD83D\uDE10 normal \uDE00 end" });
    const json = JSON.stringify(cleaned);
    // 反序列化应成功
    const parsed = JSON.parse(json);
    expect(parsed.msg).toBe("\uD83D\uDE10 normal \uFFFD end");
  });

  test("原始对象不被修改（不可变）", () => {
    const original = { a: "\uD83D", b: [1, 2] };
    const cleaned = sanitizeStrings(original);
    expect(original.a).toBe("\uD83D"); // 原始值未变
    expect((cleaned as typeof original).a).toBe("\uFFFD");
  });
});
