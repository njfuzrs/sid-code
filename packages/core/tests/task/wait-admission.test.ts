/**
 * R2：等待准入判定的真值表（方案 §R2 验收 1）。
 *
 * 三条判据各有独立的失效形态，所以每条都单独覆盖：
 * - 对象维度：不同 subject → start（否则「等 PR + 跑 bun test」会被误拦，a7d1c888 的形态）；
 * - 命令维度：同 subject 同命令 → duplicate；同 subject 不同命令 / 脚本内容变了 → replace；
 * - 期限维度：新期限落在已有剩余期限之内 → duplicate（b0aa0f1e 第 2 次：命令一样、
 *   期限从 1800 缩到 1500）；
 * - 「已有等待已终态」→ start（否则模型永远挂不上新的，因为旧的那条已经不在了却还挡着）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  WAIT_ADMISSION_EVENT_NAME,
  __resetWaitRegistryForTest,
  registerWait,
  releaseWait,
  listWaits,
  setWaitTraceSink,
} from "../../src/task/wait-registry.ts";
import {
  decideWaitAdmission,
  findActiveWaitsBySubjects,
  formatDuplicateWaitReceipt,
  stopCommand,
} from "../../src/task/wait-admission.ts";
import { clearAllTasks, registerTask, updateTask } from "../../src/task/registry.ts";
import { resetScheduler } from "../../src/cron/scheduler.ts";
import type { LocalShellTaskState } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  // task registry 会往 tasks 目录落盘 → 重定向（CONTRIBUTING 测试约定）
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wait-admission-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  clearAllTasks();
  resetScheduler();
});

afterEach(() => {
  __resetWaitRegistryForTest();
  clearAllTasks();
  resetScheduler();
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
    scriptHash?: string;
    deadlineAt?: number;
  } = {},
): void {
  registerTask(shellTask(id, { command: opts.command ?? `run ${id}` }));
  registerWait({
    id,
    kind: "shell",
    promise: { kind: "deadline", deadlineAt: opts.deadlineAt ?? Date.now() + 600_000 },
    description: `wait ${id}`,
    registeredAt: Date.now(),
    subjects: opts.subjects,
    command: opts.command,
    scriptHash: opts.scriptHash,
  });
}

describe("R2 准入真值表", () => {
  test("不同 subject → start（不误伤并行的无关等待）", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:741"],
      command: "bash /tmp/wait-pr-741.sh",
    });
    expect(decision.action).toBe("start");
    expect(decision.existing).toEqual([]);
  });

  test("同 subject 同命令 → duplicate（b0aa0f1e 后三次）", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
    });
    expect(decision.action).toBe("duplicate");
    expect(decision.existing.map((w) => w.id)).toEqual(["s1"]);
  });

  test("同 subject 不同命令 → replace（换了一种等法）", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:779"],
      command: "while true; do gh pr checks 779; sleep 30; done",
      deadlineAt: Date.now() + 3_600_000,
    });
    expect(decision.action).toBe("replace");
    expect(decision.existing.map((w) => w.id)).toEqual(["s1"]);
  });

  test("同 subject 同命令但脚本正文变了 → replace（b0aa0f1e 10:55:27 改过脚本）", () => {
    addShellWait("s1", {
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
      scriptHash: "aaaa1111",
    });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
      scriptHash: "bbbb2222",
    });
    expect(decision.action).toBe("replace");
  });

  test("同 subject 同命令同脚本 → duplicate", () => {
    addShellWait("s1", {
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
      scriptHash: "aaaa1111",
    });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
      scriptHash: "aaaa1111",
    });
    expect(decision.action).toBe("duplicate");
  });

  test("新期限落在已有等待剩余期限之内 → duplicate（即使命令写法不同）", () => {
    const deadlineAt = Date.now() + 1_800_000;
    addShellWait("s1", { subjects: ["gh:pr:780"], command: "bash a.sh", deadlineAt });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:780"],
      command: "for i in {1..40}; do gh pr view 780; sleep 30; done",
      deadlineAt: Date.now() + 1_500_000,
    });
    expect(decision.action).toBe("duplicate");
  });

  test("新期限更长且命令不同 → replace（不是重复：能收到旧等待收不到的信息）", () => {
    const deadlineAt = Date.now() + 1_500_000;
    addShellWait("s1", { subjects: ["gh:pr:780"], command: "bash a.sh", deadlineAt });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:780"],
      command: "bash b.sh",
      deadlineAt: Date.now() + 3_000_000,
    });
    expect(decision.action).toBe("replace");
  });

  test("已有等待已终态（releaseWait 之后）→ start", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
    releaseWait("s1", "terminal");
    // 任务本身也终态：派生口径不再把它算成显式等待
    updateTask("s1", (t) => ({ ...t, status: "completed" }));

    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
    });
    expect(decision.action).toBe("start");
  });

  test("新等待无 subject → start（抽不出对象就不参与去重）", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
    expect(decideWaitAdmission({ kind: "shell", command: "bun test" }).action).toBe("start");
    expect(decideWaitAdmission({ kind: "shell", subjects: [], command: "bun test" }).action).toBe(
      "start",
    );
  });

  test("排除自身 id（同一任务重复登记不算重复）", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
    const decision = decideWaitAdmission({
      kind: "shell",
      id: "s1",
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
    });
    expect(decision.action).toBe("start");
  });

  test("普通后台任务（无期限承诺）不参与去重（a7d1c888 的反例）", () => {
    // 普通后台 shell：promise 是 exit_or_quiescent → 不是显式等待
    registerTask(shellTask("bg1", { description: "bun test" }));
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:741"],
      command: "bash /tmp/wait-pr-741.sh",
    });
    expect(decision.action).toBe("start");
  });

  test("findActiveWaitsBySubjects 按对象精确命中", () => {
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash a.sh" });
    addShellWait("s2", { subjects: ["gh:run:123"], command: "bash b.sh" });
    expect(findActiveWaitsBySubjects(["gh:pr:779"]).map((w) => w.id)).toEqual(["s1"]);
    expect(
      findActiveWaitsBySubjects(["gh:pr:779", "gh:run:123"])
        .map((w) => w.id)
        .sort(),
    ).toEqual(["s1", "s2"]);
    expect(findActiveWaitsBySubjects(["gh:pr:999"])).toEqual([]);
  });
});

describe("R2 duplicate 回执", () => {
  test("说明未启动、给出对象与最晚回报、给出 task_stop 出口", () => {
    const deadlineAt = Date.now() + 1_500_000;
    addShellWait("s1", {
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
      deadlineAt,
    });
    const decision = decideWaitAdmission({
      kind: "shell",
      subjects: ["gh:pr:779"],
      command: "bash /tmp/wait-pr-779.sh",
    });
    const text = formatDuplicateWaitReceipt(decision.existing, ["gh:pr:779"]);

    expect(text).toContain("本次未重复启动");
    expect(text).toContain("s1");
    expect(text).toContain("gh:pr:779");
    expect(text).toContain("最晚");
    expect(text).toContain("task_stop s1");
    // 「不需要手动查询」是 R3 误读的反证：模型没有任何理由再去前台查同一个对象
    expect(text).toContain("不需要手动查询");
  });

  test("唤醒的出口是 cron_delete 而不是 task_stop（唤醒不在 task registry 里）", () => {
    expect(
      stopCommand({
        id: "w1",
        kind: "wakeup",
        promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
        description: "等 CI",
        registeredAt: Date.now(),
      }),
    ).toBe("cron_delete w1");
    expect(
      stopCommand({
        id: "m1",
        kind: "monitor",
        promise: { kind: "deadline", deadlineAt: Date.now() + 60_000 },
        description: "等 CI",
        registeredAt: Date.now(),
      }),
    ).toBe("task_stop m1");
  });

  test("历史遗留的多个同对象等待也回显，避免模型以为只剩一条", () => {
    const deadlineAt = Date.now() + 600_000;
    addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash a.sh", deadlineAt });
    addShellWait("s2", { subjects: ["gh:pr:779"], command: "bash b.sh", deadlineAt });
    const existing = listWaits().filter((w) => w.subjects?.includes("gh:pr:779"));
    const text = formatDuplicateWaitReceipt(existing, ["gh:pr:779"]);
    expect(text).toContain("另有 1 个同对象等待也在跑");
    expect(text).toContain("s2");
  });
});

describe("R9：判定落 WaitAdmission 事件（判定事实与登记事实分开）", () => {
  test("duplicate 也落一条，字段能对上 tool_use 与既有等待", () => {
    const trace: Array<{ event: string; data: Record<string, unknown> }> = [];
    setWaitTraceSink((event, data) => trace.push({ event, data }));
    try {
      addShellWait("s1", { subjects: ["gh:pr:779"], command: "bash /tmp/wait-pr-779.sh" });
      const decision = decideWaitAdmission({
        kind: "shell",
        toolUseId: "call_r9",
        subjects: ["gh:pr:779"],
        command: "bash /tmp/wait-pr-779.sh",
      });
      expect(decision.action).toBe("duplicate");
      // 关键：这次调用**没有登记**（判成 duplicate 直接返回回执），
      // 只有 WaitAdmission 事件能在轨迹里留下「模型试过一次重复等待」。
      const ev = trace.filter((t) => t.event === WAIT_ADMISSION_EVENT_NAME);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.data).toMatchObject({
        action: "duplicate",
        kind: "shell",
        subjects: ["gh:pr:779"],
        existing_ids: ["s1"],
        tool_use_id: "call_r9",
      });
    } finally {
      setWaitTraceSink(null);
    }
  });

  test("抽不出 subjects 的 start 也落一条（「无法判定对象」本身是可观测事实）", () => {
    const trace: Array<{ event: string; data: Record<string, unknown> }> = [];
    setWaitTraceSink((event, data) => trace.push({ event, data }));
    try {
      const decision = decideWaitAdmission({ kind: "wakeup", command: "过 10 分钟看看" });
      expect(decision.action).toBe("start");
      const ev = trace.filter((t) => t.event === WAIT_ADMISSION_EVENT_NAME);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.data.action).toBe("start");
      expect(ev[0]!.data.kind).toBe("wakeup");
      expect(ev[0]!.data.subjects).toBeUndefined();
    } finally {
      setWaitTraceSink(null);
    }
  });
});
