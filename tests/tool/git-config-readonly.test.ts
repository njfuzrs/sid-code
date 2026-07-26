/**
 * P0-1：git config 写操作不再被误判只读
 *
 * 背景：旧实现把整个 `config` 子命令列为只读 → `git config user.email x` 等写操作
 * 被自动放行，违反「NEVER 更新 git config」安全协议（含 core.hooksPath 劫持）。
 */

import { describe, test, expect } from "bun:test";
import {
  isReadOnlyCommand,
  isReadOnlyGitConfig,
  stripSafeGitGlobalOptions,
} from "../../src/tool/bash/read-only-validation.ts";

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

/**
 * git 全局选项与只读判定：`-C dir` / `--no-pager` 等无副作用选项应被剥离（保持只读，
 * 避免纯读命令白弹确认）；`-c k=v` 等能注入配置的选项**必须**判非只读
 * （`-c core.pager='sh -c evil'`、`-c alias.x='!evil'` 可借只读子命令执行任意代码）。
 */
describe("git 全局选项的只读判定", () => {
  test("安全全局选项被剥离，只读语义保持", () => {
    expect(isReadOnlyCommand("git -C /tmp log")).toBe(true);
    expect(isReadOnlyCommand("git -C /tmp status")).toBe(true);
    expect(isReadOnlyCommand("git --no-pager diff")).toBe(true);
    expect(isReadOnlyCommand("git --git-dir=/tmp/.git log")).toBe(true);
    expect(isReadOnlyCommand("git -C /tmp config --list")).toBe(true);
    expect(isReadOnlyCommand("git --version")).toBe(true);
  });

  test("-c 注入类全局选项一律判非只读（可执行任意代码）", () => {
    expect(isReadOnlyCommand("git -c core.pager=cat status")).toBe(false);
    expect(isReadOnlyCommand("git -c core.pager='sh -c evil' log")).toBe(false);
    expect(isReadOnlyCommand("git -c alias.x='!evil' status")).toBe(false);
    expect(isReadOnlyCommand("git --exec-path=/tmp/evil status")).toBe(false);
  });

  test("全局选项不能把危险子命令洗成只读", () => {
    expect(isReadOnlyCommand("git -C /tmp push --force")).toBe(false);
    expect(isReadOnlyCommand("git --no-pager reset --hard")).toBe(false);
    expect(isReadOnlyCommand("git -C /tmp clean -fd")).toBe(false);
    expect(isReadOnlyCommand("git -C /tmp config core.hooksPath /tmp/evil")).toBe(false);
  });

  test("stripSafeGitGlobalOptions 直接单测", () => {
    expect(stripSafeGitGlobalOptions(["-C", "/tmp", "log"])).toEqual(["log"]);
    expect(stripSafeGitGlobalOptions(["--no-pager", "diff"])).toEqual(["diff"]);
    expect(stripSafeGitGlobalOptions(["--git-dir=/x/.git", "status"])).toEqual(["status"]);
    expect(stripSafeGitGlobalOptions(["status"])).toEqual(["status"]);
    // 不可信选项 → null（调用方判非只读）
    expect(stripSafeGitGlobalOptions(["-c", "core.pager=cat", "status"])).toBeNull();
    expect(stripSafeGitGlobalOptions(["--config-env=X=Y", "status"])).toBeNull();
    // 子命令自身的 flag 不被剥离
    expect(stripSafeGitGlobalOptions(["-C", "/tmp", "push", "--force"])).toEqual(["push", "--force"]);
  });
});
