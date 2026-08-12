/**
 * grep type 归一/降级单测（事故 20260801-175042-699f69f8 回归）
 *
 * 事故现象：`rg: unrecognized file type: tsx` → 整次搜索失败（退出码 2）。
 * 本测试锁定的核心不变量：**任何 type 取值都不得让搜索硬失败**。
 */

import { describe, test, expect } from "bun:test";
import { resolveGrepType } from "@sid-code/core/tool/grep-type-alias.ts";

describe("合法 rg 类型原样透传", () => {
  test.each(["ts", "js", "py", "go", "rust", "typescript", "python", "cpp", "yaml", "sh", "md"])(
    "%s 原样透传且无提示",
    (t) => {
      const r = resolveGrepType(t);
      expect(r.rgType).toBe(t);
      expect(r.fallbackGlob).toBeNull();
      expect(r.notice).toBeNull();
    },
  );
});

describe("别名映射（事故直接成因）", () => {
  test("tsx → ts（rg 的 ts 已含 *.tsx）", () => {
    const r = resolveGrepType("tsx");
    expect(r.rgType).toBe("ts");
    expect(r.notice).toContain("ts");
  });

  test("jsx → js", () => {
    expect(resolveGrepType("jsx").rgType).toBe("js");
  });

  test.each([
    ["javascript", "js"],
    ["node", "js"],
    ["rs", "rust"],
    ["golang", "go"],
    ["yml", "yaml"],
    ["c++", "cpp"],
    ["shell", "sh"],
    ["bash", "sh"],
    ["dockerfile", "docker"],
    ["kt", "kotlin"],
    ["rb", "ruby"],
  ])("%s → %s", (input, expected) => {
    const r = resolveGrepType(input);
    expect(r.rgType).toBe(expected);
    expect(r.notice).not.toBeNull(); // 必须告知模型正确写法
  });
});

describe("大小写与空白容错", () => {
  test.each(["TSX", " tsx ", "Tsx", "TS"])("%s 可归一", (t) => {
    expect(resolveGrepType(t).rgType).not.toBeNull();
  });
});

describe("未知类型降级：绝不硬失败", () => {
  test("完全不认识的类型 → 不传 --type，仅提示", () => {
    const r = resolveGrepType("wubbalubba");
    expect(r.rgType).toBeNull();
    expect(r.fallbackGlob).toBeNull();
    expect(r.notice).toContain("已忽略");
  });

  test("降级提示里给出可行替代（glob / 正确类型名）", () => {
    const notice = resolveGrepType("wubbalubba").notice ?? "";
    expect(notice).toContain("glob");
  });
});

describe("边界输入", () => {
  test("undefined → 不传 --type、无提示", () => {
    const r = resolveGrepType(undefined);
    expect(r.rgType).toBeNull();
    expect(r.notice).toBeNull();
  });

  test("空串/纯空白 → 视为未传", () => {
    expect(resolveGrepType("").rgType).toBeNull();
    expect(resolveGrepType("   ").rgType).toBeNull();
    expect(resolveGrepType("   ").notice).toBeNull();
  });
});

describe("核心不变量：任何输入都不抛异常、都能给出可执行结论", () => {
  test.each([
    "tsx",
    "jsx",
    "ts",
    "",
    "   ",
    "!!!",
    "../../etc/passwd",
    "ts js",
    "TSX",
    "c++",
    "very-long-".repeat(40),
  ])("%p 不抛异常", (t) => {
    expect(() => resolveGrepType(t)).not.toThrow();
  });
});
