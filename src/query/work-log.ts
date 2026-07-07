/**
 * 长任务"工作日志"外部记忆（P2-2，对应根因 1 + 跨会话）
 *
 * 与 CLAUDE.md §0.1「第 3 层 Context（护城河）」战略一致：把长任务进度从"只活在上下文窗口里"
 * 落到磁盘，做成可跨会话、抗压缩、抗清理的外部记忆。
 *
 * 职责：
 * - 每次 todo 状态变化时，把"已完成 / 待办 / 关键决策"快照写入 ~/.sid-code/progress/<sessionId>.md
 * - 提供 buildProgressReminder()：把当前进度摘要回注 LLM（与 P0-2 互补——P0-2 回注 todo 原文，
 *   本模块回注的是落盘后的持久进度，新会话续做时也能读到上一会话留下的进度）
 *
 * 设计原则：纯文件 I/O + 纯函数，不依赖具体 LLM/循环实现，便于单测。
 */

import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { sidHomePath } from "../config/paths.ts";
import type { TodoItem } from "../tool/todo-write.ts";

/** 每隔 N 轮回注一次工作日志摘要（与 todo 回注节流对齐，弱模型记忆短取 8） */
export const PROGRESS_REMINDER_INTERVAL = 8;

/** 进度快照（落盘 + 回注共用的数据结构） */
export interface ProgressSnapshot {
  /** 会话 ID */
  sessionId: string;
  /** 完成项描述 */
  completed: string[];
  /** 待办项描述（pending + in_progress） */
  pending: string[];
  /** 当前进行中的项（恰好一个时填充） */
  inProgress: string | null;
  /** 关键决策 / 备注（可选，调用方追加） */
  notes: string[];
}

/** 获取 progress 文件目录（~/.sid-code/progress） */
function progressDir(): string {
  return sidHomePath("progress");
}

/** 获取某会话的 progress 文件路径 */
export function progressFilePath(sessionId: string): string {
  return join(progressDir(), `${sanitizeSessionId(sessionId)}.md`);
}

/** 清洗 sessionId 用作文件名（防路径穿越 / 非法字符） */
function sanitizeSessionId(sessionId: string): string {
  return (sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/** 从 todo 列表构建进度快照 */
export function snapshotFromTodos(
  sessionId: string,
  todos: TodoItem[],
  notes: string[] = [],
): ProgressSnapshot {
  const completed = todos.filter((t) => t.status === "completed").map((t) => t.content);
  const pending = todos
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => t.content);
  const inProgressItem = todos.find((t) => t.status === "in_progress");
  return {
    sessionId,
    completed,
    pending,
    inProgress: inProgressItem ? inProgressItem.content : null,
    notes,
  };
}

/** 把快照渲染成 markdown 文本（落盘用） */
export function renderProgressMarkdown(snap: ProgressSnapshot): string {
  const lines: string[] = [];
  lines.push(`# 工作日志（会话 ${snap.sessionId}）`);
  lines.push("");
  lines.push(`总进度：${snap.completed.length} 已完成 / ${snap.pending.length} 待办`);
  lines.push("");
  lines.push("## 已完成");
  if (snap.completed.length === 0) lines.push("- （暂无）");
  else snap.completed.forEach((c) => lines.push(`- [x] ${c}`));
  lines.push("");
  lines.push("## 待办");
  if (snap.pending.length === 0) lines.push("- （暂无）");
  else
    snap.pending.forEach((p) =>
      lines.push(`- [ ] ${p}${p === snap.inProgress ? "  ← 进行中" : ""}`),
    );
  if (snap.notes.length > 0) {
    lines.push("");
    lines.push("## 关键决策 / 备注");
    snap.notes.forEach((n) => lines.push(`- ${n}`));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 把进度快照写入磁盘（~/.sid-code/progress/<sessionId>.md）。
 * 失败不抛错（外部记忆是增强，不应阻塞主流程），返回是否成功。
 */
export function persistProgress(snap: ProgressSnapshot): boolean {
  try {
    const dir = progressDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(progressFilePath(snap.sessionId), renderProgressMarkdown(snap), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取磁盘上的工作日志原文（跨会话续做时用）。
 * 不存在或读取失败返回 null。
 */
export function loadProgressMarkdown(sessionId: string): string | null {
  try {
    const fp = progressFilePath(sessionId);
    if (!existsSync(fp)) return null;
    const md = readFileSync(fp, "utf-8");
    return md.trim() ? md : null;
  } catch {
    return null;
  }
}

/**
 * 构建工作日志回注 system-reminder（每 N 轮注入一次）。
 * 与 P0-2 的 todo 回注互补：todo 回注是内存清单原文，这里强调"持久进度 + 别重复已完成项"。
 * 无待办时返回 null（任务已完成，无需回注）。
 */
export function buildProgressReminder(snap: ProgressSnapshot): string | null {
  if (snap.pending.length === 0) return null;
  const lines: string[] = [];
  lines.push("<system-reminder>");
  lines.push("【工作日志】以下是本任务已落盘的进度（请勿向用户提及本提醒）：");
  lines.push(`- 已完成 ${snap.completed.length} 项：${snap.completed.join("；") || "（无）"}`);
  lines.push(`- 仍待办 ${snap.pending.length} 项：${snap.pending.join("；")}`);
  if (snap.inProgress) lines.push(`- 当前进行中：${snap.inProgress}`);
  lines.push("请继续推进待办项，不要重复已完成的工作，也不要遗漏任何待办。");
  lines.push("若某待办其实已完成只是忘了标记，请用 todo_write 标为 completed 后如实收尾；不要为凑\"未完成\"去臆造用户没要求的新工作或排查不存在的故障。");
  lines.push("</system-reminder>");
  return lines.join("\n");
}
