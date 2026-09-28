/**
 * W1：后台子代理不再丢掉 isolation。
 *
 * 缺陷形态：execute() 先看 run_in_background 分流，而**唯一**建 worktree 的地方
 * 在 runSync 里。于是这两条路径都会静默写主仓：
 *   1. 模型显式传 isolation=worktree + run_in_background=true（schema 不拒绝这个组合）；
 *   2. agent frontmatter 同时声明 background: true 与 isolation: "worktree"
 *      （tool.ts 的默认值逻辑会把两个都填上），这条路径模型什么都不用传。
 * 后果：executeInBackground 不建 worktree，传给 sub.execute 的 cwd 是 params.cwd
 * （通常 undefined）→ 子代理 getCwd() 回退主会话 cwd → 文件工具直接改主仓。
 * 而且 isolationCleanup 只存在于 runSync 的 finally，后台路径连清理都没有。
 *
 * 测法：桩掉 createSubAgentForType，把 execute() 收到的 cwd 记下来——判据就是
 * 「子代理实际拿到的工作目录是不是隔离目录」，这正是缺陷的落点。
 * 不桩 WorktreeManager：worktree 真建在临时 git 仓里，顺带验证清理行为。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { getTask, completeAgentTask } from "@sid-code/core/task/index.ts";
import {
  registerDynamicAgents,
  clearDynamicAgents,
} from "@sid-code/core/agent/agent-definition.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * 后台执行的等待方式：包住实例上的 executeInBackground，留下它返回的 promise。
 *
 * 为什么不按任务状态轮询：任务在 SubAgent.execute 内部就被推到终态，而 worktree
 * 清理在 executeInBackground 的 finally 里、晚于它。轮询终态会在清理跑完之前返回，
 * 让「无改动自动清理」这类断言变成竞态。等真实 promise 才覆盖到 finally。
 */
function captureBackgroundPromise(tool: SubAgentTool): { done: Promise<void> | null } {
  const box: { done: Promise<void> | null } = { done: null };
  const orig = (tool as any).executeInBackground.bind(tool);
  (tool as any).executeInBackground = (...args: unknown[]) => {
    const p = orig(...args) as Promise<void>;
    box.done = p;
    return p;
  };
  return box;
}

let repo: string;
let prevCwd: string;
let configRoot: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-w1-cfg-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-w1-repo-")));
  git(["init", "-q", "."], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);

  // findGitRootForAgent 读 process.cwd()，必须把进程放进这个临时仓里
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  clearDynamicAgents();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

interface Captured {
  cwd?: string;
  calls: number;
}

/**
 * 造一个 SubAgentTool，并把 createSubAgentForType 换成记录 cwd 的桩。
 * 只桩这一层：worktree 创建、slot 计数、清理都走真实代码。
 */
function toolWithCapture(captured: Captured, opts: { writeFile?: string } = {}): SubAgentTool {
  const tool = new SubAgentTool({} as any, {} as any);
  (tool as any).createSubAgentForType = () => ({
    setParentSessionContext: () => {},
    setParentSessionId: () => {},
    execute: async (input: any) => {
      captured.calls++;
      captured.cwd = input.cwd;
      // 模拟"写类 agent 真的写了一个文件"，用来验证它落在哪棵工作区
      if (opts.writeFile && input.cwd) {
        writeFileSync(join(input.cwd, opts.writeFile), "written by subagent\n");
      }
      // 真实 SubAgent.execute 内部会把任务推到终态（_taskId 是后台路径预建的任务），
      // 桩要补上这一步，否则 waitForTask 永远等不到终态。notify=false 避免测试里投通知。
      if (input._taskId) {
        await completeAgentTask(
          input._taskId,
          { success: true, output: "done", turns: 1, toolUseCount: 0 } as any,
          false,
        );
      }
      return {
        success: true,
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolUseCount: 0,
      };
    },
  });
  return tool;
}

/** 发一个后台任务，等后台执行（含 finally 清理）真正结束，返回 task_id */
async function runBackground(
  tool: SubAgentTool,
  params: Record<string, unknown>,
): Promise<{ taskId: string }> {
  const box = captureBackgroundPromise(tool);
  const res = await tool.execute({
    type: "general-purpose",
    description: "任务",
    prompt: "p",
    run_in_background: true,
    ...params,
  });
  const parsed = JSON.parse(res.output) as { task_id: string; status: string };
  // runAsync 立即返回 task_id（这本身就是后台路径的判据）
  expect(parsed.status).toBe("running");
  expect(box.done).not.toBeNull();
  await box.done;
  return { taskId: parsed.task_id };
}

const worktreesDir = (): string => join(repo, ".sid-code", "worktrees");

