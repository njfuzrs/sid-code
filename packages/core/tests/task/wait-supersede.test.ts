/**
 * R6：新起的等待会淘汰盯同一对象的旧等待（方案 §R6 验收 1–3）。
 *
 * 三组断言对应三处会独立失效的机制，任何一处漏掉都不会被另一处覆盖：
 * - 淘汰本身（replace 时旧任务必须进终态，否则它还占着进程与通知源）；
 * - 通知抑制（旧任务的 killed 通知对模型没有信息量，只会成为 R3 误读的素材）；
 * - 成功终态撤销唤醒（shell-deadline exit 0 也满足 S2 的「对象已成功终态」）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  __resetWaitRegistryForTest,
  invalidateWakeupsForDeliveredTask,
  listWaits,
  registerWait,
  setWaitTraceSink,
  setWakeupRegistrationEnabled,
} from "../../src/task/wait-registry.ts";
import {
  decideWaitAdmission,
  formatReplaceNote,
  supersedeReplacedWaits,
} from "../../src/task/wait-admission.ts";
import { clearAllTasks, getTask, registerTask, updateTask } from "../../src/task/registry.ts";
import { getScheduler, resetScheduler } from "../../src/cron/scheduler.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import type { LocalShellTaskState } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  // task registry / 通知队列都会落盘或读全局态 → 重定向（CONTRIBUTING 测试约定）
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wait-supersede-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  clearAllTasks();
  resetScheduler();
  dequeuePendingNotifications(); // 排空上一用例残留
});

afterEach(() => {
  setWaitTraceSink(null);
  __resetWaitRegistryForTest();
  clearAllTasks();
  resetScheduler();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

function shellTask(id: string, overrides: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `cmd ${id}`,
    startTime: Date.now(),
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: `run ${id}`,
    interrupted: false,
    isBackgrounded: true,
    ...overrides,
  };
}

/** 登记一条「显式声明了期限」的后台等待（等价于 bash + wait_until_seconds 成功之后） */
function addShellWait(
  id: string,
  opts: {
    subjects?: string[];
    command?: string;
    deadlineAt?: number;
    /** false = 普通后台任务（exit_or_quiescent），不是显式等待 */
    declared?: boolean;
  } = {},
): void {
  registerTask(shellTask(id, { command: opts.command ?? `run ${id}` }));
  registerWait({
    id,
    kind: "shell",
    promise:
      opts.declared === false
        ? { kind: "exit_or_quiescent" }
        : { kind: "deadline", deadlineAt: opts.deadlineAt ?? Date.now() + 600_000 },
    description: `wait ${id}`,
    registeredAt: Date.now(),
    subjects: opts.subjects,
    command: opts.command,
  });
}

/** 排一个盯住 subject 的唤醒（登记表 + 调度器都要有；撤销动作两处都改） */
function addWakeupWait(
  id: string,
  opts: { subjects?: string[]; deadlineAt?: number; command?: string } = {},
): void {
  setWakeupRegistrationEnabled(true);
  const deadlineAt = opts.deadlineAt ?? Date.now() + 600_000;
  // 唤醒必须同时进调度器：`listWaits` 对「还没触发且调度器里没有」的唤醒判失效
  // （cron_delete 之后要立刻不算等待源），只登记不调度会被当成已失效而过滤掉。
  getScheduler().addSessionTask({
    id,
    cron: "",
    prompt: `等 ${id}`,
    createdAt: Date.now(),
    recurring: false,
    durable: false,
    fireAt: deadlineAt,
    origin: "schedule_wakeup",
  });
  registerWait({
    id,
    kind: "wakeup",
    promise: { kind: "deadline", deadlineAt },
    description: `等 ${id}`,
    registeredAt: Date.now(),
    subjects: opts.subjects,
    command: opts.command,
  });
}

describe("R6 修法 1/2：replace 淘汰旧等待且不送通知", () => {
  test("验收 1：旧 shell 进 killed 终态、supersededBy 指向新任务、等待表只剩新的", () => {
    addShellWait("old1", { subjects: ["gh:pr:780"], command: "bash wait-merged.sh" });
    dequeuePendingNotifications();

    // 真实入口的顺序：判定在 spawn 之前（此时新任务还没有 id / 登记项）
    const decision = decideWaitAdmission({
      subjects: ["gh:pr:780"],
      command: "while true; do gh pr checks 780; sleep 30; done",
      deadlineAt: Date.now() + 3_600_000,
    });
    expect(decision.action).toBe("replace");

    // 先起新的（spawn + 登记），再停旧的——顺序是契约，见 supersedeReplacedWaits 注释
    addShellWait("new1", {
      subjects: ["gh:pr:780"],
      command: "while true; do gh pr checks 780; sleep 30; done",
    });
    const stopped = supersedeReplacedWaits(decision.existing, "new1");

    expect(stopped.map((s) => s.id)).toEqual(["old1"]);
    const oldTask = getTask("old1")!;
    expect(oldTask.status).toBe("killed");
    expect(oldTask.supersededBy).toBe("new1");
    expect(getTask("new1")!.status).toBe("running");
    // 等待表只剩新的：旧的登记项在 kill 之前已经按 superseded 释放
    expect(listWaits().map((w) => w.id)).toEqual(["new1"]);
  });

  test("验收 1（通知侧）：被替换的旧任务不送终态通知", () => {
    addShellWait("old1", { subjects: ["gh:pr:780"], command: "bash wait-merged.sh" });
    dequeuePendingNotifications();

    const decision = decideWaitAdmission({
      subjects: ["gh:pr:780"],
      command: "bash wait-merged-v2.sh",
      deadlineAt: Date.now() + 3_600_000,
    });
    addShellWait("new1", { subjects: ["gh:pr:780"], command: "bash wait-merged-v2.sh" });
    supersedeReplacedWaits(decision.existing, "new1");

    const pending = dequeuePendingNotifications();
    expect(pending.map((n) => n.structured?.taskId)).not.toContain("old1");
  });

  test("替换回执写明已替换的旧 id 与描述（模型据此知道旧的那条不再回报）", () => {
    addShellWait("old1", { subjects: ["gh:pr:780"], command: "bash wait-merged.sh" });
    const decision = decideWaitAdmission({
      subjects: ["gh:pr:780"],
      command: "bash wait-merged-v2.sh",
      deadlineAt: Date.now() + 3_600_000,
    });
    addShellWait("new1", { subjects: ["gh:pr:780"], command: "bash wait-merged-v2.sh" });
    const stopped = supersedeReplacedWaits(decision.existing, "new1");

    const note = formatReplaceNote(stopped, "new1");
    expect(note).toContain("已替换此前在盯同一对象的等待");
    expect(note).toContain("old1");
    expect(note).toContain("wait old1");
    expect(note).toContain("new1");
  });
});

