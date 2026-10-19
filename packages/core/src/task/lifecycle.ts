/**
 * 后台任务输出生命周期（S3 / S16）：回合纪元 + `TaskLifecycle` 轨迹事件 + 驱逐墓碑。
 *
 * ## 为什么要有「回合纪元」
 *
 * S3 事故：`.output` 在模型读到之前被删。旧实现在**入队通知**时就置 `notified=true` 并开
 * 30s 计时，而通知要等到下一个回合边界才进上下文，那之后模型还要跑一次可能长达 116s
 * 的调用——任何「N 毫秒后删」都会被越过（把计时起点挪到送达时刻也一样，见方案 §4 否决项）。
 * 所以驱逐判据改成**按回合**：送达之后，主循环又完整跑完至少一个回合，才允许删。
 *
 * 纪元只计「主循环完整跑完的回合数」，由 `queryLoop` 在第 2+ 轮开头与 finally 收尾各推进
 * 一次（见 `markMainTurnCompleted` 的调用点），且两处都要求**自上次推进以来模型真的返回过
 * 一次响应**（M5）——PTL 压缩重试 / 超时重试只是 while 迭代，模型没看过通知。子代理有自己的循环、不消费通知队列，不推进它。
 *
 * ## 为什么事件走模块级 sink
 *
 * 终态写入点散在 shell / agent / workflow 三个文件共 9 处，都拿不到 TraceCollector。
 * 与 `jit-telemetry.ts` 同款：App 在 collector 就绪后注入一次，模块内统一 emit。
 */

import { closeSync, fstatSync, openSync, readSync, realpathSync } from "fs";
import { basename, dirname, resolve } from "path";
import { sidPaths } from "../config/paths.ts";
import type { TaskState, TaskStatus } from "./types.ts";

// ─────────────────────────── 回合纪元 ───────────────────────────

let completedMainTurns = 0;
const turnListeners = new Set<() => void>();

/** 主循环已完整跑完的回合数（单调递增，进程级） */
export function getCompletedMainTurns(): number {
  return completedMainTurns;
}

/**
 * 主循环刚跑完一个回合。调用点只有 `queryLoop`：第 2+ 轮开头（上一轮已结束，且**先于**
 * 本轮的通知注入）与 finally 收尾（本次 queryLoop 的最后一轮已结束）。
 *
 * 顺序约束：轮开头必须先推进、再注入通知。反过来的话，本轮刚送达的通知会被记成
 * 「上一轮送达」，本轮的模型调用还没开始就满足了驱逐条件——正是 S3 要消灭的时序。
 */
export function markMainTurnCompleted(): void {
  completedMainTurns++;
  for (const cb of turnListeners) {
    try {
      cb();
    } catch {
      /* 监听器异常不影响主循环 */
    }
  }
}

/** registry 订阅纪元推进：有任务因此变为可驱逐时要刷新 TUI，让 1s 驱逐定时器重新判定开关 */
export function onMainTurnCompleted(cb: () => void): void {
  turnListeners.add(cb);
}

// ─────────────────────────── TaskLifecycle 事件 ───────────────────────────

export const TASK_LIFECYCLE_EVENT_NAME = "TaskLifecycle";

export type TaskLifecyclePhase = "started" | "completed" | "delivered" | "evicted";

/** 驱逐原因：判据走的是哪条分支（验收要分得清「正常送达后删」与「安全阀兜底删」） */
export type TaskEvictReason = "delivered_turn_passed" | "safety_valve" | "cleared";

export type TaskLifecycleSink = (data: Record<string, unknown>) => void;

let sink: TaskLifecycleSink | null = null;

/** 注入/清除事件通道（App 在 collector 就绪后调用；测试收尾传 null 复位） */
export function setTaskLifecycleSink(s: TaskLifecycleSink | null): void {
  sink = s;
}

/**
 * 落一条 `TaskLifecycle`。字段口径服务于方案 §6 的 PR-3 验收：
 * - `turn`：事件发生时的回合纪元。「`evicted` 与 `delivered` 同 turn」计数应恒为 0；
 * - `ts`：发生时刻（毫秒）。`delivered.ts − completed.ts` 的 p95 是送达延迟曲线。
 */
export function emitTaskLifecycle(
  task: Pick<TaskState, "id" | "type" | "status"> & { isBackgrounded?: boolean },
  phase: TaskLifecyclePhase,
  extra: {
    reason?: TaskEvictReason;
    exit_code?: number;
    /** delivered 阶段：结果经哪条通道送达（F6，trace-digest 据此判双投递） */
    via?: "notification" | "tool_result";
  } = {},
): void {
  if (!sink) return;
  try {
    sink({
      task_id: task.id,
      task_type: task.type,
      phase,
      status: task.status,
      background: task.isBackgrounded !== false,
      ts: Date.now(),
      turn: completedMainTurns,
      ...extra,
    });
  } catch {
    /* 埋点失败不影响任务系统 */
  }
}

// ─────────────────────────── 驱逐墓碑 ───────────────────────────

