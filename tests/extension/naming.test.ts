/**
 * 扩展名称验证和清理测试
 */

import { describe, test, expect } from "bun:test";
import { sanitizeName, validateName } from "../../src/extension/naming.ts";

describe("sanitizeName", () => {
  test("替换非法字符为 -", () => {
    expect(sanitizeName("my:skill")).toBe("my-skill");
    expect(sanitizeName("my\\skill")).toBe("my-skill");
    expect(sanitizeName("my/skill")).toBe("my-skill");
    expect(sanitizeName('my"skill')).toBe("my-skill");
    expect(sanitizeName("my|skill")).toBe("my-skill");
  });

  test("替换空格为 -", () => {
    expect(sanitizeName("my skill")).toBe("my-skill");
    expect(sanitizeName("my  skill")).toBe("my-skill");
  });

  test("合法名称不变", () => {
    expect(sanitizeName("my-skill")).toBe("my-skill");
    expect(sanitizeName("my_skill")).toBe("my_skill");
    expect(sanitizeName("skill123")).toBe("skill123");
  });
});

describe("validateName", () => {
  test("合法 slug 返回 null", () => {
    expect(validateName("my-skill")).toBeNull();
    expect(validateName("skill123")).toBeNull();
    expect(validateName("a")).toBeNull();
    expect(validateName("test_skill")).toBeNull();
  });

  test("空名称返回错误", () => {
    expect(validateName("")).not.toBeNull();
  });

  test("非法首字符返回错误", () => {
    expect(validateName("-skill")).not.toBeNull();
    expect(validateName("_skill")).not.toBeNull();
  });

  test("超长名称返回错误", () => {
    const longName = "a".repeat(65);
    expect(validateName(longName)).not.toBeNull();
  });

  test("64 字符名称通过", () => {
    const name = "a".repeat(64);
    expect(validateName(name)).toBeNull();
  });
});
