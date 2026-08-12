/**
 * P0-2：危险 git 变体运行时硬拦截
 *
 * 验证 checker.ts 的 DANGEROUS_PATTERNS（从 git-danger-patterns.ts 单一事实源展开）
 * 能对 force push / reset --hard / --no-verify / clean -f / checkout . / branch -D /
 * stash drop / core.hooksPath / --amend 触发确认，且不误伤安全变体（git push / clean -n）。
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import {
  matchGitDanger,
  normalizeGitGlobalOptions,
} from "@sid-code/core/permission/git-danger-patterns.ts";

async function check(command: string, cfgOverride: Record<string, unknown> = {}) {
  const checker = new PermissionChecker({ ...defaultConfig(), ...cfgOverride });
  return checker.check({ toolName: "bash", input: { command } });
}

describe("P0-2 危险 git 变体硬拦截", () => {
  test("git reset --hard 需确认", async () => {
    const r = await check("git reset --hard HEAD~1");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git push --force 需确认", async () => {
    const r = await check("git push --force origin feature");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git push --force-with-lease 需确认", async () => {
    const r = await check("git push --force-with-lease origin feature");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git push -f 到 main 命中（保留可确认能力）", async () => {
    const r = await check("git push -f origin main");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git commit --no-verify 需确认", async () => {
    const r = await check("git commit --no-verify -m 'x'");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git clean -fd 需确认", async () => {
    const r = await check("git clean -fd");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git checkout . 需确认", async () => {
    const r = await check("git checkout .");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git branch -D 需确认", async () => {
    const r = await check("git branch -D feature");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git stash drop 需确认", async () => {
    const r = await check("git stash drop");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("core.hooksPath 劫持需确认", async () => {
    const r = await check("git config --global core.hooksPath /tmp/evil");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("git commit --amend 需确认（medium 兜底）", async () => {
    const r = await check("git commit --amend -m 'x'");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  // ── 负向用例（防误报）──
  test("git clean -n（dry-run）不触发", async () => {
    expect(matchGitDanger("git clean -n")).toBeNull();
    expect(matchGitDanger("git clean --dry-run")).toBeNull();
  });

  test("普通 git push 不命中危险模式", async () => {
    expect(matchGitDanger("git push origin main")).toBeNull();
  });

  test("git checkout branch（非 .）不命中丢弃改动模式", async () => {
    expect(matchGitDanger("git checkout main")).toBeNull();
  });

  // ── 自动模式不被绕过 ──
  test("acceptEdits 模式下 git reset --hard 仍需确认", async () => {
    const r = await check("git reset --hard", { permissionMode: "acceptEdits" });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("yesMode 下 git push --force 仍需确认", async () => {
    const r = await check("git push --force origin main", { yesMode: true });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  // ── 复合命令拆分继承 ──
  test("复合命令后段 git push --force 也命中", async () => {
    const r = await check("ls && git push --force origin main");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });
});

/**
 * git 全局选项绕过（安全回归）：git 允许在子命令**之前**插入 `-c k=v` / `-C dir` /
 * `--no-pager` 等全局选项，这会把子命令与 `git` 撑开，使 `\bgit\s+<子命令>` 正则全部失配。
 * 修复前 `git -c core.pager=cat reset --hard` 在 yesMode/acceptEdits 下被静默放行。
 */
describe("git 全局选项不能绕过危险检测", () => {
  test("normalizeGitGlobalOptions 剥离全局选项", () => {
    expect(normalizeGitGlobalOptions("git -c core.pager=cat reset --hard")).toBe(
      "git reset --hard",
    );
    expect(normalizeGitGlobalOptions("git -C /tmp push --force origin main")).toBe(
      "git push --force origin main",
    );
    expect(normalizeGitGlobalOptions("git --no-pager clean -fd")).toBe("git clean -fd");
    expect(normalizeGitGlobalOptions("git --git-dir=/tmp/.git clean -fd")).toBe("git clean -fd");
    expect(normalizeGitGlobalOptions("git -c a=b -C /d -P stash drop")).toBe("git stash drop");
    expect(normalizeGitGlobalOptions("ls && git -c x=y reset --hard")).toBe(
      "ls && git reset --hard",
    );
  });

  test("normalizeGitGlobalOptions 不吞子命令自身 flag", () => {
    expect(normalizeGitGlobalOptions("git commit --no-verify")).toBe("git commit --no-verify");
    expect(normalizeGitGlobalOptions("git push --force")).toBe("git push --force");
    expect(normalizeGitGlobalOptions("git reset --hard")).toBe("git reset --hard");
    // 无全局选项时原样返回（零开销路径）
    expect(normalizeGitGlobalOptions("git status")).toBe("git status");
  });

  test("matchGitDanger 覆盖全局选项变体", () => {
    expect(matchGitDanger("git -c core.pager=cat reset --hard")?.name).toBe("git 硬重置");
    expect(matchGitDanger("git -C /tmp push --force origin main")?.name).toBe(
      "git 强制推送 main/master",
    );
    expect(matchGitDanger("git --no-pager clean -fd")?.name).toBe("git 清理未跟踪文件");
  });

  test("yesMode 下 git -c ... reset --hard 仍需确认（此前被放行）", async () => {
    const r = await check("git -c core.pager=cat reset --hard HEAD~1", { yesMode: true });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("acceptEdits 下 git -C dir push --force 仍需确认（此前被放行）", async () => {
    const r = await check("git -C /tmp push --force origin main", {
      permissionMode: "acceptEdits",
    });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("复合命令 + 全局选项组合仍命中", async () => {
    const r = await check("ls && git -c x=y clean -fdx", { yesMode: true });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("安全 git 命令不因归一化误报", () => {
    expect(matchGitDanger("git -C /tmp status")).toBeNull();
    expect(matchGitDanger("git --no-pager log --oneline")).toBeNull();
    expect(matchGitDanger("git --version")).toBeNull();
  });
});