/** 墓碑里留存的尾部字节数（够看出最后几行输出 / 报错，又不会把大输出整段塞进上下文） */
const TOMBSTONE_TAIL_BYTES = 2048;
/** 墓碑表上限：只服务「刚删不久又被读」这个窗口，按插入顺序淘汰最老的 */
const TOMBSTONE_MAX = 200;

export interface TaskOutputTombstone {
  taskId: string;
  status: TaskStatus;
  exitCode?: number;
  endTime?: number;
  evictedAt: number;
  reason: TaskEvictReason;
  /** 驱逐前 `.output` 的尾部内容（读不到为空串） */
  tail: string;
  /** 尾部是否被截断（文件比留存窗口大） */
  truncated: boolean;
}

const tombstones = new Map<string, TaskOutputTombstone>();

/** 同步读文件尾部。驱逐路径是同步的，删除紧随其后，必须在这里当场读完 */
function readTailSync(filePath: string): { tail: string; truncated: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TOMBSTONE_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { tail: buf.toString("utf-8"), truncated: start > 0 };
  } catch {
    return { tail: "", truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 驱逐前登记墓碑（registry 驱逐路径调用，须在删磁盘文件之前） */
export function recordTaskOutputTombstone(task: TaskState, reason: TaskEvictReason): void {
  const { tail, truncated } = readTailSync(task.outputFile);
  if (tombstones.has(task.id)) tombstones.delete(task.id);
  tombstones.set(task.id, {
    taskId: task.id,
    status: task.status,
    exitCode: "exitCode" in task ? (task.exitCode as number | undefined) : undefined,
    endTime: task.endTime,
    evictedAt: Date.now(),
    reason,
    tail,
    truncated,
  });
  while (tombstones.size > TOMBSTONE_MAX) {
    const oldest = tombstones.keys().next().value;
    if (oldest === undefined) break;
    tombstones.delete(oldest);
  }
}

export function getTaskOutputTombstone(taskId: string): TaskOutputTombstone | undefined {
  return tombstones.get(taskId);
}

/** 测试复位用 */
export function clearTaskOutputTombstones(): void {
  tombstones.clear();
}

/** 大小写不敏感的文件系统（macOS 默认 APFS、Windows NTFS）上，路径比较要先折叠大小写 */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * 目录的规范形式（L1）：只 `resolve` 不够。macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，
 * `SID_CONFIG_DIR=/tmp/...` 时模型常传 `/private/tmp/...`，两者 resolve 后不等，墓碑就
 * 落回通用「文件不存在」。目录本身一般存在（`.output` 已删，目录还在），realpath 失败才退回 resolve。
 */
function canonicalDir(dir: string): string {
  let p: string;
  try {
    p = realpathSync(dir);
  } catch {
    p = resolve(dir);
  }
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/**
 * 若 `filePath` 是后台任务的 `.output`（位于 `sidPaths.tasks()` 下、形如 `<id>.output`），
 * 返回任务 id；否则 null。read 工具在 ENOENT 时用它判断要不要给墓碑而不是通用「文件不存在」。
 */
export function taskIdFromOutputPath(filePath: string): string | null {
  try {
    const abs = resolve(filePath);
    if (canonicalDir(dirname(abs)) !== canonicalDir(sidPaths.tasks())) return null;
    const m = /^(.+)\.output$/.exec(basename(abs));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * 读一个已不存在的任务 `.output` 时的说明文本。
 *
 * 诚实边界：只有走 read 工具的读取能拿到它；bash `tail` / `cat` 覆盖不到。
 * 真正让文件在模型读之前不被删的是按回合驱逐，这里只是删了之后别让模型误以为「任务没产出」。
 */
export function formatTaskOutputTombstone(taskId: string, filePath: string): string {
  const t = tombstones.get(taskId);
  if (!t) {
    return (
      `后台任务输出文件已不存在: ${filePath}\n` +
      `这是任务 ${taskId} 的输出文件。它可能已在完成通知送达并被处理后按生命周期清理，` +
      `或属于已结束的会话。如任务仍在本会话中，请用 task_output 工具（task_id="${taskId}"）查询。`
    );
  }
  const head =
    `后台任务 ${taskId} 的输出文件已被清理（任务终态: ${t.status}` +
    (t.exitCode !== undefined ? `，exit code: ${t.exitCode}` : "") +
    (t.endTime ? `，完成于 ${new Date(t.endTime).toISOString()}` : "") +
    `，清理于 ${new Date(t.evictedAt).toISOString()}）。` +
    (t.reason === "safety_valve"
      ? "完成通知长时间未能送达，按安全阀清理。"
      : t.reason === "cleared"
        ? "会话上下文被清空（/clear）或会话结束时一并清理。"
        : "完成通知送达后已过至少一个回合，按生命周期清理。");
  if (!t.tail) return `${head}\n清理前未留存到输出内容（输出为空或读取失败）。`;
  return `${head}\n清理前留存的输出${t.truncated ? `末尾 ${TOMBSTONE_TAIL_BYTES} 字节` : ""}:\n${t.tail}`;
}
