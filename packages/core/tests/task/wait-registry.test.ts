/**
 * W1/W2/W3：等待登记表与合法等待态判据（PR 1 验收）
 *
 * 覆盖方案 §9.1 的 T-W1-* / T-W2-* / T-W3-*。测试编号在每条 test 名里，
 * 便于与方案文档对照。
 *
 * 不写盘：wait-registry 是进程内会话级数据（设计如此，见文件头 §5.1.6），
 * scheduler 的单例在本文件里用 `resetScheduler()` 收尾，不触碰真实 `~/.sid-code/`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  __resetWaitRegistryForTest,
  __setMonoClockForTest,
  DEADLINE_GRACE_MS,
  drainWaitNotices,
  extractWaitSubjects,
  hasPromisedWait,
  invalidateWakeups,
  isWaitInvalidated,
  listWaits,
  registerWait,
  releaseAllWaits,
  releaseWait,
  setWaitTraceSink,
  setWakeupRegistrationEnabled,
} from "../../src/task/wait-registry.ts";
import {
  __resetBackgroundAwaitForTest,
  SHELL_QUIESCENT_MS,
  trackShellActivity,
} from "../../src/task/background-await.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import { resetScheduler, getScheduler } from "../../src/cron/scheduler.ts";
import { hasAwaitedBackgroundTasks } from "../../src/task/background-await.ts";
import type { CronTask } from "../../src/cron/types.ts";
import type {
  LocalAgentTaskState,
  LocalShellTaskState,
  LocalWorkflowTaskState,
} from "../../src/task/types.ts";

const T0 = 1_700_000_000_000;

function shellTask(id: string, overrides: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `cmd ${id}`,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: `run ${id}`,
    interrupted: false,
    isBackgrounded: true,
    ...overrides,
  };
}

function agentTask(id: string): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: `agent ${id}`,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    agentType: "explore",
    prompt: "p",
    isBackgrounded: true,
  };
}

function workflowTask(id: string): LocalWorkflowTaskState {
  return {
    id,
    type: "local_workflow",
    status: "running",
    description: `wf ${id}`,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    workflowName: "wf",
    runId: "r1",
    source: "inline",
    isBackgrounded: true,
  };
}

/** 起一条会话级唤醒（等价于 schedule_wakeup 成功后的调度器状态） */
function addWakeupTask(
  id: string,
  fireAt: number,
  origin: CronTask["origin"] = "schedule_wakeup",
): CronTask {
  const task: CronTask = {
    id,
    cron: "",
    prompt: `检查 PR #662 的 CI 状态 ${id}`,
    createdAt: T0,
    recurring: false,
    durable: false,
    fireAt,
    origin,
  };
  getScheduler().addSessionTask(task);
  return task;
}

beforeEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  // task registry 是模块级单例：不清会把上一个用例的 running 任务带进来，
  // 派生口径会把它们算成等待源（实测 T-W2-2 因此恒真）
  clearAllTasks();
  resetScheduler();
  getScheduler({ onFire: () => {}, isLoading: () => false, sessionId: "t", workspaceDir: "/tmp" });
});

afterEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  resetScheduler();
});

