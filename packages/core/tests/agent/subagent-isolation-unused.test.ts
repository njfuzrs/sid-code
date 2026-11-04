/**
 * O1（PR6）：只读子代理白建 worktree 的量化埋点
 *
 * 复盘会话（20261103-213816-f5beebde）里 3 个只读 git 历史核查子代理都传了
 * `isolation: "worktree"` —— worktree 建出来一个文件都没改，结束时又原样删掉，
 * 创建/清理的整套开销全白付。修法分两步：工具描述把判据写清楚（从源头劝退），
 * 再加一条 `SubagentIsolationUnused` 事件**量出这类浪费有多常见**，之后才好决定
 * 要不要做更强的约束。没有分母的「要不要加约束」只能凭感觉。
 *
 * 因此两个方向都必须有断言：
 *  - 命中：无改动的隔离子代理 → 落一条事件，字段能支撑后续统计；
 *  - 不命中：真有改动的 → 一条都不落（否则事件会变成噪音，失去判据价值）。
 *
 * 另含工具描述判据的断言：只读任务不要传 isolation（三段文案都要有，缺一段就会
 * 有模型从那条通道看到「可以隔离」而看不到「只读不要传」）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { completeAgentTask } from "@sid-code/core/task/index.ts";
import { clearDynamicAgents } from "@sid-code/core/agent/agent-definition.ts";
import { WorktreeManager } from "@sid-code/core/worktree/manager.ts";
import {
  setIsolationUnusedTraceSink,
  hasIsolationUnusedTraceSink,
  SUBAGENT_ISOLATION_UNUSED_EVENT_NAME,
} from "@sid-code/core/trace/isolation-telemetry.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

let repo: string;
let prevCwd: string;
let configRoot: string;
let prevConfigDir: string | undefined;
let events: Array<Record<string, unknown>>;

beforeEach(() => {
  // 落盘隔离：子代理/logger 会写 getSidHome()，不重定向会灌进用户真实的 ~/.sid-code。
  configRoot = mkdtempSync(join(tmpdir(), "sid-o1-cfg-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-o1-repo-")));
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

  events = [];
  setIsolationUnusedTraceSink((data) => events.push(data));
});

afterEach(() => {
  // 模块级 sink 必须复位：同批多文件跑在同一进程里，留着会污染后续测试
  setIsolationUnusedTraceSink(null);
  process.chdir(prevCwd);
  clearDynamicAgents();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

interface Captured {
  cwd?: string;
}

/**
 * 造一个 SubAgentTool，并把 createSubAgentForType 换成记录 cwd 的桩。
 * 只桩这一层：worktree 创建、改动判定、清理都走真实代码 —— 事件正是在
 * cleanup 里发的，桩掉 WorktreeManager 就等于桩掉了被测对象。
 *
 * opts 覆盖判据的三个维度（缺一维就会有分支恒绿）：
 *  - `writeFile`：有未提交改动 → changedFiles > 0
 *  - `commitFile`：commit 后工作区干净 → commits > 0、changedFiles === 0
 *    （写类隔离子代理最常见的收尾形态；判据漏掉 commits 就会把它误报成白建）
 *  - `breakGit`：worktree 的 git 元数据坏掉 → countChanges 返回 null（「不知道」）
 */
function toolWithCapture(
  captured: Captured,
  opts: { writeFile?: string; commitFile?: string; fail?: boolean; breakGit?: boolean } = {},
): SubAgentTool {
  const tool = new SubAgentTool({} as any, {} as any);
  (tool as any).createSubAgentForType = () => ({
    setParentSessionContext: () => {},
    setParentSessionId: () => {},
    execute: async (input: any) => {
      captured.cwd = input.cwd;
      if (input.cwd) {
        if (opts.writeFile) {
          writeFileSync(join(input.cwd, opts.writeFile), "written by subagent\n");
        }
        if (opts.commitFile) {
          writeFileSync(join(input.cwd, opts.commitFile), "committed by subagent\n");
          git(["add", "-A"], input.cwd);
          git(["commit", "-q", "-m", "subagent work"], input.cwd);
        }
        if (opts.breakGit) {
          // 把 worktree 的 .git 文件指针指到不存在的目录：git 命令 fatal，countChanges 返回 null。
          // ⚠️ 不能只删 .git —— worktree 建在主仓的 .sid-code/worktrees/ 下，git 会向上
          // 找到主仓的 .git，status 反而成功（实测踩过：删了反而落出一条事件）。
          writeFileSync(join(input.cwd, ".git"), "gitdir: /nonexistent/sid-broken-worktree\n");
        }
      }
      const success = !opts.fail;
      if (input._taskId) {
        await completeAgentTask(
          input._taskId,
          { success, output: "done", turns: 1, toolUseCount: 0 } as any,
          false,
        );
      }
      return {
        success,
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolUseCount: 0,
      };
    },
  });
  return tool;
}

