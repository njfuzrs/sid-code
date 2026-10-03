/**
 * B43：无人值守链路实测里暴露的缺陷，逐条钉成回归测试。
 *
 *   - 浅克隆后 `origin/base...HEAD` 拿不到 merge-base，webhook job 在 fork 之前就报错
 *   - prompt（含整个 PR diff）走 argv，超 ARG_MAX 时 spawn E2BIG
 *   - 验签通过但 body 不是 JSON → 未捕获异常（500）
 *   （`daemon start` 不传 --webhook 被解析成 false 的那条在 cli/tests/command/daemon-args.test.ts）
 *   - 无头模式日志走 stdout，`--output-format json` 消费方拿到的是一坨日志
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCloneWorkspaceProvider } from "@sid-code/core/daemon/workspace.ts";
import { HeadlessExecutor } from "@sid-code/core/daemon/headless-executor.ts";
import { createDaemonServer } from "@sid-code/core/daemon/server.ts";
import { initLogger, getLogger, LogLevel } from "@sid-code/core/debug/logger.ts";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });

// 允许 file:// 克隆（webhook-signature.test 会把它收窄成仅 file，这里显式放开同一协议）
let prevProto: string | undefined;
beforeAll(() => {
  prevProto = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "file";
});
afterAll(() => {
  if (prevProto === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
  else process.env.GIT_ALLOW_PROTOCOL = prevProto;
});

/** 造一个上游仓库：main 两个提交，feature 从 main 分出再加两个提交 */
function makeUpstream(): string {
  const up = tmp("sid-b43-up-");
  git(up, "init", "-q", "-b", "main");
  git(up, "config", "user.email", "t@t");
  git(up, "config", "user.name", "t");
  writeFileSync(join(up, "a.txt"), "1\n");
  git(up, "add", ".");
  git(up, "commit", "-qm", "m1");
  writeFileSync(join(up, "a.txt"), "1\n2\n");
  git(up, "commit", "-qam", "m2");
  git(up, "checkout", "-qb", "feature");
  writeFileSync(join(up, "b.txt"), "feat\n");
  git(up, "add", ".");
  git(up, "commit", "-qm", "f1");
  writeFileSync(join(up, "b.txt"), "feat\nmore\n");
  git(up, "commit", "-qam", "f2");
  // main 继续前进：三点 diff 必须只含 feature 自己的改动
  git(up, "checkout", "-q", "main");
  writeFileSync(join(up, "c.txt"), "main-only\n");
  git(up, "add", ".");
  git(up, "commit", "-qm", "m3");
  return up;
}

describe("webhook 工作区：三点 diff 可用", () => {
  it("克隆 PR 分支后 fetch base，origin/base...HEAD 只含 PR 自己的改动", async () => {
    const up = makeUpstream();
    const ws = new GitCloneWorkspaceProvider(tmp("sid-b43-ws-"));
    await ws.prepare({ repo: `file://${up}`, branch: "feature" });
    const wd = ws.getWorkdir();
    // 与 worker.ts 完全相同的两条命令
    git(wd, "fetch", "--no-tags", "origin", "main");
    const diff = git(wd, "diff", "origin/main...HEAD");
    expect(diff).toContain("b.txt");
    expect(diff).not.toContain("c.txt");
    await ws.cleanup();
  });

  it("指定 commit 时能 checkout 到非分支头的提交", async () => {
    const up = makeUpstream();
    const f1 = git(up, "rev-parse", "feature~1").trim();
    const ws = new GitCloneWorkspaceProvider(tmp("sid-b43-ws-"));
    await ws.prepare({ repo: `file://${up}`, branch: "feature", commit: f1 });
    expect(git(ws.getWorkdir(), "rev-parse", "HEAD").trim()).toBe(f1);
    await ws.cleanup();
  });
});

describe("HeadlessExecutor：prompt 走 stdin", () => {
  it("超过 ARG_MAX 的 prompt 完整送达子进程，argv 里没有它", async () => {
    // 用一个假的 sid-code：把 argv 和 stdin 原样写进文件
    const d = tmp("sid-b43-exec-");
    const fake = join(d, "fake-sid.sh");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${d}/argv"\ncat > "${d}/stdin"\necho '{"content":[{"type":"text","text":"ok"}]}'\n`,
    );
    chmodSync(fake, 0o755);
    {
      const big = "x".repeat(2 * 1024 * 1024); // 2MB > macOS ARG_MAX 1MB
      const exec = new HeadlessExecutor({ resolveExecutable: () => ({ cmd: fake, baseArgs: [] }) });
      const r = await exec.run({
        jobId: "j",
        prompt: big,
        workspaceDir: d,
        timeoutMs: 30_000,
        source: "webhook",
      });
      expect(r.status).toBe("success");
      expect(r.output).toBe("ok");
      expect(readFileSync(join(d, "stdin"), "utf-8")).toBe(big);
      const argv = readFileSync(join(d, "argv"), "utf-8");
      expect(argv).not.toContain("xxxx");
      expect(argv).toContain("--permission-mode");
    }
  });
});

describe("webhook server：坏 JSON", () => {
  it("签名正确但 body 不是 JSON → 400 而不是 500", async () => {
    const d = tmp("sid-b43-srv-");
    const secret = "s";
    const server = createDaemonServer({
      port: 0,
      host: "127.0.0.1",
      max_concurrent: 1,
      webhook_secret: secret,
      workspace_base: join(d, "ws"),
      storage_type: "file",
      storage_path: join(d, "st"),
    });
    try {
      const body = "{bad";
      const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
      const res = await fetch(`http://127.0.0.1:${server.port}/webhook/github`, {
        method: "POST",
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": sig },
        body,
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});

describe("Logger consoleToStderr", () => {
  it("开启后 INFO 也走 stderr，stdout 保持干净", () => {
    const out: string[] = [];
    const err: string[] = [];
    const ol = console.log;
    const oe = console.error;
    console.log = (m: string) => out.push(m);
    console.error = (m: string) => err.push(m);
    try {
      initLogger({
        enabled: true,
        level: LogLevel.DEBUG,
        console: true,
        fileOnly: false,
        consoleToStderr: true,
      });
      getLogger().info("T", "hello-b43");
      getLogger().debug("T", "dbg-b43");
    } finally {
      console.log = ol;
      console.error = oe;
      initLogger({ enabled: false });
    }
    expect(out.join("")).not.toContain("b43");
    expect(err.join("")).toContain("hello-b43");
  });
});
