/**
 * 团队任务列表持久化（P2-2，对齐 CC ~/.claude/tasks/{team}/）
 *
 * 把 structured-task-store 的内存态任务落盘到 `.sid-code/tasks/{team-name}/tasks.json`，
 * 供 swarm team 作为「共享任务列表」调度底座：进程重启可恢复、成员按依赖认领任务。
 *
 * 原子写（temp + rename）防并发/崩溃时半写损坏。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import {
  serializeStructuredTasks,
  restoreStructuredTasks,
  type StructuredTask,
} from "./structured-task-store.ts";

/** 团队名安全化（与 swarm/team.ts safeName 一致口径），防路径穿越。 */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 团队任务文件路径：{baseDir}/.sid-code/tasks/{team}/tasks.json */
export function teamTasksPath(teamName: string, baseDir?: string): string {
  const base = baseDir ?? process.cwd();
  return join(base, ".sid-code", "tasks", safeName(teamName), "tasks.json");
}

/**
 * 把当前内存态任务快照原子落盘到团队任务文件。
 * 写失败 warn 但不抛（持久化是增益，不应阻断 team 执行）。
 */
export function persistTeamTasks(teamName: string, baseDir?: string): void {
  const path = teamTasksPath(teamName, baseDir);
  const snapshot = serializeStructuredTasks();
  try {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    // 原子写：先写临时文件再 rename（rename 在同一文件系统内原子），避免读到半写内容。
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, teamName, tasks: snapshot }, null, 2));
    renameSync(tmp, path);
  } catch (err: any) {
    getLogger().warn("TEAM_TASKS", `团队任务落盘失败 (${teamName}): ${err?.message ?? err}`);
  }
}

/**
 * 从团队任务文件恢复任务到内存态。
 * 文件不存在返回 false（无历史，全新团队）；损坏则 warn 后返回 false（降级为全新）。
 * 成功恢复返回 true。
 */
export function loadTeamTasks(teamName: string, baseDir?: string): boolean {
  const path = teamTasksPath(teamName, baseDir);
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { tasks?: StructuredTask[] };
    if (!parsed || !Array.isArray(parsed.tasks)) {
      getLogger().warn("TEAM_TASKS", `团队任务文件结构非法 (${teamName})，忽略`);
      return false;
    }
    restoreStructuredTasks(parsed.tasks);
    return true;
  } catch (err: any) {
    getLogger().warn("TEAM_TASKS", `团队任务文件读取失败 (${teamName})，降级为全新: ${err?.message ?? err}`);
    return false;
  }
}
