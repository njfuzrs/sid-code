/**
 * P0-2：危险 git 变体运行时硬拦截
 *
 * 验证 checker.ts 的 DANGEROUS_PATTERNS（从 git-danger-patterns.ts 单一事实源展开）
 * 能对 force push / reset --hard / --no-verify / clean -f / checkout . / branch -D /
 * stash drop / core.hooksPath / --amend 触发确认，且不误伤安全变体（git push / clean -n）。
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { matchGitDanger } from "../../src/permission/git-danger-patterns.ts";

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
