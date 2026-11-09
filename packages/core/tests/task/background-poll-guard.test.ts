/**
 * Q1：后台任务等待期的轮询拦截——判定矩阵。
 *
 * 事故（opus 批次 R0/L3f/S1v/S2v/S3v，28 次尝试 / 7 次撞空）：后台任务运行期间主代理反复
 * read `.output`、`ls ~/.sid-code/tasks | grep`、阻塞式 task_output。`checkBackgroundPoll`
 * 只拦**运行中**任务，终态放行（读完整结论是合法行为），`block=false` 快照放行。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkBackgroundPoll,
  defaultBackgroundPollContext,
  __resetBackgroundPollGuardForTest,
  type BackgroundPollContext,
} from "@sid-code/core/task/background-poll-guard.ts";
import type { TaskState, TaskStatus } from "@sid-code/core/task/types.ts";

let root: string;
let prevSidDir: string | undefined;

function task(id: string, status: TaskStatus): TaskState {
  return {
    id,
    type: "local_agent",
    status,
    description: id,
    startTime: Date.now(),
    outputFile: join(root, "home", ".sid-code", "tasks", `${id}.output`),
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
  } as unknown as TaskState;
}

/** D17：monitor 的进展信号是 `eventCount`，不是 `progress.toolUseCount`。 */
function monitorTask(id: string, eventCount: number, status: TaskStatus = "running"): TaskState {
  return {
    id,
    type: "local_monitor",
    status,
    description: `监控 ${id}`,
    startTime: Date.now(),
    outputFile: join(root, "home", ".sid-code", "tasks", `${id}.output`),
    outputOffset: 0,
    notified: false,
    command: "gh pr checks",
    deadlineAt: Date.now() + 60_000,
    eventCount,
    outputLines: 0,
    isBackgrounded: true,
  } as unknown as TaskState;
}

function ctxWith(tasks: TaskState[], tasksDir?: string): BackgroundPollContext {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    getTask: (id) => byId.get(id),
    runningBackgroundTasks: () =>
      tasks.filter((t) => t.status === "running" || t.status === "pending"),
    tasksDir: tasksDir ?? join(root, "home", ".sid-code", "tasks"),
    home: join(root, "home"),
    allBackgroundTasks: () => tasks,
    taskListMemo: { last: null },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "q1poll-"));
  prevSidDir = process.env.SID_CONFIG_DIR;
  // taskIdFromOutputPath 按 sidPaths.tasks() 判目录，tasksDir 必须与它一致
  process.env.SID_CONFIG_DIR = join(root, "home", ".sid-code");
  mkdirSync(join(root, "home", ".sid-code", "tasks"), { recursive: true });
});

