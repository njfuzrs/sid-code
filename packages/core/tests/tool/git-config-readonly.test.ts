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
} from "@sid-code/core/tool/bash/read-only-validation.ts";

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
 * git 全局选项与只读判定。两类选项刻意区别对待：
 *
 * - **不改变「用哪个仓库」的**（`--no-pager` / `--namespace` 等）剥离后保持只读，
 *   避免纯读命令白弹确认；
 * - **改变「用哪个仓库」的**（`-C` / `--git-dir` / `--work-tree` / `--bare`）**不剥离**，
 *   一律判非只读 —— `git -C <恶意目录> status` 与 `cd <恶意目录> && git status` 是同一件事，
 *   都会借目录里的 git 配置/钩子执行代码，所以 `cd` 判非只读时 `-C` 不能例外。
 *   `git -C <本仓内目录>` 的放行在**权限层**补回（`permission/readonly-git-boundary.ts`），
 *   不属于这一层的口径。
 * - `-c k=v` 等能注入配置的选项同样**必须**判非只读
 *   （`-c core.pager='sh -c evil'`、`-c alias.x='!evil'` 可借只读子命令执行任意代码）。
 */
describe("git 全局选项的只读判定", () => {
  test("不影响仓库归属的全局选项被剥离，只读语义保持", () => {
    expect(isReadOnlyCommand("git --no-pager diff")).toBe(true);
    expect(isReadOnlyCommand("git --no-pager status")).toBe(true);
    expect(isReadOnlyCommand("git --namespace ns log")).toBe(true);
    expect(isReadOnlyCommand("git --version")).toBe(true);
  });

  test("换仓库类全局选项判非只读（B2，权限层再补回本仓内的 -C）", () => {
    expect(isReadOnlyCommand("git -C /tmp log")).toBe(false);
    expect(isReadOnlyCommand("git -C /tmp status")).toBe(false);
    expect(isReadOnlyCommand("git --git-dir=/tmp/.git log")).toBe(false);
    expect(isReadOnlyCommand("git --work-tree=/tmp status")).toBe(false);
    expect(isReadOnlyCommand("git --bare log")).toBe(false);
    expect(isReadOnlyCommand("git -C /tmp config --list")).toBe(false);
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
    expect(stripSafeGitGlobalOptions(["--no-pager", "diff"])).toEqual(["diff"]);
    expect(stripSafeGitGlobalOptions(["--namespace", "ns", "log"])).toEqual(["log"]);
    expect(stripSafeGitGlobalOptions(["status"])).toEqual(["status"]);
    // 换仓库类选项不剥 → null（B2：`-C <恶意目录> status` 与 `cd <恶意目录> && git status` 等价）
    expect(stripSafeGitGlobalOptions(["-C", "/tmp", "log"])).toBeNull();
    expect(stripSafeGitGlobalOptions(["--git-dir=/x/.git", "status"])).toBeNull();
    expect(stripSafeGitGlobalOptions(["--work-tree=/tmp", "status"])).toBeNull();
    expect(stripSafeGitGlobalOptions(["--bare", "log"])).toBeNull();
    // 不可信选项 → null（调用方判非只读）
    expect(stripSafeGitGlobalOptions(["-c", "core.pager=cat", "status"])).toBeNull();
    expect(stripSafeGitGlobalOptions(["--config-env=X=Y", "status"])).toBeNull();
    // 子命令自身的 flag 不被剥离
    expect(stripSafeGitGlobalOptions(["--no-pager", "push", "--force"])).toEqual([
      "push",
      "--force",
    ]);
  });
});
