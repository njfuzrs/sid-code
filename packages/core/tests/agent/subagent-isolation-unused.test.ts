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
import {
  setIsolationUnusedTraceSink,
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
 */
function toolWithCapture(captured: Captured, opts: { writeFile?: string } = {}): SubAgentTool {
  const tool = new SubAgentTool({} as any, {} as any);
  (tool as any).createSubAgentForType = () => ({
    setParentSessionContext: () => {},
    setParentSessionId: () => {},
    execute: async (input: any) => {
      captured.cwd = input.cwd;
      if (opts.writeFile && input.cwd) {
        writeFileSync(join(input.cwd, opts.writeFile), "written by subagent\n");
      }
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
    expect(typeof e.lifetime_ms).toBe("number");
    expect(e.lifetime_ms as number).toBeGreaterThanOrEqual(0);
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
