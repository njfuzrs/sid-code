/**
 * Worktree slug 校验与扁平化单测（P0-4 / B5）
 */

import { describe, it, expect } from "bun:test";
import {
  validateWorktreeSlug,
  flattenSlug,
  unflattenSlug,
  branchNameForSlug,
  MAX_SLUG_LENGTH,
} from "../../src/worktree/slug.ts";

describe("validateWorktreeSlug", () => {
  it("接受合法 slug", () => {
    for (const s of ["feature", "brave-eagle-42", "user/feature", "a.b_c-d", "v1.2.3"]) {
      expect(validateWorktreeSlug(s).valid).toBe(true);
    }
  });

  it("拒绝空串", () => {
    expect(validateWorktreeSlug("").valid).toBe(false);
  });

  it("拒绝超长 slug", () => {
    const long = "a".repeat(MAX_SLUG_LENGTH + 1);
    expect(validateWorktreeSlug(long).valid).toBe(false);
  });

  it("拒绝路径穿越 ..", () => {
    expect(validateWorktreeSlug("..").valid).toBe(false);
    expect(validateWorktreeSlug("a/../b").valid).toBe(false);
    expect(validateWorktreeSlug("../etc").valid).toBe(false);
  });

  it("拒绝绝对路径", () => {
    expect(validateWorktreeSlug("/etc/passwd").valid).toBe(false);
  });

  it("拒绝单独的 .", () => {
    expect(validateWorktreeSlug(".").valid).toBe(false);
    expect(validateWorktreeSlug("a/./b").valid).toBe(false);
  });

  it("拒绝反斜杠与空字节", () => {
    expect(validateWorktreeSlug("a\\b").valid).toBe(false);
    expect(validateWorktreeSlug("a\0b").valid).toBe(false);
  });

  it("拒绝非法字符", () => {
    expect(validateWorktreeSlug("a b").valid).toBe(false);
    expect(validateWorktreeSlug("a$b").valid).toBe(false);
    expect(validateWorktreeSlug("a;rm -rf").valid).toBe(false);
  });

  it("拒绝空段", () => {
    expect(validateWorktreeSlug("a//b").valid).toBe(false);
    expect(validateWorktreeSlug("/a").valid).toBe(false);
  });

  it("拒绝 Windows 驱动器号", () => {
    expect(validateWorktreeSlug("C:").valid).toBe(false);
  });
});

describe("flattenSlug / unflattenSlug", () => {
  it("/ → + 扁平化", () => {
    expect(flattenSlug("user/feature")).toBe("user+feature");
    expect(flattenSlug("a/b/c")).toBe("a+b+c");
  });

  it("无 / 时不变", () => {
    expect(flattenSlug("brave-eagle-42")).toBe("brave-eagle-42");
  });

  it("含 / 的 slug 可逆", () => {
    const s = "user/feature";
    expect(unflattenSlug(flattenSlug(s))).toBe(s);
  });

  it("纯函数：同输入同输出", () => {
    expect(flattenSlug("x/y")).toBe(flattenSlug("x/y"));
  });
});

describe("branchNameForSlug", () => {
  it("加 worktree- 前缀", () => {
    expect(branchNameForSlug("user+feature")).toBe("worktree-user+feature");
  });
});
