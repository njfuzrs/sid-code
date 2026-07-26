/**
 * P2-2：团队 dependsOn 依赖调度 单测
 *
 * 覆盖 seedTaskList → waitForMemberUnblocked → markMemberDone 这条链的行为契约：
 * - 无依赖成员并发起跑；声明 dependsOn 的成员必须等上游完成后才启动
 * - 链式依赖（A → B → C）按序推进
 * - 上游**失败**也解锁下游（记 metadata.failed，避免整图死锁）
 * - 依赖引用不存在的成员名 → warn 跳过该边，不阻断（成员不会永久卡住）
 * - 依赖等待期间 signal abort → 该成员返回失败而非永久挂起
 * - 团队任务只落本团队分区，不污染主会话 TODO
 *
 * 这些是 team 编排的"顺序保证"，靠 mock SubAgent 记录真实启动顺序来验，
 * 而不是只断言任务图状态——顺序错了但状态对的 bug 正是这里要挡的。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TeamManager, type TeamOptions, type TeammateSpec } from "../../src/swarm/team.ts";
import {
  createStructuredTask,
  getAllStructuredTasks,
  getTeamTasks,
  __clearStructuredTasks,
} from "../../src/task/structured-task-store.ts";

const mockProviderRegistry = {} as any;
const mockToolRegistry = {} as any;

let dir: string;
/** 每个成员的启动/结束事件序列（顺序即断言依据） */
let events: string[];
/** 成员名 → 该成员执行时长（毫秒），用于把并发/串行区分开 */
let durations: Record<string, number>;
/** 成员名 → 该成员是否应报失败 */
let failures: Set<string>;

/**
 * 记录启动/结束顺序的 SubAgent 替身。
 * 从 task.description（形如 `[team] memberName`）反解成员名——team.ts 就是这么拼的。
 */
class RecordingSubAgent {
  static fromRegistry() {
    return new RecordingSubAgent();
  }
  async execute(task: any, signal?: AbortSignal): Promise<any> {
    const label = String(task?.description ?? "");
    const name = label.replace(/^\[[^\]]*\]\s*/, "");
    events.push(`start:${name}`);
    const ms = durations[name] ?? 10;
    // 尊重 signal——真实 SubAgent 会被 abort 打断，替身若无视它，
    // 「等待依赖期间 abort」用例会一路跑到 team 硬超时，测的就不是被测行为了。
    const aborted = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      (t as any).unref?.();
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve(true);
      }, { once: true });
    });
    events.push(`end:${name}`);
    if (aborted) return { success: false, output: `${name} 被中止` };
    const failed = failures.has(name);
    return { success: !failed, output: failed ? `${name} 失败` : `${name} 完成` };
  }
}

function makeTeam(teamName: string, members: TeammateSpec[], extra?: Partial<TeamOptions>) {
  const opts: TeamOptions = {
    teamName,
    members,
    providerRegistry: mockProviderRegistry,
    toolRegistry: mockToolRegistry,
    baseDir: dir,
    timeoutMs: 10_000,
    ...extra,
  };
  return new TeamManager(opts);
}

/** 用 RecordingSubAgent 替换 SubAgent.fromRegistry 跑一次 team.run */
async function runWithRecording(team: TeamManager, signal?: AbortSignal) {
  const mod = await import("../../src/agent/sub-agent.ts");
  const orig = mod.SubAgent.fromRegistry;
  mod.SubAgent.fromRegistry = RecordingSubAgent.fromRegistry as any;
  try {
    return await team.run(signal, 0);
  } finally {
    mod.SubAgent.fromRegistry = orig;
  }
}

const idxOf = (evt: string) => events.indexOf(evt);

beforeEach(() => {
  __clearStructuredTasks();
  dir = mkdtempSync(join(tmpdir(), "sid-team-deps-"));
  events = [];
  durations = {};
  failures = new Set();
});

