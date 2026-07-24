/**
 * P2-2：共享任务列表持久化 + 认领调度 单测
 *
 * 覆盖：
 * - structured-task-store 的序列化/恢复往返
 * - claimNextUnblockedTask 按依赖顺序认领（B 依赖 A 时 A 完成前 B 不被认领）
 * - team-task-store 落盘 + 读回（原子写往返）
 * - 无环校验（wouldCreateCycle 经 addBlockedBy 触发）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStructuredTask,
  updateStructuredTask,
  getStructuredTask,
  serializeStructuredTasks,
  restoreStructuredTasks,
  claimNextUnblockedTask,
  hasUnfinishedTasks,
  __clearStructuredTasks,
} from "../../src/task/structured-task-store.ts";
import { persistTeamTasks, loadTeamTasks, teamTasksPath } from "../../src/task/team-task-store.ts";

let dir: string;

beforeEach(() => {
  __clearStructuredTasks();
  dir = mkdtempSync(join(tmpdir(), "sid-team-tasks-"));
});

afterEach(() => {
  __clearStructuredTasks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("structured-task-store 持久化原语", () => {
  it("序列化/恢复往返保留任务与依赖", () => {
    const a = createStructuredTask({ subject: "A", description: "任务A" });
    const b = createStructuredTask({ subject: "B", description: "任务B" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });

    const snapshot = serializeStructuredTasks();
    expect(snapshot.length).toBe(2);

    __clearStructuredTasks();
    expect(serializeStructuredTasks().length).toBe(0);

    restoreStructuredTasks(snapshot);
    const restoredB = getStructuredTask(b.id)!;
    expect(restoredB.blockedBy).toContain(a.id);
    const restoredA = getStructuredTask(a.id)!;
    expect(restoredA.blocks).toContain(b.id);
  });

  it("恢复后新建任务 ID 不与快照撞车", () => {
    createStructuredTask({ subject: "A", description: "a" }); // id=1
    createStructuredTask({ subject: "B", description: "b" }); // id=2
    const snapshot = serializeStructuredTasks();
    __clearStructuredTasks();
    restoreStructuredTasks(snapshot);
    const c = createStructuredTask({ subject: "C", description: "c" });
    expect(c.id).toBe("3"); // idCounter 恢复到 max(2) 后自增
  });

  it("claimNextUnblockedTask 尊重依赖顺序", () => {
    const a = createStructuredTask({ subject: "A", description: "先做" });
    const b = createStructuredTask({ subject: "B", description: "后做" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });

    // 第一次认领只能拿到 A（B 被 A 阻塞）
    const first = claimNextUnblockedTask("worker1");
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe("in_progress");
    expect(first?.owner).toBe("worker1");

    // A 未完成时 B 不可认领
    const blocked = claimNextUnblockedTask("worker2");
    expect(blocked).toBeUndefined();

    // A 完成后 B 解锁
    updateStructuredTask(a.id, { status: "completed" });
    const second = claimNextUnblockedTask("worker2");
    expect(second?.id).toBe(b.id);
  });

  it("hasUnfinishedTasks 反映完成态", () => {
    const a = createStructuredTask({ subject: "A", description: "a" });
    expect(hasUnfinishedTasks()).toBe(true);
    updateStructuredTask(a.id, { status: "completed" });
    expect(hasUnfinishedTasks()).toBe(false);
  });

  it("addBlockedBy 成环被拒绝", () => {
    const a = createStructuredTask({ subject: "A", description: "a" });
    const b = createStructuredTask({ subject: "B", description: "b" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] }); // a → b
    // 再让 a 依赖 b 会成环 → 拒绝
    const res = updateStructuredTask(a.id, { addBlockedBy: [b.id] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("循环");
  });
});

describe("team-task-store 落盘/读回", () => {
  it("持久化后文件存在且可读回", () => {
    const a = createStructuredTask({ subject: "A", description: "任务A" });
    const b = createStructuredTask({ subject: "B", description: "任务B" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });

    persistTeamTasks("my-team", dir);
    expect(existsSync(teamTasksPath("my-team", dir))).toBe(true);

    // 清空内存后从磁盘读回
    __clearStructuredTasks();
    expect(serializeStructuredTasks().length).toBe(0);

    const loaded = loadTeamTasks("my-team", dir);
    expect(loaded).toBe(true);
    expect(serializeStructuredTasks().length).toBe(2);
    expect(getStructuredTask(b.id)!.blockedBy).toContain(a.id);
  });

  it("团队任务文件不存在时 loadTeamTasks 返回 false", () => {
    expect(loadTeamTasks("no-such-team", dir)).toBe(false);
  });

  it("团队名安全化防路径穿越", () => {
    const p = teamTasksPath("../../etc/passwd", dir);
    expect(p).not.toContain("..");
    expect(p).toContain("_");
  });
});
