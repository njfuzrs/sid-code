/**
 * 单会话任务清单持久化（P1-3 的会话级一半）
 *
 * structured-task-store 的内存 Map 有两个租户：带 metadata.team 的团队任务
 * （由 team-task-store 按团队落盘）和没有团队标记的主会话 TODO。此前只有前者落盘，
 * 主会话的清单进程退出即丢，长任务中途崩溃后 resume 看不到已规划的依赖图。
 *
 * 本模块补会话级落盘：~/.sid-code/tasks/sessions/<sessionId>.json。
 * 与团队落盘的分工是按 metadata.team 分区——序列化只取无团队标记的任务，
 * 恢复只替换这部分，两边互不覆盖。
 *
 * 原子写（temp + rename）防崩溃时半写损坏，与 team-task-store 同款。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { sidHomePath } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import {
  serializeStructuredTasks,
  restoreSessionTasks,
  type StructuredTask,
} from "./structured-task-store.ts";

/**
 * 当前进程的会话 ID（由 cli.ts 启动时 setCurrentSessionId 注入）。
 *
 * task_create/task_update 在工具层拿不到 sessionId（LegacyTool.execute 只有 input），
 * 而给每个工具加注入点要改 app.ts 的接线。模块级指针只写一次、只读多次，
 * 未注入时落盘函数直接 no-op——测试与无会话场景不受影响。
 */
let currentSessionId = "";

/** 注入当前会话 ID。重复调用以最后一次为准（resume 切换会话时需要）。 */
export function setCurrentSessionId(sessionId: string): void {
  currentSessionId = sessionId;
}

/** 读取当前会话 ID（未注入时为空串）。 */
export function getCurrentSessionId(): string {
  return currentSessionId;
}

/**
 * 把主会话清单落盘到当前会话的文件。未注入会话 ID 时 no-op。
 * 工具层（task_create/task_update）在每次变更后调用，不需要知道 sessionId。
 */
export function persistCurrentSessionTasks(): void {
  if (currentSessionId) persistSessionTasks(currentSessionId);
}

/** sessionId 安全化，防路径穿越。 */
function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 会话任务文件路径：~/.sid-code/tasks/sessions/<sessionId>.json */
export function sessionTasksPath(sessionId: string): string {
  return sidHomePath("tasks", "sessions", `${safeId(sessionId)}.json`);
}

/** 任务是否属于主会话（没有团队分区标记）。 */
function isSessionTask(task: StructuredTask): boolean {
  const team = (task.metadata as { team?: unknown })?.team;
  return typeof team !== "string" || team.length === 0;
}

/**
 * 把主会话的任务快照原子落盘。
 * 写失败 warn 但不抛——持久化是增益，不应阻断 task_create/task_update。
 */
export function persistSessionTasks(sessionId: string): void {
  if (!sessionId) return;
  const path = sessionTasksPath(sessionId);
  const snapshot = serializeStructuredTasks().filter(isSessionTask);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessionId, tasks: snapshot }, null, 2));
    renameSync(tmp, path);
  } catch (err: any) {
    getLogger().warn("SESSION_TASKS", `会话任务落盘失败 (${sessionId}): ${err?.message ?? err}`);
  }
}

/**
 * 从落盘文件恢复主会话任务到内存态（团队分区不受影响）。
 * 文件不存在返回 false；损坏则 warn 后返回 false（降级为空清单，不抛）。
 */
export function loadSessionTasks(sessionId: string): boolean {
  if (!sessionId) return false;
  const path = sessionTasksPath(sessionId);
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { tasks?: StructuredTask[] };
    if (!parsed || !Array.isArray(parsed.tasks)) {
      getLogger().warn("SESSION_TASKS", `会话任务文件结构非法 (${sessionId})，忽略`);
      return false;
    }
    restoreSessionTasks(parsed.tasks.filter(isSessionTask));
    return true;
  } catch (err: any) {
    getLogger().warn(
      "SESSION_TASKS",
      `会话任务文件读取失败 (${sessionId})，降级为空清单: ${err?.message ?? err}`,
    );
    return false;
  }
}