afterEach(() => {
  if (prevSidDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidDir;
  rmSync(root, { recursive: true, force: true });
});

const out = (id: string) => join(root, "home", ".sid-code", "tasks", `${id}.output`);

describe("read", () => {
  test("运行中任务的 .output → 拦，且非错误、文案说仍在运行", () => {
    const r = checkBackgroundPoll(
      "read",
      { file_path: out("a1") },
      ctxWith([task("a1", "running")]),
    );
    expect(r.intercept).toBe(true);
    if (!r.intercept) return;
    expect(r.kind).toBe("read_output");
    expect(r.taskIds).toEqual(["a1"]);
    expect(r.output).toContain("仍在运行");
    expect(r.output).toContain("自动");
  });

  test("已终态任务的 .output → 放（读完整结论合法）", () => {
    for (const s of ["completed", "failed", "killed"] as const) {
      const r = checkBackgroundPoll("read", { file_path: out("a1") }, ctxWith([task("a1", s)]));
      expect(r.intercept, s).toBe(false);
    }
  });

  test("registry 里没有的任务 → 放（交给墓碑）", () => {
    expect(checkBackgroundPoll("read", { file_path: out("zz") }, ctxWith([])).intercept).toBe(
      false,
    );
  });

  test("经 symlink 的路径（/private/tmp 同形）→ 仍拦", () => {
    const link = join(root, "link-home");
    symlinkSync(join(root, "home"), link);
    const viaLink = join(link, ".sid-code", "tasks", "a1.output");
    const r = checkBackgroundPoll("read", { file_path: viaLink }, ctxWith([task("a1", "running")]));
    expect(r.intercept).toBe(true);
  });

  test("tasks 目录外的同名 .output → 放", () => {
    const r = checkBackgroundPoll(
      "read",
      { file_path: join(root, "a1.output") },
      ctxWith([task("a1", "running")]),
    );
    expect(r.intercept).toBe(false);
  });
});

describe("bash", () => {
  const forms = (rest: string) => [
    `ls -la ${join(root, "home", ".sid-code", "tasks")}${rest}`,
    `ls -la ~/.sid-code/tasks${rest} | grep -E 'a1' || echo 剩余`,
    `wc -c $HOME/.sid-code/tasks${rest}`,
    `cat "\${HOME}/.sid-code/tasks${rest}"`,
  ];

  test("有运行中任务时 ls tasks 根目录（四种写法）→ 拦", () => {
    for (const cmd of forms("/")) {
      const r = checkBackgroundPoll("bash", { command: cmd }, ctxWith([task("a1", "running")]));
      expect(r.intercept, cmd).toBe(true);
      if (r.intercept) expect(r.kind).toBe("bash_tasks_dir");
    }
  });

  test("tail 运行中任务的 .output → 拦，只报那个任务", () => {
    const r = checkBackgroundPoll(
      "bash",
      { command: "tail -n 20 ~/.sid-code/tasks/a1.output" },
      ctxWith([task("a1", "running"), task("b2", "running")]),
    );
    expect(r.intercept).toBe(true);
    if (r.intercept) expect(r.taskIds).toEqual(["a1"]);
  });

  test("通配 tasks/*.output → 拦", () => {
    const r = checkBackgroundPoll(
      "bash",
      { command: "wc -c ~/.sid-code/tasks/*.output" },
      ctxWith([task("a1", "running")]),
    );
    expect(r.intercept).toBe(true);
  });

  test("没有运行中后台任务 → 放", () => {
    for (const cmd of forms("/")) {
      const r = checkBackgroundPoll("bash", { command: cmd }, ctxWith([task("a1", "completed")]));
      expect(r.intercept, cmd).toBe(false);
    }
  });

  test("已终态任务的 .output（另有任务在跑）→ 放", () => {
    const r = checkBackgroundPoll(
      "bash",
      { command: "cat ~/.sid-code/tasks/done1.output" },
      ctxWith([task("done1", "completed"), task("a1", "running")]),
    );
    expect(r.intercept).toBe(false);
  });

  test("tasks/sessions/、tasks/<team>/tasks.json、同前缀目录 → 放", () => {
    const ctx = ctxWith([task("a1", "running")]);
    for (const cmd of [
      "cat ~/.sid-code/tasks/sessions/x.json",
      "cat ~/.sid-code/tasks/myteam/tasks.json",
      "ls ~/.sid-code/tasks-old/",
      "git status",
    ]) {
      expect(checkBackgroundPoll("bash", { command: cmd }, ctx).intercept, cmd).toBe(false);
    }
  });

  test("自己 run_in_background 的命令 → 放", () => {
    const r = checkBackgroundPoll(
      "bash",
      { command: "ls ~/.sid-code/tasks/", run_in_background: true },
      ctxWith([task("a1", "running")]),
    );
    expect(r.intercept).toBe(false);
  });
});

describe("task_output / bg_task_get", () => {
  for (const name of ["task_output", "bg_task_get"]) {
    test(`${name}：运行中默认 block → 拦`, () => {
      const r = checkBackgroundPoll(name, { task_id: "a1" }, ctxWith([task("a1", "running")]));
      expect(r.intercept).toBe(true);
      if (r.intercept) expect(r.kind).toBe("blocking_wait");
      const r2 = checkBackgroundPoll(
        name,
        { task_id: "a1", block: true, timeout: 300000 },
        ctxWith([task("a1", "running")]),
      );
      expect(r2.intercept).toBe(true);
    });

    test(`${name}：block=false 快照 → 放`, () => {
      const r = checkBackgroundPoll(
        name,
        { task_id: "a1", block: false },
        ctxWith([task("a1", "running")]),
      );
      expect(r.intercept).toBe(false);
    });

    test(`${name}：终态 → 放`, () => {
      const r = checkBackgroundPoll(name, { task_id: "a1" }, ctxWith([task("a1", "completed")]));
      expect(r.intercept).toBe(false);
    });
  }
});

describe("bg_task_list（事故 20261106-101611-d0a96bc1：71 次同参轮询）", () => {
  test("第一次放行；状态不变再查 → 拦，回执带运行中任务与「不需要反复查询」", () => {
    const ctx = ctxWith([task("snh2czqxk", "running")]);
    expect(checkBackgroundPoll("bg_task_list", { status: "all" }, ctx).intercept).toBe(false);
    const r = checkBackgroundPoll("bg_task_list", { status: "all" }, ctx);
    expect(r.intercept).toBe(true);
    if (r.intercept) {
      expect(r.kind).toBe("status_poll");
      expect(r.taskIds).toEqual(["snh2czqxk"]);
      expect(r.output).toContain("snh2czqxk");
      expect(r.output).toContain("不需要反复查询");
    }
    // 之后一直拦
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(true);
  });

  test("状态变了（任务结束 / 新任务）→ 放行一次", () => {
    const a = task("a1", "running");
    const tasks = [a];
    const ctx = ctxWith(tasks);
    checkBackgroundPoll("bg_task_list", {}, ctx);
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(true);
    tasks.push(task("b2", "running"));
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(false);
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(true);
    (a as any).status = "completed";
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(false);
  });

  test("子代理工具调用数前进 → 算新信息，放行", () => {
    const a = task("a1", "running") as any;
    a.progress = { toolUseCount: 3, tokenCount: 100 };
    const ctx = ctxWith([a]);
    checkBackgroundPoll("bg_task_list", {}, ctx);
    a.progress = { toolUseCount: 3, tokenCount: 999 }; // token 数变化不算
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(true);
    a.progress = { toolUseCount: 4, tokenCount: 999 };
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(false);
  });

  test("D17：monitor 事件数前进 → 算新信息，放行；不变仍拦", () => {
    // 方案 §5.4.10「monitor 的已投递事件数算作进展」。此前签名只拼 id/status，
    // 同一个 monitor 从 0 条收到 2 条新事件后，第二次查询仍被当成「状态相同」拦掉。
    const m = monitorTask("m1", 0);
    const ctx = ctxWith([m]);
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(false); // 第一次放行
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(true); // 事件数不变 → 拦
    (m as { eventCount: number }).eventCount = 2;
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(false); // 收到 2 条新事件 → 放行
    expect(checkBackgroundPoll("bg_task_list", {}, ctx).intercept).toBe(true); // 再次不变 → 拦
  });

  test("换过滤条件 → 放行；没有运行中任务 → 永远放行", () => {
    const ctx = ctxWith([task("a1", "running")]);
    checkBackgroundPoll("bg_task_list", { status: "all" }, ctx);
    expect(checkBackgroundPoll("bg_task_list", { status: "running" }, ctx).intercept).toBe(false);
    const idle = ctxWith([task("a1", "completed")]);
    for (let i = 0; i < 3; i++) {
      expect(checkBackgroundPoll("bg_task_list", {}, idle).intercept).toBe(false);
    }
  });

  test("默认上下文的记忆可复位", () => {
    __resetBackgroundPollGuardForTest();
    expect(defaultBackgroundPollContext().taskListMemo.last).toBeNull();
  });
});

test("其它工具一律放", () => {
  const ctx = ctxWith([task("a1", "running")]);
  expect(checkBackgroundPoll("grep", { pattern: "x", path: out("a1") }, ctx).intercept).toBe(false);
  expect(checkBackgroundPoll("edit", { file_path: out("a1") }, ctx).intercept).toBe(false);
});

test("默认上下文只把后台且非终态的任务算作运行中", () => {
  // 空 registry：默认上下文下什么都不拦
  const ctx = defaultBackgroundPollContext();
  expect(ctx.runningBackgroundTasks()).toEqual([]);
  expect(checkBackgroundPoll("bash", { command: "ls ~/.sid-code/tasks/" }).intercept).toBe(false);
});