describe("W1 等待登记表", () => {
  test("T-W1-1 登记/释放/同 id 覆盖不重复", () => {
    const src = {
      id: "s1",
      kind: "shell" as const,
      promise: { kind: "deadline" as const, deadlineAt: Date.now() + 60_000 },
      description: "等 CI",
      registeredAt: Date.now(),
    };
    registerTask(shellTask("s1"));
    registerWait(src);
    expect(listWaits().filter((w) => w.id === "s1")).toHaveLength(1);
    // 同 id 再登记一次：覆盖，不重复
    registerWait({ ...src, description: "等 CI（改）" });
    const after = listWaits().filter((w) => w.id === "s1");
    expect(after).toHaveLength(1);
    expect(after[0]!.description).toBe("等 CI（改）");

    releaseWait("s1", "terminal");
    // 释放的只是**显式登记**：任务本身还在 registry 里 running，于是退回派生口径
    // （promise 从 deadline 变成 exit_or_quiescent）。这是设计：派生不是第二份事实源。
    expect(listWaits().find((w) => w.id === "s1")?.promise.kind).toBe("exit_or_quiescent");
    // 幂等：再释放不抛错
    expect(releaseWait("s1", "terminal")).toBe(false);
  });

  test("T-W1-2 agent / workflow / 普通 shell 从 task registry 派生", () => {
    registerTask(agentTask("a1"));
    registerTask(workflowTask("w1"));
    registerTask(shellTask("s1"));
    trackShellActivity("s1", 0, Date.now());

    const waits = listWaits();
    const byId = new Map(waits.map((w) => [w.id, w]));
    expect(byId.get("a1")?.kind).toBe("agent");
    expect(byId.get("a1")?.promise.kind).toBe("terminal");
    expect(byId.get("w1")?.kind).toBe("workflow");
    expect(byId.get("w1")?.promise.kind).toBe("terminal");
    expect(byId.get("s1")?.kind).toBe("shell");
    expect(byId.get("s1")?.promise.kind).toBe("exit_or_quiescent");
  });

  test("T-W1-4 wait_until shell 静默 > 60s 仍算等待；普通 shell 不算", () => {
    // 普通 shell：静默超过 60s → 不算（20261103 常驻服务事故的修复，不能回退）
    registerTask(shellTask("plain"));
    trackShellActivity("plain", 0, T0);
    expect(hasPromisedWait(T0 + SHELL_QUIESCENT_MS + 1)).toBe(false);

    // 显式声明了期限的 shell：同样的静默时长仍算等待
    registerTask(shellTask("waiting"));
    registerWait({
      id: "waiting",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 600_000 },
      description: "等健康检查",
      registeredAt: Date.now(),
    });
    expect(hasPromisedWait(Date.now() + SHELL_QUIESCENT_MS + 1)).toBe(true);
  });

  test("T-W1-6 期限 + 宽限后仍无回报：判无效 + late 事件 + failed 通知", () => {
    let mono = 0;
    __setMonoClockForTest(() => mono);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    setWaitTraceSink((event, data) => events.push({ event, data }));

    registerTask(shellTask("lost"));
    registerWait({
      id: "lost",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 1_000 },
      description: "等一个不会回报的命令",
      registeredAt: Date.now(),
    });
    // 期限内
    expect(hasPromisedWait()).toBe(true);
    // 越过期 + 宽限：该显式 deadline 源不再计入（任务本身仍在 registry 里，会退回派生口径）
    mono = 1_000 + DEADLINE_GRACE_MS + 1;
    expect(listWaits().some((w) => w.id === "lost" && w.promise.kind === "deadline")).toBe(false);
    const released = events.find(
      (e) => e.event === "WaitReleased" && e.data.id === "lost" && e.data.late === true,
    );
    expect(released).toBeDefined();
    expect(released!.data.reason).toBe("expired");
    expect(isWaitInvalidated("lost")).toBe(true);
  });

  test("T-W1-9 回拨 Date.now() 不影响期限判定（单调时钟）", () => {
    let mono = 1_000_000;
    __setMonoClockForTest(() => mono);
    registerTask(shellTask("clock"));
    registerWait({
      id: "clock",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "等 1 分钟",
      registeredAt: Date.now(),
    });
    // 单调时钟前进 10s，系统时钟回拨 1 小时：仍有效
    mono += 10_000;
    const realNow = Date.now;
    try {
      Date.now = () => T0 - 3_600_000;
      expect(hasPromisedWait()).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test("T-W1-10 会话结束：全部释放且条数对得上", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    setWaitTraceSink((event, data) => events.push({ event, data }));
    setWakeupRegistrationEnabled(true);
    registerTask(shellTask("s1"));
    registerWait({
      id: "s1",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "a",
      registeredAt: Date.now(),
    });
    addWakeupTask("wk1", Date.now() + 60_000);
    registerWait({
      id: "wk1",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "b",
      registeredAt: Date.now(),
    });

    expect(releaseAllWaits("session_end")).toBe(2);
    const sessionEnd = events.filter(
      (e) => e.event === "WaitReleased" && e.data.reason === "session_end",
    );
    expect(sessionEnd).toHaveLength(2);
    // 显式登记清空 = 没有 deadline 类源了；任务本体仍在 registry（派生口径照常）
    expect(listWaits().filter((w) => w.promise.kind === "deadline")).toHaveLength(0);
  });

  test("T-W1-11 新 registry（模拟 resume）为空", () => {
    registerTask(shellTask("s1"));
    registerWait({
      id: "s1",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "a",
      registeredAt: Date.now(),
    });
    expect(listWaits().length).toBeGreaterThan(0);
    __resetWaitRegistryForTest();
    // 登记表清空后没有显式源；registry 里的任务仍在（模拟 resume 时进程已重启，
    // 真实场景里 registry 也是空的，这里只断言登记表这一侧）
    expect(listWaits().filter((w) => w.promise.kind === "deadline")).toHaveLength(0);
  });
});

