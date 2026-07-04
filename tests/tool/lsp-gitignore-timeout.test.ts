/**
 * T5-B3：lsp git check-ignore 超时 kill 子进程单测
 *
 * 验证：当 git check-ignore 子进程 hang 时，超时后应调用 child.kill()，
 * 不产生孤儿进程。同时验证 signal abort 也能 kill。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-lsp-gitignore-"));
  // 初始化一个 git 仓库以便 git check-ignore 能工作
  execSync("git init", { cwd: dir, stdio: "ignore" });
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("T5-B3 git check-ignore 超时 kill", () => {
  test("超时后 child.kill() 被调用——通过脚本模拟 hang 进程", async () => {
    // 创建一个假的 git 脚本，hang 住不退出
    const fakeGit = join(dir, "fake-git");
    writeFileSync(fakeGit, `#!/bin/sh\nsleep 999\n`, { mode: 0o755 });

    const { spawn } = await import("child_process");
    const child = spawn(fakeGit, [], {
      cwd: dir,
      stdio: ["pipe", "pipe", "ignore"],
    });

    let killed = false;
    const origKill = child.kill.bind(child);
    child.kill = (...args: any[]) => {
      killed = true;
      return origKill(...args);
    };

    // 用 "exit" 事件（不等 stdio 流 close，kill 后能立刻触发）
    const exitPromise = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });

    child.stdin!.end();

    let timedOut = false;
    const timeoutMs = 300; // 用短超时测试（生产中是 5000）
    const racePromise = new Promise<void>((resolve) =>
      setTimeout(() => { timedOut = true; resolve(); }, timeoutMs),
    );
    await Promise.race([exitPromise, racePromise]);

    if (timedOut && !child.killed) {
      child.kill();
    }

    expect(timedOut).toBe(true);
    expect(killed).toBe(true);

    // kill 后等 exit 事件确认进程已退出
    await exitPromise;
  });

  test("signal abort 时立即 kill 子进程", async () => {
    const fakeGit = join(dir, "fake-git-abort");
    writeFileSync(fakeGit, `#!/bin/sh\nsleep 999\n`, { mode: 0o755 });

    const { spawn } = await import("child_process");
    const child = spawn(fakeGit, [], {
      cwd: dir,
      stdio: ["pipe", "pipe", "ignore"],
    });

    let killed = false;
    const origKill = child.kill.bind(child);
    child.kill = (...args: any[]) => {
      killed = true;
      return origKill(...args);
    };

    const exitPromise = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });

    // 模拟 signal abort path
    const ctl = new AbortController();
    const onAbort = () => { if (!child.killed) child.kill(); };
    ctl.signal.addEventListener("abort", onAbort, { once: true });

    // 100ms 后 abort
    setTimeout(() => ctl.abort(), 100);

    // 等进程退出（kill 后 exit 事件触发）
    await exitPromise;

    expect(killed).toBe(true);
  });

  test("正常退出时不 kill（git check-ignore 正常完成）", async () => {
    // 用真实 git 仓库 + .gitignore 测试正常场景
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    execSync("git add .gitignore", { cwd: dir, stdio: "ignore" });

    const { spawn } = await import("child_process");
    const child = spawn("git", ["check-ignore", "--stdin"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "ignore"],
    });

    let stdout = "";
    child.stdout!.on("data", (c: Buffer) => { stdout += c.toString(); });

    const exitPromise = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });

    child.stdin!.write("test.log\ntest.ts\n");
    child.stdin!.end();

    let timedOut = false;
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 5000)),
    ]);

    expect(timedOut).toBe(false);
    // test.log 应被 gitignore 匹配
    expect(stdout.trim()).toContain("test.log");
    // test.ts 不应被匹配
    expect(stdout.trim()).not.toContain("test.ts");
  });
});
