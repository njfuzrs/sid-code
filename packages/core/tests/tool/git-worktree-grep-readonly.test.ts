/**
 * PR-2（B8）：`git worktree list` 与 `git grep` 的只读判定
 *
 * 背景：对齐 CC 的只读 git 表时，sid 的两条纯读子命令被判成非只读、白弹确认。
 * 但这两条**不能**简单地加进 `READ_ONLY_GIT_SUBCOMMANDS`：
 * - `git worktree` 只有 `list` 是读，其余（add/remove/prune/move/lock/unlock/repair）改状态；
 * - `git grep` 的 `-O<orderfile>` 与 `--open-files-in-pager[=<pager>]` 能**执行任意程序**。
 *
 * 所以两组都按参数细分，本文件锁住两侧：该放行的放行、该拦的一个不放。
 */

import { describe, test, expect } from "bun:test";
import {
  isReadOnlyCommand,
  isReadOnlyGitGrep,
  isReadOnlyGitWorktree,
} from "@sid-code/core/tool/bash/read-only-validation.ts";

describe("git worktree：只有 list 是只读", () => {
  test("list 及其只读选项", () => {
    for (const cmd of [
      "git worktree list",
      "git worktree list --porcelain",
      "git worktree list -v",
      "git worktree list --verbose",
      "git worktree list -z",
      "git worktree list --porcelain -z",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  test("其余子命令一律非只读", () => {
    for (const cmd of [
      "git worktree add ../x",
      "git worktree remove ../x",
      "git worktree remove --force ../x",
      "git worktree prune",
      "git worktree move a b",
      "git worktree lock ../x",
      "git worktree unlock ../x",
      "git worktree repair",
      // 无子命令只打印用法，但保守判非只读
      "git worktree",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  test("未知选项不放过", () => {
    expect(isReadOnlyGitWorktree(["list", "--expire", "now"])).toBe(false);
    expect(isReadOnlyCommand("git worktree list --expire now")).toBe(false);
  });
});

describe("git grep：白名单放行 + 执行口子必须拦住", () => {
  test("常见只读形态放行", () => {
    for (const cmd of [
      "git grep foo",
      "git grep -n foo",
      "git grep -i foo -- src",
      "git grep -l foo",
      "git grep -e foo -- README.md",
      "git grep -E 'a|b' -- src",
      "git grep -A3 foo",
      "git grep -A 3 foo",
      "git grep --max-count=10 foo",
      "git grep --cached foo",
      "git grep -n foo -- 'src/*.ts'",
      "git grep --color=always foo",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  test("能执行任意程序的 flag 必须拦住", () => {
    for (const cmd of [
      "git grep -O orderfile foo",
      "git grep -Oorderfile foo",
      "git grep --open-files-in-pager foo",
      "git grep --open-files-in-pager=less foo",
      // 未知 flag 一律非只读，防止未来 git 加了新的执行口子
      "git grep --unknown-flag foo",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  test("绕开权限层路径校验的形态：等 B5 落地前一律不放行", () => {
    for (const cmd of [
      "git grep -f patterns.txt",
      "git grep --file=patterns.txt",
      "git grep --no-index foo /etc",
      "git grep --untracked foo",
      "git grep --pathspec-from-file=list.txt",
      // pathspec 越出仓库
      "git grep foo -- ../outside",
      "git grep foo -- /etc",
      "git grep foo -- ~/x",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  test("`--` 之后的 pathspec 只做「不出仓库」的粗判", () => {
    expect(isReadOnlyGitGrep(["foo", "--", "src/a.ts"])).toBe(true);
    expect(isReadOnlyGitGrep(["foo", "--", "../a.ts"])).toBe(false);
    expect(isReadOnlyGitGrep(["foo", "--", "/etc/passwd"])).toBe(false);
  });

  test("`-e` 的值可以是选项样式", () => {
    expect(isReadOnlyGitGrep(["-e", "--foo"])).toBe(true);
    // 其他带值 flag 缺少值时判非只读（git 会报错，但不值得放行）
    expect(isReadOnlyGitGrep(["-A"])).toBe(false);
  });
});

describe("git ls-remote 保持非只读（刻意不放开）", () => {
  // 它会发起网络请求；是否算「只读」取决于部署环境（内网出口 / 凭据提示），
  // 本 PR 不放开，否决理由记在 rejected Note 里。
  test("仍判非只读", () => {
    expect(isReadOnlyCommand("git ls-remote origin")).toBe(false);
    expect(isReadOnlyCommand("git ls-remote --heads origin")).toBe(false);
  });
});