describe("W2 判据统一（hasPromisedWait ⊇ hasAwaitedBackgroundTasks）", () => {
  test("T-W2-1 无新等待源时，两个判据在五种组合下结果完全相同", () => {
    const now = T0 + 10_000;
    const cases: Array<() => void> = [
      // 1) agent
      () => registerTask(agentTask("a1")),
      // 2) workflow
      () => registerTask(workflowTask("w1")),
      // 3) 普通 shell（有输出）
      () => {
        registerTask(shellTask("s1"));
        trackShellActivity("s1", 0, now);
      },
      // 4) 静默 shell
      () => {
        registerTask(shellTask("s2"));
        trackShellActivity("s2", 0, now - SHELL_QUIESCENT_MS - 1);
      },
      // 5) 憋输出 shell（`… | tail -60`）
      () => {
        registerTask(shellTask("s3", { command: "bun test 2>&1 | tail -60" }));
        trackShellActivity("s3", 0, now - SHELL_QUIESCENT_MS * 10);
      },
    ];
    for (const setup of cases) {
      __resetWaitRegistryForTest();
      __resetBackgroundAwaitForTest();
      setup();
      expect(hasPromisedWait(now)).toBe(hasAwaitedBackgroundTasks(now));
    }
  });

  test("T-W2-2 只有静默普通 shell：判「不值得等」（20261103 事故不回退）", () => {
    const now = T0 + SHELL_QUIESCENT_MS + 1;
    registerTask(shellTask("srv"));
    trackShellActivity("srv", 0, T0);
    expect(hasPromisedWait(now)).toBe(false);
  });

  test("T-W2-7 复现 7dd98bf5：清单剩 3 项 + 已排 1500s 唤醒 + 静默 shell → 判「有承诺」", () => {
    // 改动前：hasAwaitedBackgroundTasks=false（静默 shell 不算）→ T2 判「没人会回来」→ 强推
    // 改动后：唤醒登记为 deadline 源 → hasPromisedWait=true → T2 放行
    registerTask(shellTask("bg"));
    trackShellActivity("bg", 0, T0);
    setWakeupRegistrationEnabled(true);
    const fireAt = T0 + 1_500_000;
    addWakeupTask("7cfaa702", fireAt);
    registerWait({
      id: "7cfaa702",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: fireAt },
      description: "检查 PR #662 的 CI 状态",
      registeredAt: T0,
      subjects: ["gh:pr:662"],
    });

    expect(hasPromisedWait(Date.now())).toBe(true);

    // T-W2-9：收尾事实里的 promised_waits 就是 listWaits().length（同一口径）
    expect(listWaits().length).toBe(1);
  });

  test("T-W2-6 无头模式（未开注入通道）：schedule_wakeup 不登记，行为与改动前相同", () => {
    // wakeupRegistrationEnabled 默认 false（beforeEach 已复位）
    addWakeupTask("wk-noh", Date.now() + 60_000);
    const ok = registerWait({
      id: "wk-noh",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "x",
      registeredAt: Date.now(),
    });
    expect(ok).toBe(false);
    expect(hasPromisedWait()).toBe(false);
  });
});

