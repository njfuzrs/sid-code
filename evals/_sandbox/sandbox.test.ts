/**
 * sandbox 单测（T-20）
 */
import { describe, test, expect } from "bun:test";
import { runSandbox } from "./index";

describe("runSandbox", () => {
  test("写文件 + 执行 echo 命令 → exit 0 + 输出符合预期", async () => {
    const r = await runSandbox({
      files: [{ path: "hello.txt", content: "hello world" }],
      commands: [{ cmd: "cat", args: ["hello.txt"] }],
    });
    expect(r.allOk).toBe(true);
    expect(r.exec).toHaveLength(1);
    expect(r.exec[0].exitCode).toBe(0);
    expect(r.exec[0].stdout).toContain("hello world");
    expect(r.cleaned).toBe(true);
  });

  test("非 0 退出码 → allOk=false", async () => {
    const r = await runSandbox({
      files: [],
      commands: [{ cmd: "sh", args: ["-c", "exit 7"] }],
    });
    expect(r.allOk).toBe(false);
    expect(r.exec[0].exitCode).toBe(7);
  });

  test("超时 → timedOut=true 且后续命令不再跑", async () => {
    const r = await runSandbox({
      files: [],
      commands: [
        { cmd: "sh", args: ["-c", "sleep 10"] },
        { cmd: "echo", args: ["should-not-run"] },
      ],
      sandbox: { timeoutMs: 500 },
    });
    expect(r.exec[0].timedOut).toBe(true);
    expect(r.exec).toHaveLength(1); // 第二个命令没跑
    expect(r.allOk).toBe(false);
  });

  test("拒绝越界路径（防止 ../../../etc 注入）", async () => {
    let err: Error | null = null;
    try {
      await runSandbox({
        files: [{ path: "../../../etc/evil", content: "x" }],
        commands: [],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("越界");
  });

  test("多文件 + 多命令链", async () => {
    const r = await runSandbox({
      files: [
        { path: "a.txt", content: "alpha" },
        { path: "sub/b.txt", content: "beta" },
      ],
      commands: [
        { cmd: "cat", args: ["a.txt"] },
        { cmd: "cat", args: ["sub/b.txt"] },
      ],
    });
    expect(r.allOk).toBe(true);
    expect(r.exec).toHaveLength(2);
    expect(r.exec[0].stdout).toContain("alpha");
    expect(r.exec[1].stdout).toContain("beta");
  });

  test("不存在的命令 → exitCode=-1（spawn error 兜底）", async () => {
    const r = await runSandbox({
      files: [],
      commands: [{ cmd: "nonexistent-cmd-xyz-zzz", args: [] }],
    });
    expect(r.allOk).toBe(false);
    expect(r.exec[0].exitCode).toBe(-1);
  });

  test("keepTmp=true 保留临时目录", async () => {
    const r = await runSandbox({
      files: [{ path: "x.txt", content: "kept" }],
      commands: [],
      sandbox: { keepTmp: true },
    });
    expect(r.cleaned).toBe(false);
    // workdir 仍可读
    const { existsSync, rmSync } = await import("node:fs");
    expect(existsSync(r.workdir)).toBe(true);
    rmSync(r.workdir, { recursive: true, force: true });
  });
});
