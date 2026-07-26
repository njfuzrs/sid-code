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
  getAllStructuredTasks,
  getTeamTasks,
  clearTeamTasks,
  serializeStructuredTasks,
  serializeTeamTasks,
  restoreStructuredTasks,
  restoreTeamTasks,
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
    // 团队任务须带 metadata.team 标记才落该团队分区（无标记的是主会话 TODO，不入团队文件）。
    const a = createStructuredTask({ subject: "A", description: "任务A", metadata: { team: "my-team" } });
    const b = createStructuredTask({ subject: "B", description: "任务B", metadata: { team: "my-team" } });
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

  it("无 team 标记的主会话 TODO 不会被写进团队文件", () => {
    createStructuredTask({ subject: "主会话TODO", description: "d" });
    persistTeamTasks("my-team", dir);
    // 文件仍会生成（空 tasks 数组），但读回后团队分区为空、主会话任务不受影响
    __clearStructuredTasks();
    loadTeamTasks("my-team", dir);
    expect(getTeamTasks("my-team").length).toBe(0);
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

describe("团队分区与主会话 TODO 隔离", () => {
  /** 建一个团队分区任务（带 metadata.team 标记）。 */
  const teamTask = (team: string, subject: string, member?: string) =>
    createStructuredTask({
      subject,
      description: subject,
      metadata: { team, ...(member ? { member } : {}) },
    });

  it("getTeamTasks 只返回本团队分区任务", () => {
    createStructuredTask({ subject: "主会话TODO", description: "无team标记" });
    teamTask("alpha", "A1");
    teamTask("beta", "B1");

    expect(getTeamTasks("alpha").map((t) => t.subject)).toEqual(["A1"]);
    expect(getTeamTasks("beta").map((t) => t.subject)).toEqual(["B1"]);
    expect(getAllStructuredTasks().length).toBe(3);
  });

  it("clearTeamTasks 不动主会话 TODO 与其他团队", () => {
    const own = createStructuredTask({ subject: "主会话TODO", description: "d" });
    teamTask("alpha", "A1");
    const betaTask = teamTask("beta", "B1");

    clearTeamTasks("alpha");

    expect(getTeamTasks("alpha").length).toBe(0);
    expect(getStructuredTask(own.id)).toBeDefined();
    expect(getStructuredTask(betaTask.id)).toBeDefined();
  });

  it("serializeTeamTasks 只落本团队任务（不把主会话 TODO 写进团队文件）", () => {
    createStructuredTask({ subject: "主会话TODO", description: "d" });
    teamTask("alpha", "A1");
    teamTask("alpha", "A2");

    const snap = serializeTeamTasks("alpha");
    expect(snap.length).toBe(2);
    expect(snap.every((t) => (t.metadata as { team?: string }).team === "alpha")).toBe(true);
  });

  it("persistTeamTasks/loadTeamTasks 往返不吞掉主会话 TODO", () => {
    const own = createStructuredTask({ subject: "主会话TODO", description: "d" });
    teamTask("alpha", "A1", "worker1");

    persistTeamTasks("alpha", dir);
    // 模拟：团队分区被清掉（重启/成员集变更），主会话 TODO 仍在内存
    clearTeamTasks("alpha");
    expect(getTeamTasks("alpha").length).toBe(0);

    expect(loadTeamTasks("alpha", dir)).toBe(true);
    expect(getTeamTasks("alpha").length).toBe(1);
    // 关键断言：恢复团队任务没有清掉主会话自己的 TODO
    expect(getStructuredTask(own.id)).toBeDefined();
    expect(getStructuredTask(own.id)!.subject).toBe("主会话TODO");
  });

  it("恢复时 ID 与现存任务撞车 → 重映射且依赖边随之改写", () => {
    // 先造一份团队快照：ID 1(A) ← 2(B)，B 依赖 A
    const a = teamTask("alpha", "A");
    const b = teamTask("alpha", "B");
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });
    const snap = serializeTeamTasks("alpha");
    expect(snap.map((t) => t.id)).toEqual(["1", "2"]);

    // 换一个全新内存态：ID 1、2 被主会话 TODO 占用
    __clearStructuredTasks();
    const own1 = createStructuredTask({ subject: "占位1", description: "d" });
    const own2 = createStructuredTask({ subject: "占位2", description: "d" });
    expect([own1.id, own2.id]).toEqual(["1", "2"]);

    const idMap = restoreTeamTasks("alpha", snap);

    // 撞车的两个任务都被重映射到新 ID，主会话占位任务原样保留
    expect(idMap.get("1")).not.toBe("1");
    expect(idMap.get("2")).not.toBe("2");
    expect(getStructuredTask("1")!.subject).toBe("占位1");
    expect(getStructuredTask("2")!.subject).toBe("占位2");

    // 依赖边按映射表改写，依赖关系保持自洽
    const newA = getStructuredTask(idMap.get("1")!)!;
    const newB = getStructuredTask(idMap.get("2")!)!;
    expect(newB.blockedBy).toEqual([newA.id]);
    expect(newA.blocks).toEqual([newB.id]);
  });

  it("认领/未完成判定限定在团队分区内", () => {
    createStructuredTask({ subject: "主会话TODO", description: "不该被成员抢走" });
    const a = teamTask("alpha", "A1");

    const claimed = claimNextUnblockedTask("worker1", "alpha");
    expect(claimed?.id).toBe(a.id);

    // 团队任务做完 → 团队维度已无未完成任务（尽管主会话 TODO 还挂着）
    updateStructuredTask(a.id, { status: "completed" });
    expect(hasUnfinishedTasks("alpha")).toBe(false);
    expect(hasUnfinishedTasks()).toBe(true);
    // 团队分区内已无可认领任务，不会去抢主会话的
    expect(claimNextUnblockedTask("worker2", "alpha")).toBeUndefined();
  });
});
