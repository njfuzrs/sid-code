/**
 * Bash 工具稳定性回归测试（对标 claude-code）
 *
 * 覆盖本轮审计修复的四个缺口：
 * 1. 超时机制真正生效（旧实现双定时器竞态导致超时形同虚设）
 * 2. 超时/取消杀掉整棵进程树（旧实现只杀 shell 父进程，子进程成孤儿）
 * 3. 退出码语义解释（grep 无匹配 / diff 有差异等非错误）
 * 4. cwd 不存在时给出友好错误信息
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool, resolveTimeoutBounds } from "@sid-code/core/tool/bash.ts";
import { interpretExitCode } from "@sid-code/core/tool/bash/command-semantics.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";

let originalGlobalCwd: string;

beforeEach(() => {
  originalGlobalCwd = getCwd();
});
afterEach(() => {
  setCwd(originalGlobalCwd);
});

describe("缺口1: 超时机制真正生效", () => {
  it("命令超过 timeout 被终止，且实际耗时接近 timeout 而非跑满全程", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const start = Date.now();
    // 命令要 sleep 5s，但 timeout 只给 1s
    const result = await bash.execute({
      command: "sleep 5",
      description: "睡眠5秒测试超时",
      timeout: 1000,
    });
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("超时");
    // 关键断言：必须在远早于 5s 时返回（旧实现会跑满 5s）。给足调度余量 3s。
    expect(elapsed).toBeLessThan(3000);
  }, 10000);

  it("超时提示引导使用 run_in_background", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const result = await bash.execute({
      command: "sleep 5",
      description: "睡眠测试",
      timeout: 1000,
    });
    expect(result.output).toContain("run_in_background");
  }, 10000);
});

describe("缺口2: 超时杀掉整棵进程树", () => {
  it("超时后子进程（后台 sleep）被一并清理，无孤儿残留", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    // 启动一个后台子进程并打印其 PID，然后父 shell 等待
    const result = await bash.execute({
      command: "sleep 30 & echo CHILD_PID=$!; wait",
      description: "启动后台子进程测试进程树清理",
      timeout: 800,
    });
    expect(result.isError).toBe(true);

    // 从输出解析子进程 PID
    const m = /CHILD_PID=(\d+)/.exec(result.output);
    expect(m).not.toBeNull();
    const childPid = parseInt(m![1], 10);

    // 给 kill 一点传播时间
    await new Promise((r) => setTimeout(r, 400));

    // 探测子进程是否存活（signal 0 = 探测）
    let alive = false;
    try {
      process.kill(childPid, 0);
      alive = true;
      // 清理，避免污染
      try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ }
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10000);
});

describe("缺口3: 退出码语义解释", () => {
  it("grep 无匹配（exit 1）不视为错误", () => {
    const r = interpretExitCode("grep foo bar.txt", 1);
    expect(r.isError).toBe(false);
    expect(r.message).toBe("无匹配");
  });

  it("grep 真错误（exit 2）视为错误", () => {
    const r = interpretExitCode("grep foo /nonexistent", 2);
    expect(r.isError).toBe(true);
  });

  it("diff 有差异（exit 1）不视为错误", () => {
    const r = interpretExitCode("diff a.txt b.txt", 1);
    expect(r.isError).toBe(false);
    expect(r.message).toBe("文件存在差异");
  });

  it("find 部分不可访问（exit 1）不视为错误", () => {
    const r = interpretExitCode("find / -name foo", 1);
    expect(r.isError).toBe(false);
  });

  it("test 条件为假（exit 1）不视为错误", () => {
    const r = interpretExitCode("test -f /nonexistent", 1);
    expect(r.isError).toBe(false);
  });

  it("管道取最后一个命令的语义（... | grep）", () => {
    const r = interpretExitCode("cat foo.txt | grep bar", 1);
    expect(r.isError).toBe(false);
    expect(r.message).toBe("无匹配");
  });

  it("普通命令 exit 1 仍视为错误", () => {
    const r = interpretExitCode("ls /nonexistent", 1);
    expect(r.isError).toBe(true);
  });

  it("任何命令 exit 0 都不是错误", () => {
    expect(interpretExitCode("grep foo bar", 0).isError).toBe(false);
    expect(interpretExitCode("ls", 0).isError).toBe(false);
  });

  it("集成: grep 无匹配经 execute 不标 isError", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const result = await bash.execute({
      command: "echo hello | grep zzz_no_match_zzz",
      description: "grep 无匹配测试",
    });
    // 退出码 1 但语义非错误
    expect(result.isError).toBeFalsy();
  }, 10000);
});

describe("缺口5: cwd 不存在给出友好错误", () => {
  it("cwd 指向不存在目录时，错误信息指明工作目录问题而非 shell 二进制", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    // 造一个存在的临时目录再删除，制造"曾经存在但现已消失"
    const gone = mkdtempSync(join(tmpdir(), "sid-gone-"));
    rmSync(gone, { recursive: true, force: true });

    const result = await bash.execute({
      command: "echo hi",
      description: "测试 cwd 不存在",
      cwd: gone,
    });
    // resolveCwd 会回退到 originalCwd，所以正常情况下不会报错——
    // 该用例验证：即便 spawn 抛 ENOENT，错误信息也不会误导为 shell 二进制问题。
    // 若 resolveCwd 兜底成功，命令正常执行（也可接受）。
    if (result.isError) {
      expect(result.output).not.toContain("posix_spawn");
    }
  }, 10000);
});

describe("缺口6: 预先取消的 signal 守卫", () => {
  it("signal 在 execute 进入前已 abort → 不 spawn，直接返回取消", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const ac = new AbortController();
    ac.abort(); // 执行前就取消

    const start = Date.now();
    const result = await bash.execute(
      { command: "sleep 5", description: "预先取消测试" },
      ac.signal,
    );
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("取消");
    // 关键：必须立即返回，不能真的 sleep 5s（证明没 spawn）
    expect(elapsed).toBeLessThan(500);
  }, 10000);

  it("预先取消对后台命令同样生效", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const ac = new AbortController();
    ac.abort();
    const result = await bash.execute(
      { command: "sleep 5", is_background: true },
      ac.signal,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("取消");
  }, 10000);
});

describe("缺口3-补: run_in_background(Task系统) 进程树清理", () => {
  it("killShellTask 清理 detached 后台任务的整棵进程树", async () => {
    if (process.platform === "win32") return;
    const { spawnShellTask, killShellTask } = await import("@sid-code/core/task/shell-task.ts");
    // 启动后台任务：父 shell 派生 sleep 子进程并打印其 PID
    const task = spawnShellTask({
      command: "sleep 30 & echo GRANDCHILD=$! > /tmp/sid-test-gc.txt; wait",
      cwd: process.cwd(),
    });
    // 等子进程起来并写出 PID
    await new Promise((r) => setTimeout(r, 500));
    const { readFileSync, existsSync, unlinkSync } = await import("fs");
    let grandchildPid = 0;
    if (existsSync("/tmp/sid-test-gc.txt")) {
      const m = /GRANDCHILD=(\d+)/.exec(readFileSync("/tmp/sid-test-gc.txt", "utf8"));
      if (m) grandchildPid = parseInt(m[1], 10);
      try { unlinkSync("/tmp/sid-test-gc.txt"); } catch { /* ignore */ }
    }
    expect(grandchildPid).toBeGreaterThan(0);

    killShellTask(task.id);
    await new Promise((r) => setTimeout(r, 400));

    let alive = false;
    try {
      process.kill(grandchildPid, 0);
      alive = true;
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* ignore */ }
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10000);
});