describe("O1：工作树建了没改 = 白建，落 SubagentIsolationUnused", () => {
  it("同步隔离子代理零改动 → 恰好一条事件，字段够做统计", async () => {
    const captured: Captured = {};
    await toolWithCapture(captured).execute({
      type: "general-purpose",
      description: "只读核查 git 历史",
      prompt: "p",
      isolation: "worktree",
    });

    expect(captured.cwd).toBeDefined();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    // 判据成立的前提就是零改动；显式落 0 让消费侧不必依赖「字段缺失 = 0」的约定
    expect(e.changed_files).toBe(0);
    expect(e.commits).toBe(0);
    // agent_type 是后续决策的关键维度：explore/plan/verify 是只读类型，命中即典型误用
    expect(e.agent_type).toBe("general-purpose");
    expect(e.description).toBe("只读核查 git 历史");
    expect(String(e.worktree_name)).toMatch(/^agent-[0-9a-f]{8}$/);
    // success 用来把「只读任务误用」与「任务本来就失败」两种样本分开
    expect(e.success).toBe(true);
    expect(typeof e.lifetime_ms).toBe("number");
    // 严格大于 0：退化成常量 0 的话，存活时长的均值/分位统计会整体塌掉
    expect(e.lifetime_ms as number).toBeGreaterThan(0);
  });

  it("有改动的隔离子代理 → 不落事件（否则事件变成噪音）", async () => {
    const captured: Captured = {};
    await toolWithCapture(captured, { writeFile: "touched.txt" }).execute({
      type: "general-purpose",
      description: "真的改文件",
      prompt: "p",
      isolation: "worktree",
    });

    expect(captured.cwd).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it("在 worktree 里 commit、工作区干净 → 不落事件（commits 维度必须参与判据）", async () => {
    // 写类隔离子代理最常见的收尾形态：commit 完工作区是干净的。
    // 判据若只看 changedFiles（漏掉 commits），这类真实成果会被误报成「白建」——
    // 而「有改动」那条用例只覆盖了未提交路径，抓不到这个回退。
    const captured: Captured = {};
    await toolWithCapture(captured, { commitFile: "committed.txt" }).execute({
      type: "general-purpose",
      description: "真干活并提交",
      prompt: "p",
      isolation: "worktree",
    });

    expect(captured.cwd).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it("失败子代理零改动 → 落事件，但 success=false（样本来源要能分开）", async () => {
    const captured: Captured = {};
    const res = await toolWithCapture(captured, { fail: true }).execute({
      type: "general-purpose",
      description: "失败了",
      prompt: "p",
      isolation: "worktree",
    });

    expect(res.isError).toBe(true);
    expect(events).toHaveLength(1);
    // 没有这个字段，「只读任务误用」与「任务本来就失败、worktree 只是陪着白建」
    // 两种样本混在一个分母里，一周后的占比判据会失真
    expect(events[0]!.success).toBe(false);
  });

  it("countChanges 失败（git 出错）→ 不落事件：不把「不知道」记成「零改动」", async () => {
    const captured: Captured = {};
    const res = await toolWithCapture(captured, { breakGit: true }).execute({
      type: "general-purpose",
      description: "git 坏了",
      prompt: "p",
      isolation: "worktree",
    });

    expect(captured.cwd).toBeDefined();
    // 子代理本身成功；只是清理阶段的 git 判定失败（remove 抛错被吞，worktree 保留）
    expect(res.isError).not.toBe(true);
    expect(events).toHaveLength(0);
  });

  it("后台路径同样落事件（前台后台共用 setupIsolation，判据不能只覆盖一条路）", async () => {
    const tool = toolWithCapture({});
    const orig = (tool as any).executeInBackground.bind(tool);
    let done: Promise<void> | null = null;
    (tool as any).executeInBackground = (...args: unknown[]) => {
      const p = orig(...args) as Promise<void>;
      done = p;
      return p;
    };

    await tool.execute({
      type: "general-purpose",
      description: "后台只读核查",
      prompt: "p",
      isolation: "worktree",
      run_in_background: true,
    });
    expect(done).not.toBeNull();
    // 清理（以及清理里的埋点）在 executeInBackground 的 finally 里，
    // 等真实 promise 才覆盖到 —— 轮询任务终态会早于 finally 返回。
    await done;

    expect(events).toHaveLength(1);
    expect(events[0]!.description).toBe("后台只读核查");
  });

  it("没传 isolation 的子代理不落事件（判据只在 worktree 路径上）", async () => {
    await toolWithCapture({}).execute({
      type: "general-purpose",
      description: "普通子代理",
      prompt: "p",
    });
    expect(events).toHaveLength(0);
  });

  it("sink 未注入时清理照常完成（埋点不能反过来影响子代理收尾）", async () => {
    setIsolationUnusedTraceSink(null);
    expect(hasIsolationUnusedTraceSink()).toBe(false);
    const captured: Captured = {};
    const res = await toolWithCapture(captured).execute({
      type: "general-purpose",
      description: "无 sink",
      prompt: "p",
      isolation: "worktree",
    });

    expect(res.isError).not.toBe(true);
    expect(captured.cwd).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it("埋点关闭时不再为埋点多跑一次 countChanges（不替不启用遥测的人付收尾开销）", async () => {
    // 计数口径：sink 在时 2 次（埋点一次 + remove 内部一次），sink 关闭时 1 次（只剩 remove）。
    // 盯调用次数而不是耗时：耗时断言在慢机器上会飘，次数不会。数字变化时（remove 内部
    // 多调一次等）本用例会红，正好逼人重新核对「埋点关闭 = 零额外测量」这条不变式。
    const calls: number[] = [];
    const orig = WorktreeManager.prototype.countChanges;
    (WorktreeManager.prototype as any).countChanges = function (this: any, ...args: any[]) {
      calls.push(1);
      return orig.apply(this, args as any);
    };
    try {
      await toolWithCapture({}).execute({
        type: "general-purpose",
        description: "有 sink",
        prompt: "p",
        isolation: "worktree",
      });
      const withSink = calls.length;

      calls.length = 0;
      setIsolationUnusedTraceSink(null);
      await toolWithCapture({}).execute({
        type: "general-purpose",
        description: "无 sink",
        prompt: "p",
        isolation: "worktree",
      });
      const withoutSink = calls.length;

      expect(withSink).toBe(2); // 埋点一次 + remove 内部一次
      expect(withoutSink).toBe(1); // 只剩 remove 内部一次
    } finally {
      (WorktreeManager.prototype as any).countChanges = orig;
    }
  });
});

describe("O1：sink 查询（埋点开关对调用方可见）", () => {
  it("注入后为 true，复位后为 false", () => {
    expect(hasIsolationUnusedTraceSink()).toBe(true);
    setIsolationUnusedTraceSink(null);
    expect(hasIsolationUnusedTraceSink()).toBe(false);
  });
});

describe("O1：工具描述把「只读不要传 isolation」写在模型看得到的每一处", () => {
  const tool = new SubAgentTool({} as any, {} as any);

  it("工具正文（description）给出判据", () => {
    const desc = tool.description();
    expect(desc).toContain("只读任务（不改文件）不要传 isolation");
    expect(desc).toContain("explore / plan / verify");
  });

  it("参数说明（inputSchema.isolation）也带判据 —— 模型看 schema 时同样要看到", () => {
    const schema = tool.inputSchema() as any;
    const isolationDesc = schema.properties?.isolation?.description ?? "";
    expect(isolationDesc).toContain("只读任务（不改文件）不要传");
  });

  it("usageGuide 单独一段说明何时才传 isolation", () => {
    expect(tool.usageGuide()).toContain("什么时候传 isolation=worktree");
    expect(tool.usageGuide()).toContain("只读子代理（explore / plan / verify）一律不传");
  });
});

describe("O1：事件名常量与消费侧对齐", () => {
  it("常量就是事件名本身（防止生产侧/查询侧字面量漂移）", () => {
    expect(SUBAGENT_ISOLATION_UNUSED_EVENT_NAME).toBe("SubagentIsolationUnused");
  });
});
