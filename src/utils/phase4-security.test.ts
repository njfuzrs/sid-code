/**
 * Phase 4 安全层单测
 * 覆盖：sanitization（Unicode 净化）+ path-validator 的 Unicode/Windows 绕过检测
 */

import { describe, test, expect } from "bun:test";
import { sanitizeUnicode, hasDangerousUnicode } from "./sanitization.ts";
import { PathValidator } from "../permission/path-validator.ts";

describe("sanitizeUnicode", () => {
  test("移除零宽非连接符 (U+200C)", () => {
    const dirty = "safe‌_file.txt"; // safe + ZWNJ + _file
    const clean = sanitizeUnicode(dirty);
    expect(clean).toBe("safe_file.txt");
    expect(clean.length).toBeLessThan(dirty.length);
  });

  test("移除零宽空格 (U+200B) 和方向控制符 (U+202E)", () => {
    expect(sanitizeUnicode("a​b")).toBe("ab");
    expect(sanitizeUnicode("a‮b")).toBe("ab");
  });

  test("保留合法中文/日文/emoji", () => {
    expect(sanitizeUnicode("文件名.txt")).toBe("文件名.txt");
    expect(sanitizeUnicode("ファイル")).toBe("ファイル");
    // emoji 不属于 Cf/Co，应保留
    expect(sanitizeUnicode("ok✅")).toBe("ok✅");
  });

  test("NFKC 规范化兼容字符", () => {
    // 全角数字 → 半角（NFKC）
    expect(sanitizeUnicode("１２３")).toBe("123");
  });

  test("普通 ASCII 不变", () => {
    expect(sanitizeUnicode("/usr/local/bin")).toBe("/usr/local/bin");
  });
});

describe("hasDangerousUnicode", () => {
  test("检测零宽字符", () => {
    expect(hasDangerousUnicode("a‌b")).toBe(true);
    expect(hasDangerousUnicode("a​b")).toBe(true);
  });

  test("正常字符串返回 false", () => {
    expect(hasDangerousUnicode("normal_file.txt")).toBe(false);
    expect(hasDangerousUnicode("中文文件")).toBe(false);
  });

  test("多次调用结果稳定（无 lastIndex 副作用）", () => {
    const s = "a‌b";
    expect(hasDangerousUnicode(s)).toBe(true);
    expect(hasDangerousUnicode(s)).toBe(true); // 第二次仍为 true
  });
});

describe("PathValidator — Unicode/Windows 绕过检测", () => {
  const validator = new PathValidator("/tmp/workspace");

  test("拦截含零宽字符的路径", () => {
    const r = validator.validateAccess("/tmp/workspace/safe‌.txt", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Unicode");
  });

  test("拦截 NTFS 备用数据流", () => {
    const r = validator.validateAccess("/tmp/workspace/file.txt::$DATA", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("NTFS");
  });

  test("拦截 8.3 短名称", () => {
    const r = validator.validateAccess("/tmp/PROGRA~1/x.txt", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("8.3");
  });

  test("拦截 DOS 设备名", () => {
    const r = validator.validateAccess("/tmp/workspace/CON", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("DOS");
  });

  test("拦截尾随空格", () => {
    const r = validator.validateAccess("/tmp/workspace/file.txt ", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("尾随");
  });

  test("正常路径不被新增的 Unicode/Windows 检查误伤", () => {
    // 不依赖工作区是否真实存在——只验证「干净路径不会因新规则被拦」。
    // 用一个不会命中黑名单/敏感文件的只读路径，断言 reason 不来自新检查。
    const r = validator.validateAccess("/tmp/workspace/normal.txt", "read");
    const newCheckReasons = ["Unicode", "NTFS", "8.3", "DOS", "尾随", "长路径"];
    const hitNewCheck = newCheckReasons.some((k) => r.reason?.includes(k));
    expect(hitNewCheck).toBe(false);
  });

  test("普通含点路径（.. 相对引用片段）不命中尾随点规则", () => {
    // "a..b.txt" 中间有点、结尾是正常字符，不应命中尾随点/空格规则
    const r = validator.validateAccess("/tmp/workspace/a..b.txt", "read");
    expect(r.reason ?? "").not.toContain("尾随");
  });
});
