/**
 * P1-3：单会话任务清单落盘。
 *
 * 覆盖：落盘/读回往返、恢复不动团队分区、ID 撞车重映射、
 * 损坏文件降级、工具层变更后自动落盘。
 * 落盘目录走 SID_CONFIG_DIR 重定向到 tmpdir，不碰真实 ~/.sid-code。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStructuredTask,
  updateStructuredTask,
  getAllStructuredTasks,
  __clearStructuredTasks,
} from "@sid-code/core/task/structured-task-store.ts";
import {
  persistSessionTasks,
  loadSessionTasks,
  sessionTasksPath,
  setCurrentSessionId,
  persistCurrentSessionTasks,
} from "@sid-code/core/task/session-task-store.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  __clearStructuredTasks();
  dir = mkdtempSync(join(tmpdir(), "sid-session-tasks-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(dir, ".sid-code");
  setCurrentSessionId("");
});

afterEach(() => {
  __clearStructuredTasks();
  setCurrentSessionId("");
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("会话任务清单落盘", () => {
  it("落盘后清空内存再读回，任务与依赖完整恢复", () => {
    const a = createStructuredTask({ subject: "A", description: "任务A" });
    const b = createStructuredTask({ subject: "B", description: "任务B" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });

    persistSessionTasks("sess-1");
    __clearStructuredTasks();
    expect(getAllStructuredTasks()).toHaveLength(0);

    expect(loadSessionTasks("sess-1")).toBe(true);
    const restored = getAllStructuredTasks();
    expect(restored.map((t) => t.subject).sort()).toEqual(["A", "B"]);
    const rb = restored.find((t) => t.subject === "B")!;
    const ra = restored.find((t) => t.subject === "A")!;
    expect(rb.blockedBy).toEqual([ra.id]);
  });

  it("恢复只替换主会话任务，团队分区原样保留", () => {
    createStructuredTask({ subject: "会话任务", description: "d" });
    createStructuredTask({ subject: "团队任务", description: "d", metadata: { team: "alpha" } });
    persistSessionTasks("sess-1");

    __clearStructuredTasks();
    createStructuredTask({ subject: "另一团队", description: "d", metadata: { team: "beta" } });

    loadSessionTasks("sess-1");
    const all = getAllStructuredTasks();
    expect(all.map((t) => t.subject).sort()).toEqual(["会话任务", "另一团队"]);
    expect(all.find((t) => t.subject === "另一团队")?.metadata.team).toBe("beta");
  });

  it("快照 ID 与团队任务撞车时重映射且依赖边跟着改", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });
    persistSessionTasks("sess-1");

    __clearStructuredTasks();
    // 占住快照里的 ID "1"，迫使恢复时重映射
    createStructuredTask({ subject: "占位", description: "d", metadata: { team: "alpha" } });

    loadSessionTasks("sess-1");
    const all = getAllStructuredTasks();
    expect(all.find((t) => t.subject === "占位")?.id).toBe("1");
    const ra = all.find((t) => t.subject === "A")!;
    const rb = all.find((t) => t.subject === "B")!;
    expect(ra.id).not.toBe("1");
    expect(rb.blockedBy).toEqual([ra.id]);
  });

  it("文件不存在返回 false，损坏文件降级为 false 且不抛", () => {
    expect(loadSessionTasks("不存在")).toBe(false);
    const path = sessionTasksPath("坏的");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{这不是 json");
    expect(loadSessionTasks("坏的")).toBe(false);
    expect(getAllStructuredTasks()).toHaveLength(0);
  });

  it("task_create 变更后自动落盘到当前会话", async () => {
    setCurrentSessionId("sess-auto");
    const res = await new TaskCreateTool().execute({ subject: "自动落盘", description: "d" });
    expect(res.isError).toBeFalsy();

    __clearStructuredTasks();
    expect(loadSessionTasks("sess-auto")).toBe(true);
    expect(getAllStructuredTasks().map((t) => t.subject)).toEqual(["自动落盘"]);
  });

  it("未注入会话 ID 时 persistCurrentSessionTasks 不落盘", () => {
    createStructuredTask({ subject: "不该落盘", description: "d" });
    persistCurrentSessionTasks();
    __clearStructuredTasks();
    expect(loadSessionTasks("")).toBe(false);
  });
});