describe("W3 唤醒登记与确定信号失效", () => {
  test("T-W3-1 登记 / 替换 / cron_delete / 注入 的四种释放原因", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    setWaitTraceSink((event, data) => events.push({ event, data }));
    setWakeupRegistrationEnabled(true);

    addWakeupTask("wk1", Date.now() + 60_000);
    registerWait({
      id: "wk1",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "w1",
      registeredAt: Date.now(),
    });
    // 被替换：调度器删旧 + 登记表释放 superseded（与 schedule-wakeup 工具的两步同构）
    getScheduler().removeTask("wk1");
    releaseWait("wk1", "superseded");
    expect(events.some((e) => e.data.reason === "superseded")).toBe(true);

    // cron_delete 路径
    addWakeupTask("wk2", Date.now() + 60_000);
    registerWait({
      id: "wk2",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "w2",
      registeredAt: Date.now(),
    });
    releaseWait("wk2", "cancelled");
    expect(events.some((e) => e.data.reason === "cancelled")).toBe(true);

    // 注入路径
    addWakeupTask("wk3", Date.now() + 60_000);
    registerWait({
      id: "wk3",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
      description: "w3",
      registeredAt: Date.now(),
    });
    releaseWait("wk3", "terminal");
    expect(events.some((e) => e.data.reason === "terminal")).toBe(true);
  });

  test("T-W3-2 /loop 与 cron_create 的任务不登记为等待源", () => {
    setWakeupRegistrationEnabled(true);
    addWakeupTask("loop1", Date.now() + 60_000, "loop");
    addWakeupTask("cron1", Date.now() + 60_000, "cron_create");
    // 两个任务都在调度器里，但没人给它们 registerWait（工具层只在 schedule_wakeup 里调用）
    expect(listWaits().some((w) => w.id === "loop1" || w.id === "cron1")).toBe(false);
  });

  test("T-W3-3 / T-W3-6 / T-W3-5 S1：清单清零撤销；从未写清单不触发；撤销后不恢复", async () => {
    const { TodoWriteTool } = await import("../../src/tool/todo-write.ts");
    setWakeupRegistrationEnabled(true);
    const fireAt = Date.now() + 600_000;
    addWakeupTask("wk-s1", fireAt);
    registerWait({
      id: "wk-s1",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: fireAt },
      description: "等 CI",
      registeredAt: Date.now(),
    });

    const tool = new TodoWriteTool();
    // T-W3-6：从未 todo_write 的会话，S1 没有「之前 > 0」的前提，唤醒仍在
    expect(listWaits().some((w) => w.id === "wk-s1")).toBe(true);

    // T-W3-6 变体（MUT-5 的哨兵）：写入的清单本来就空（之前也 0 项）→ 不是「清零」，
    // 不撤销。少了这条断言，「每次 todo_write 都撤销」的改坏方式不会被任何用例抓到。
    await tool.execute({ todos: [] });
    expect(listWaits().some((w) => w.id === "wk-s1")).toBe(true);

    // 先写一份有未完成项的清单（此时不该撤销）
    await tool.execute({
      todos: [
        { content: "改代码", active_form: "正在改代码", status: "in_progress" },
        { content: "提 PR", active_form: "正在提 PR", status: "pending" },
      ],
    });
    expect(listWaits().some((w) => w.id === "wk-s1")).toBe(true);

    // 清单清零 → S1 触发
    await tool.execute({
      todos: [{ content: "改代码", active_form: "正在改代码", status: "completed" }],
    });
    expect(listWaits().some((w) => w.id === "wk-s1")).toBe(false);
    expect(isWaitInvalidated("wk-s1")).toBe(true);
    expect(getScheduler().getSessionTask("wk-s1")).toBeUndefined();
    const notice = drainWaitNotices().find((n) => n.taskId === "wk-s1");
    expect(notice).toBeDefined();

    // T-W3-5：撤销后写新清单，旧唤醒不恢复
    await tool.execute({
      todos: [{ content: "新任务", active_form: "正在做新任务", status: "in_progress" }],
    });
    expect(listWaits().some((w) => w.id === "wk-s1")).toBe(false);
  });

  test("T-W3-9 / T-W3-10 S2：同 subject 终态撤销；抽不到 subject 不撤销", () => {
    setWakeupRegistrationEnabled(true);
    const fireAt = Date.now() + 600_000;
    addWakeupTask("wk-s2", fireAt);
    registerWait({
      id: "wk-s2",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: fireAt },
      description: "检查 PR #662",
      registeredAt: Date.now(),
      subjects: extractWaitSubjects("检查 PR #662 的 CI"),
    });
    addWakeupTask("wk-nosub", fireAt);
    registerWait({
      id: "wk-nosub",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: fireAt },
      description: "等一个说不清的对象",
      registeredAt: Date.now(),
    });

    // 抽不到 subject 的唤醒不受 S2 影响
    const victims = invalidateWakeups("subject_terminal", {
      subject: "gh:pr:662",
      reasonText: "被等对象已终态",
    });
    expect(victims).toEqual(["wk-s2"]);
    expect(listWaits().some((w) => w.id === "wk-nosub")).toBe(true);
  });

  test("extractWaitSubjects 抽取已知实体（PR / pull / run）", () => {
    expect(extractWaitSubjects("等 PR #662 的 CI")).toContain("gh:pr:662");
    expect(extractWaitSubjects("看 pull/662 合并")).toContain("gh:pr:662");
    expect(extractWaitSubjects("等 run 12345678 结束")).toContain("gh:run:12345678");
    expect(extractWaitSubjects("随便等着")).toEqual([]);
  });
});