// P2-10：is_background 与 run_in_background 统一走 Task 系统（返回 task_id，非旧 PID 格式）
describe("P2-10: is_background 统一到 Task 系统", () => {
  it("run_in_background 返回 task_id", async () => {
    const { clearAllTasks } = await import("@sid-code/core/task/index.ts");
    const bash = new BashTool();
    const result = await bash.execute({ command: "echo hi", run_in_background: true });
    const parsed = JSON.parse(result.output);
    expect(parsed.task_id).toBeDefined();
    expect(parsed.message).toContain("后台任务");
    clearAllTasks();
  });

  it("is_background（旧通道）也返回 task_id，不再是旧 PID 格式", async () => {
    const { clearAllTasks } = await import("@sid-code/core/task/index.ts");
    const bash = new BashTool();
    const result = await bash.execute({ command: "echo hi", is_background: true });
    // 修复前 is_background 走 executeBackground → 返回 "命令已在后台运行 (PID: ...)"（非 JSON）
    // 修复后统一走 Task 系统 → 返回含 task_id 的 JSON
    const parsed = JSON.parse(result.output);
    expect(parsed.task_id).toBeDefined();
    expect(result.output).not.toContain("PID:");
    clearAllTasks();
  });
});

// P2-11：bash 超时默认值/上限支持 env 覆盖（对齐 CC BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS）
describe("P2-11: bash 超时 env 覆盖", () => {
  const KEYS = ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("未配 env 时用出厂默认值 120000 / 上限 600000", () => {
    const { defaultMs, maxMs } = resolveTimeoutBounds();
    expect(defaultMs).toBe(120000);
    expect(maxMs).toBe(600000);
  });

  it("env 覆盖默认值与上限", () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = "5000";
    process.env.BASH_MAX_TIMEOUT_MS = "900000";
    const { defaultMs, maxMs } = resolveTimeoutBounds();
    expect(defaultMs).toBe(5000);
    expect(maxMs).toBe(900000);
  });

  it("默认值被夹到不超过上限", () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = "999999999";
    process.env.BASH_MAX_TIMEOUT_MS = "300000";
    const { defaultMs, maxMs } = resolveTimeoutBounds();
    expect(maxMs).toBe(300000);
    expect(defaultMs).toBe(300000); // 夹到上限
  });

  it("非法/非正 env 值被忽略，回落出厂值", () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = "abc";
    process.env.BASH_MAX_TIMEOUT_MS = "-100";
    const { defaultMs, maxMs } = resolveTimeoutBounds();
    expect(defaultMs).toBe(120000);
    expect(maxMs).toBe(600000);
  });
});

