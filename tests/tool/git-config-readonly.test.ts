/**
 * P0-1：git config 写操作不再被误判只读
 *
 * 背景：旧实现把整个 `config` 子命令列为只读 → `git config user.email x` 等写操作
 * 被自动放行，违反「NEVER 更新 git config」安全协议（含 core.hooksPath 劫持）。
 */

import { describe, test, expect } from "bun:test";
import { isReadOnlyCommand, isReadOnlyGitConfig } from "../../src/tool/bash/read-only-validation.ts";

describe("P0-1 git config 只读细分", () => {
  test("读取形态判只读", () => {
    expect(isReadOnlyCommand("git config --get user.name")).toBe(true);
    expect(isReadOnlyCommand("git config --get-all remote.origin.url")).toBe(true);
    expect(isReadOnlyCommand("git config --list")).toBe(true);
    expect(isReadOnlyCommand("git config -l")).toBe(true);
    expect(isReadOnlyCommand("git config --get-regexp '^user'")).toBe(true);
    // 隐式读取单个 key
    expect(isReadOnlyCommand("git config user.name")).toBe(true);
  });

  test("写入形态判非只读", () => {
    expect(isReadOnlyCommand("git config user.email x@y.com")).toBe(false);
    expect(isReadOnlyCommand("git config --global user.name Attacker")).toBe(false);
    expect(isReadOnlyCommand("git config --add remote.origin.url http://evil")).toBe(false);
    expect(isReadOnlyCommand("git config --unset user.name")).toBe(false);
    expect(isReadOnlyCommand("git config --replace-all core.editor vim")).toBe(false);
    expect(isReadOnlyCommand("git config --edit")).toBe(false);
  });

  test("core.hooksPath 劫持判非只读（含 --global）", () => {
    expect(isReadOnlyCommand("git config --global core.hooksPath /tmp/evil")).toBe(false);
    expect(isReadOnlyCommand("git config core.hooksPath /tmp/evil")).toBe(false);
  });

  test("isReadOnlyGitConfig 直接单测", () => {
    expect(isReadOnlyGitConfig(["--get", "user.name"])).toBe(true);
    expect(isReadOnlyGitConfig(["--list"])).toBe(true);
    expect(isReadOnlyGitConfig(["user.email", "x@y.com"])).toBe(false);
    expect(isReadOnlyGitConfig(["--global", "core.hooksPath", "/tmp/evil"])).toBe(false);
    expect(isReadOnlyGitConfig(["--unset", "user.name"])).toBe(false);
    // --file <path> 后的值不算 key/value
    expect(isReadOnlyGitConfig(["--file", "/tmp/cfg", "--list"])).toBe(true);
  });

  test("其它只读 git 子命令不受影响", () => {
    expect(isReadOnlyCommand("git status")).toBe(true);
    expect(isReadOnlyCommand("git log --oneline")).toBe(true);
    expect(isReadOnlyCommand("git diff")).toBe(true);
  });
});