describe("R6 修法 1：跨类替换（唤醒 〉 shell / monitor）", () => {
  test("验收 2：盯同一对象的唤醒被后台循环替换时撤销，记 WaitReleased(superseded)", () => {
    const trace: Array<{ event: string; data: Record<string, unknown> }> = [];
    setWaitTraceSink((event, data) => trace.push({ event, data }));

    addWakeupWait("wake1", { subjects: ["gh:pr:780"], deadlineAt: Date.now() + 600_000 });
    const decision = decideWaitAdmission({
      subjects: ["gh:pr:780"],
      command: "bash wait-merged.sh",
      deadlineAt: Date.now() + 3_600_000,
    });
    expect(decision.action).toBe("replace");

    addShellWait("s1", { subjects: ["gh:pr:780"], command: "bash wait-merged.sh" });
    const stopped = supersedeReplacedWaits(decision.existing, "s1");

    expect(stopped.map((s) => s.id)).toEqual(["wake1"]);
    expect(listWaits().map((w) => w.id)).toEqual(["s1"]);
    const released = trace.filter((t) => t.event === "WaitReleased" && t.data.id === "wake1");
    expect(released).toHaveLength(1);
    expect(released[0]!.data.reason).toBe("superseded");
    expect(getTask("s1")!.status).toBe("running");
  });

  test("子代理 / workflow 的等待不被顺手杀掉（它们是要等的产出，不是等法）", () => {
    // 直接构造一个 agent 等待源：真实路径下 isDeclaredExternalWait 不会把它带进 existing，
    // 这里显式验证 supersedeReplacedWaits 自身的边界（将来定义域放宽也不会误杀）。
    const stopped = supersedeReplacedWaits(
      [
        {
          id: "agent1",
          kind: "agent",
          promise: { kind: "exit_or_quiescent" },
          description: "正在跑的子代理",
          registeredAt: Date.now(),
          subjects: ["gh:pr:780"],
        },
      ],
      "new1",
    );
    expect(stopped).toEqual([]);
    expect(formatReplaceNote(stopped, "new1")).toBe("");
  });
});

describe("R6 修法 3：shell-deadline 成功终态撤销同 subject 的唤醒", () => {
  test("验收 3：exit 0 结束且通知已送达 → 唤醒被撤销", () => {
    addWakeupWait("wake1", { subjects: ["gh:pr:780"], deadlineAt: Date.now() + 600_000 });
    addShellWait("s1", { subjects: ["gh:pr:780"], command: "bash wait-merged.sh" });

    // shell 以 exit 0 成功终态：updateTask 触发 releaseTerminalWaits（D4），
    // 快照随之落地；送达侧再判撤销。
    updateTask("s1", (t) => ({ ...t, status: "completed", exitCode: 0 }));
    const victims = invalidateWakeupsForDeliveredTask("s1", "completed");

    expect(victims).toEqual(["wake1"]);
    expect(listWaits()).toEqual([]);
  });

  test("验收 3（反例）：exit 1 结束 → 不撤销（失败不是「对象已终态」）", () => {
    addWakeupWait("wake1", { subjects: ["gh:pr:780"], deadlineAt: Date.now() + 600_000 });
    addShellWait("s1", { subjects: ["gh:pr:780"], command: "bash wait-merged.sh" });

    updateTask("s1", (t) => ({ ...t, status: "failed", exitCode: 1 }));
    const victims = invalidateWakeupsForDeliveredTask("s1", "failed");

    expect(victims).toEqual([]);
    expect(listWaits().map((w) => w.id)).toEqual(["wake1"]);
  });

  test("普通后台 shell（exit_or_quiescent）成功终态不撤销唤醒", () => {
    // 收窄修法 3 的边界：只有模型显式声明的 deadline 等待才算「对象已终态」，
    // 普通后台命令跑完只说明它自己结束了。
    addWakeupWait("wake1", { subjects: ["gh:pr:780"], deadlineAt: Date.now() + 600_000 });
    addShellWait("bg1", { subjects: ["gh:pr:780"], command: "bun test", declared: false });

    updateTask("bg1", (t) => ({ ...t, status: "completed", exitCode: 0 }));
    const victims = invalidateWakeupsForDeliveredTask("bg1", "completed");

    expect(victims).toEqual([]);
    expect(listWaits().map((w) => w.id)).toContain("wake1");
  });
});