afterEach(() => {
  __clearStructuredTasks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("dependsOn 顺序保证", () => {
  test("声明依赖的成员在上游结束后才启动", async () => {
    // A 跑得慢；若 B 没等 A，B 的 start 会排在 A 的 end 之前
    durations = { alice: 120, bob: 5 };
    const team = makeTeam("deps-basic", [
      { name: "alice", type: "task", task: "先做基础层", isolated: false },
      { name: "bob", type: "task", task: "依赖基础层", isolated: false, dependsOn: ["alice"] },
    ]);

    const results = await runWithRecording(team);

    expect(results.map((r) => r.name)).toEqual(["alice", "bob"]);
    expect(results.every((r) => r.success)).toBe(true);
    // 关键断言：bob 的 start 晚于 alice 的 end
    expect(idxOf("start:bob")).toBeGreaterThan(idxOf("end:alice"));
  });

  test("无依赖成员并发起跑（不被彼此拖慢）", async () => {
    durations = { p1: 80, p2: 5 };
    const team = makeTeam("deps-parallel", [
      { name: "p1", type: "task", task: "任务一", isolated: false },
      { name: "p2", type: "task", task: "任务二", isolated: false },
    ]);

    await runWithRecording(team);

    // 两者都先 start 再 end（交错），说明是并发而非串行
    expect(idxOf("start:p2")).toBeLessThan(idxOf("end:p1"));
  });

  test("链式依赖 A → B → C 按序推进", async () => {
    durations = { a: 40, b: 40, c: 5 };
    const team = makeTeam("deps-chain", [
      // 刻意把 C 放最前面声明，验证顺序由依赖图而非声明顺序决定
      { name: "c", type: "task", task: "第三层", isolated: false, dependsOn: ["b"] },
      { name: "b", type: "task", task: "第二层", isolated: false, dependsOn: ["a"] },
      { name: "a", type: "task", task: "第一层", isolated: false },
    ]);

    const results = await runWithRecording(team);

    // 返回值仍保持成员定义顺序（c, b, a）
    expect(results.map((r) => r.name)).toEqual(["c", "b", "a"]);
    // 执行顺序由依赖决定：a → b → c
    expect(idxOf("start:b")).toBeGreaterThan(idxOf("end:a"));
    expect(idxOf("start:c")).toBeGreaterThan(idxOf("end:b"));
  });

  test("一个成员依赖多个上游时等全部完成", async () => {
    durations = { u1: 60, u2: 100, down: 5 };
    const team = makeTeam("deps-fanin", [
      { name: "u1", type: "task", task: "上游一", isolated: false },
      { name: "u2", type: "task", task: "上游二", isolated: false },
      { name: "down", type: "task", task: "汇聚", isolated: false, dependsOn: ["u1", "u2"] },
    ]);

    await runWithRecording(team);

    expect(idxOf("start:down")).toBeGreaterThan(idxOf("end:u1"));
    expect(idxOf("start:down")).toBeGreaterThan(idxOf("end:u2"));
  });
});

describe("dependsOn 容错（不死锁）", () => {
  test("上游失败也解锁下游，任务记 failed 标记", async () => {
    durations = { broken: 40, after: 5 };
    failures.add("broken");
    const team = makeTeam("deps-fail", [
      { name: "broken", type: "task", task: "会失败", isolated: false },
      { name: "after", type: "task", task: "下游", isolated: false, dependsOn: ["broken"] },
    ]);

    const results = await runWithRecording(team);

    // 下游仍被执行（不因上游失败永久阻塞）
    expect(idxOf("start:after")).toBeGreaterThan(idxOf("end:broken"));
    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get("broken")!.success).toBe(false);
    expect(byName.get("after")!.success).toBe(true);

    // 上游任务落 completed + metadata.failed（解锁靠 completed，失败细节靠 metadata）
    const tasks = getTeamTasks("deps-fail");
    const brokenTask = tasks.find((t) => t.subject.endsWith("broken"))!;
    expect(brokenTask.status).toBe("completed");
    expect((brokenTask.metadata as any).failed).toBe(true);
    const afterTask = tasks.find((t) => t.subject.endsWith("after"))!;
    expect((afterTask.metadata as any).failed).toBe(false);
  });

  test("依赖不存在的成员名 → 跳过该边，成员照常执行", async () => {
    const team = makeTeam("deps-ghost", [
      { name: "solo", type: "task", task: "依赖幽灵", isolated: false, dependsOn: ["nobody"] },
    ]);

    const results = await runWithRecording(team);

    expect(results[0].success).toBe(true);
    expect(events).toContain("start:solo");
  });

  test("等待依赖期间 abort → 该成员返回失败，不永久挂起", async () => {
    // 上游跑很久，abort 在等待窗口内触发
    durations = { slow: 5_000, waiter: 5 };
    const ctl = new AbortController();
    const team = makeTeam("deps-abort", [
      { name: "slow", type: "task", task: "很慢的上游", isolated: false },
      { name: "waiter", type: "task", task: "等待者", isolated: false, dependsOn: ["slow"] },
    ], { timeoutMs: 3_000 });

    const timer = setTimeout(() => ctl.abort(), 300);
    (timer as any).unref?.();

    const start = Date.now();
    const results = await runWithRecording(team, ctl.signal);
    const elapsed = Date.now() - start;

    const waiter = results.find((r) => r.name === "waiter")!;
    expect(waiter.success).toBe(false);
    expect(waiter.output).toContain("等待依赖时被中止");
    // 不该等到上游的 5s 才返回
    expect(elapsed).toBeLessThan(3_000);
    // 等待者从未真正启动过子代理
    expect(events).not.toContain("start:waiter");
  });
});

describe("dependsOn 任务图不越界", () => {
  test("依赖边只建在本团队分区，主会话 TODO 不受影响", async () => {
    // 先建一条主会话 TODO（无 metadata.team）
    const mainTodo = createStructuredTask({ subject: "主会话待办", description: "与团队无关" });

    durations = { x: 30, y: 5 };
    const team = makeTeam("deps-scope", [
      { name: "x", type: "task", task: "上游", isolated: false },
      { name: "y", type: "task", task: "下游", isolated: false, dependsOn: ["x"] },
    ]);
    await runWithRecording(team);

    // 团队分区只有 2 个成员任务
    const teamTasks = getTeamTasks("deps-scope");
    expect(teamTasks).toHaveLength(2);
    // 主会话 TODO 依然是 pending 且无依赖边、无 team 标记
    const all = getAllStructuredTasks();
    const stillThere = all.find((t) => t.id === mainTodo.id)!;
    expect(stillThere.status).toBe("pending");
    expect(stillThere.blockedBy ?? []).toHaveLength(0);
    expect((stillThere.metadata as any)?.team).toBeUndefined();
  });

  test("依赖边体现在 blockedBy 上，上游完成后清空阻塞", async () => {
    durations = { up: 30, downstream: 5 };
    const team = makeTeam("deps-edges", [
      { name: "up", type: "task", task: "上游", isolated: false },
      { name: "downstream", type: "task", task: "下游", isolated: false, dependsOn: ["up"] },
    ]);
    await runWithRecording(team);

    const tasks = getTeamTasks("deps-edges");
    const upTask = tasks.find((t) => t.subject.endsWith("up"))!;
    const downTask = tasks.find((t) => t.subject.endsWith("downstream"))!;
    // 依赖边持久保留（记录图结构），解锁靠上游 status=completed 判定
    expect(downTask.blockedBy).toContain(upTask.id);
    expect(upTask.status).toBe("completed");
    expect(downTask.status).toBe("completed");
  });
});
