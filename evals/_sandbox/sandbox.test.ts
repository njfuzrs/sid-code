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

  // ============================================================================
  // §15.3 S5 铁律 sandbox 边界测试清单（B5-3 prereq）
  // ============================================================================

  test("§15.3-1 tmpdir cleanup：keepTmp=false 时 workdir 物理删除（不只是 cleaned 标志）", async () => {
    const { existsSync } = await import("node:fs");
    const r = await runSandbox({
      files: [{ path: "a.txt", content: "remove me" }],
      commands: [{ cmd: "echo", args: ["hi"] }],
    });
    expect(r.cleaned).toBe(true);
    // 关键：workdir 真的不在文件系统上了，不只是字段标记
    expect(existsSync(r.workdir)).toBe(false);
  });

  test("§15.3-1 tmpdir cleanup：命令 fail 也要清理（finally 路径）", async () => {
    const { existsSync } = await import("node:fs");
    const r = await runSandbox({
      files: [{ path: "x.txt", content: "x" }],
      commands: [{ cmd: "sh", args: ["-c", "exit 99"] }],
    });
    expect(r.allOk).toBe(false);
    expect(r.exec[0].exitCode).toBe(99);
    expect(r.cleaned).toBe(true);
    expect(existsSync(r.workdir)).toBe(false);
  });

  test("§15.3-1 tmpdir cleanup：timeout 触发后 workdir 仍被清理", async () => {
    const { existsSync } = await import("node:fs");
    const r = await runSandbox({
      files: [{ path: "x.txt", content: "x" }],
      commands: [{ cmd: "sh", args: ["-c", "sleep 5"] }],
      sandbox: { timeoutMs: 300 },
    });
    expect(r.exec[0].timedOut).toBe(true);
    expect(r.cleaned).toBe(true);
    expect(existsSync(r.workdir)).toBe(false);
  });

  test("§15.3-2 超时回收：SIGKILL 真把子进程干掉（用 ps 反查 PID 已死）", async () => {
    // 让子进程把自己 PID 写到文件，sandbox 超时 SIGKILL 它后用 kill -0 反查应已死
    const { existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const pidFile = join(tmpdir(), `sid-sandbox-pid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    if (existsSync(pidFile)) rmSync(pidFile);

    const r = await runSandbox({
      files: [],
      commands: [
        {
          cmd: "sh",
          args: ["-c", `echo $$ > "${pidFile}" && sleep 30`],
        },
      ],
      sandbox: { timeoutMs: 500 },
    });
    expect(r.exec[0].timedOut).toBe(true);

    // 给 OS 一点反应时间收尸
    await new Promise((res) => setTimeout(res, 200));

    // 反查 PID 是否真死
    const { readFileSync } = await import("node:fs");
    expect(existsSync(pidFile)).toBe(true);
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);

    // kill -0 0 returns true 仅当进程仍存活；已死则抛 ESRCH
    let stillAlive: boolean;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);

    rmSync(pidFile, { force: true });
  });

  test("§15.3-2 超时回收：长 stdout 流不让 sandbox 漏 timeout（防数据流卡死 timer）", async () => {
    // yes 命令疯狂吐 stdout，sandbox 必须仍能在 timeoutMs 后强杀
    const start = Date.now();
    const r = await runSandbox({
      files: [],
      commands: [{ cmd: "sh", args: ["-c", "yes spam | head -c 1000000 && sleep 10"] }],
      sandbox: { timeoutMs: 500 },
    });
    const elapsed = Date.now() - start;
    expect(r.exec[0].timedOut).toBe(true);
    // 真在 timeoutMs 附近终止（给 4s 容差，全量 bun test 并发跑时 IO 竞争 + 子进程启动会占几秒）
    expect(elapsed).toBeLessThan(4500);
    // stdout 截到 64KB 上限以内（防 OOM）
    expect(r.exec[0].stdout.length).toBeLessThanOrEqual(64 * 1024);
  }, 15_000);

  test("§15.3-3 边界：stdout 超 64KB 截断到末尾 64KB（防被测代码 OOM 评测进程）", async () => {
    // 100KB 的 stdout（每行 ~20 字节 × 5500 行 ≈ 110KB > 64KB 上限）
    const r = await runSandbox({
      files: [],
      commands: [
        { cmd: "sh", args: ["-c", "for i in $(seq 1 5500); do echo line-$i-padding-text; done"] },
      ],
      sandbox: { timeoutMs: 10_000 },
    });
    expect(r.exec[0].exitCode).toBe(0);
    expect(r.exec[0].stdout.length).toBeLessThanOrEqual(64 * 1024);
    // 截到末尾：最后一行编号必须 ≈ 5500（保留尾部，丢弃头部）
    expect(r.exec[0].stdout).toContain("line-5500-");
    // 头几行应该已经被截掉
    expect(r.exec[0].stdout).not.toContain("line-1-padding");
  });
});
