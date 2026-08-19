/**
 * 并发冲突检测引擎（Phase 1）
 *
 * 在 Edit/Write 执行前检查目标文件是否被其他会话声明。
 * 如果发现冲突，返回冲突报告供 UI 展示。
 */

import { queryFileIntents } from "./file-intent.ts";

export type ConflictAction = "stop" | "skip" | "continue";

/** 冲突严重程度 */
export type ConflictSeverity = "warning" | "critical";

/** 冲突报告 */
export interface ConflictReport {
  /** 冲突文件路径 */
  filePath: string;
  /** 冲突的其他会话列表 */
  conflictingSessions: Array<{
    sessionId: string;
    pid: number;
    cwd: string;
    lastOperation: string;
    lastAccessAt: number;
    /** 距离最近一次操作的时间（秒） */
    secondsAgo: number;
  }>;
  /** 严重程度 */
  severity: ConflictSeverity;
  /** 人类可读的摘要 */
  summary: string;
}

/**
 * 检查目标文件是否存在并发冲突。
 *
 * @param targetFile 目标文件绝对路径
 * @param currentSessionId 当前会话 ID（排除自己）
 * @param opts.blockingOperations 哪些操作类型应触发冲突（默认 ["edit", "write"]，read 不触发）
 * @returns 冲突报告，如果没有冲突则返回 null
 */
export function checkConflict(
  targetFile: string,
  currentSessionId: string,
  opts: { blockingOperations?: Array<"read" | "edit" | "write"> } = {},
): ConflictReport | null {
  const blocking = opts.blockingOperations ?? ["edit", "write"];
  const allConflicts = queryFileIntents(targetFile, currentSessionId);

  // 只保留 blockingOperations 中的冲突（默认排除纯 read）
  const conflicts = allConflicts.filter((c) => blocking.includes(c.intent.operation));

  if (conflicts.length === 0) {
    return null;
  }

  const now = Date.now();
  const conflictingSessions = conflicts.map((c) => ({
    sessionId: c.sessionId,
    pid: c.pid,
    cwd: c.cwd,
    lastOperation: c.intent.operation,
    lastAccessAt: c.intent.lastAccessAt,
    secondsAgo: Math.floor((now - c.intent.lastAccessAt) / 1000),
  }));

  // 判断严重程度：如果其他会话正在 write/edit，则为 critical；如果只是 read，则为 warning
  const hasWriteOrEdit = conflicts.some(
    (c) => c.intent.operation === "write" || c.intent.operation === "edit",
  );
  const severity: ConflictSeverity = hasWriteOrEdit ? "critical" : "warning";

  // 生成摘要
  const sessionCount = conflictingSessions.length;
  const summary =
    severity === "critical"
      ? `检测到 ${sessionCount} 个其他会话正在编辑/写入此文件`
      : `检测到 ${sessionCount} 个其他会话最近读取过此文件`;

  return {
    filePath: targetFile,
    conflictingSessions,
    severity,
    summary,
  };
}

/**
 * 格式化冲突报告为终端输出。
 * 用于 Phase 1 的简单警告（不弹选择框）。
 */
export function formatConflictWarning(report: ConflictReport): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("⚠️  并发冲突警告");
  lines.push(`文件: ${report.filePath}`);
  lines.push(report.summary);
  lines.push("");

  for (const session of report.conflictingSessions) {
    const timeAgo =
      session.secondsAgo < 60
        ? `${session.secondsAgo} 秒前`
        : `${Math.floor(session.secondsAgo / 60)} 分钟前`;
    lines.push(
      `  - 会话 ${session.sessionId.slice(-8)} (PID ${session.pid}) — ${session.lastOperation} (${timeAgo})`,
    );
  }

  lines.push("");
  lines.push("继续编辑可能导致互相覆盖。建议：");
  lines.push("  1. 关闭其他并发会话");
  lines.push("  2. 避开正在被编辑的文件");
  lines.push("");

  return lines.join("\n");
}