describe("W1：isolation=worktree + run_in_background=true", () => {
  it("后台子代理拿到的 cwd 是隔离 worktree，而不是主仓", async () => {
    const captured: Captured = { calls: 0 };
    await runBackground(toolWithCapture(captured), { isolation: "worktree" });

    expect(captured.calls).toBe(1);
    expect(captured.cwd).toBeDefined();
    // 缺陷形态：cwd === undefined（回退主会话 cwd）→ 写主仓
    expect(captured.cwd).not.toBe(repo);
    expect(captured.cwd!.startsWith(worktreesDir())).toBe(true);
    expect(captured.cwd).toMatch(/\/agent-[0-9a-f]{8}$/);
  });

  it("后台子代理的写入落在 worktree 里，主仓工作区不被污染", async () => {
    const captured: Captured = { calls: 0 };
    await runBackground(toolWithCapture(captured, { writeFile: "touched.txt" }), {
      isolation: "worktree",
    });

    // 主仓工作区干净——这就是"文件隔离是入场券"的可观测形态
    expect(existsSync(join(repo, "touched.txt"))).toBe(false);
    expect(git(["status", "--porcelain"], repo)).toBe("");
  });

  it("有改动的隔离 worktree 被保留（fail-closed，不强删用户工作）", async () => {
    const captured: Captured = { calls: 0 };
    await runBackground(toolWithCapture(captured, { writeFile: "work.txt" }), {
      isolation: "worktree",
    });

    expect(existsSync(join(captured.cwd!, "work.txt"))).toBe(true);
    // 有未提交改动 → remove(force=false) 拒删 → 目录还在
    expect(existsSync(captured.cwd!)).toBe(true);
  });

  it("无改动的隔离 worktree 执行完自动清理（与前台 runSync 同构）", async () => {
    const captured: Captured = { calls: 0 };
    await runBackground(toolWithCapture(captured), { isolation: "worktree" });

    expect(captured.cwd).toBeDefined();
    expect(existsSync(captured.cwd!)).toBe(false);
  });
});

describe("W1：agent 定义同时声明 background + isolation（模型什么都不用传）", () => {
  it("frontmatter 的两个声明都生效，仍然隔离", async () => {
    const captured: Captured = { calls: 0 };
    const tool = toolWithCapture(captured);
    const box = captureBackgroundPromise(tool);

    // 走 execute() 里 resolveAgent 的默认值逻辑：
    // background: true → 后台；isolation: worktree → 隔离。
    // 这两个默认值同时命中正是缺陷 #2 的触发条件（模型一个参数都没传）。
    registerDynamicAgents([
      {
        agentType: "w1-writer",
        description: "写类 agent",
        whenToUse: "写文件时",
        systemPrompt: "you write",
        background: true,
        isolation: "worktree",
      },
    ]);

    const res = await tool.execute({
      type: "w1-writer",
      description: "改文件",
      prompt: "p",
    });
    const parsed = JSON.parse(res.output) as { task_id: string; status: string };
    expect(parsed.status).toBe("running"); // 证明确实走了后台路径
    expect(box.done).not.toBeNull();
    await box.done;

    expect(captured.cwd).toBeDefined();
    expect(captured.cwd!.startsWith(worktreesDir())).toBe(true);
  });
});

describe("W1：隔离建不出来时不静默降级", () => {
  it("非 git 目录下的后台隔离任务标记失败，而不是照常写主仓", async () => {
    const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "sid-w1-nogit-")));
    process.chdir(nonGit);
    try {
      const captured: Captured = { calls: 0 };
      const { taskId } = await runBackground(toolWithCapture(captured), {
        isolation: "worktree",
      });

      // 关键：子代理**根本没跑**。降级执行等于静默写主仓，正是要消灭的后果。
      expect(captured.calls).toBe(0);
      expect(getTask(taskId)?.status).toBe("failed");
    } finally {
      process.chdir(repo);
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("隔离失败后并发 slot 归零（否则后续子代理永久排队饿死）", async () => {
    const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "sid-w1-slot-")));
    process.chdir(nonGit);
    try {
      const before = SubAgentTool.running;
      await runBackground(toolWithCapture({ calls: 0 }), { isolation: "worktree" });
      expect(SubAgentTool.running).toBe(before);
    } finally {
      process.chdir(repo);
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("W1：不声明 isolation 的后台子代理行为不变（回归护栏）", () => {
  it("cwd 保持调用方给的值（不凭空建 worktree）", async () => {
    const captured: Captured = { calls: 0 };
    await runBackground(toolWithCapture(captured), { cwd: repo });

    expect(captured.cwd).toBe(repo);
    expect(existsSync(worktreesDir())).toBe(false);
  });

  it("既不传 isolation 也不传 cwd 时，cwd 仍为 undefined", async () => {
    const captured: Captured = { calls: 0 };
    await runBackground(toolWithCapture(captured), {});

    expect(captured.calls).toBe(1);
    expect(captured.cwd).toBeUndefined();
  });
});

describe("W1：前台 isolation 路径不回退", () => {
  it("同步模式仍然隔离（抽公共函数后行为不变）", async () => {
    const captured: Captured = { calls: 0 };
    const res = await toolWithCapture(captured).execute({
      type: "general-purpose",
      description: "前台隔离",
      prompt: "p",
      isolation: "worktree",
    });

    expect(res.isError).toBeFalsy();
    expect(captured.cwd).toBeDefined();
    expect(captured.cwd!.startsWith(worktreesDir())).toBe(true);
  });

  it("前台非 git 目录仍然当场报错（不降级）", async () => {
    const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "sid-w1-fg-")));
    process.chdir(nonGit);
    try {
      const captured: Captured = { calls: 0 };
      const res = await toolWithCapture(captured).execute({
        type: "general-purpose",
        description: "前台隔离",
        prompt: "p",
        isolation: "worktree",
      });
      expect(res.isError).toBe(true);
      expect(captured.calls).toBe(0);
    } finally {
      process.chdir(repo);
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
