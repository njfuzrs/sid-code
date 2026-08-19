/**
 * 并发冲突检测埋点
 *
 * 记录冲突事件到轨迹系统，用于统计：
 * - 冲突触发次数
 * - 用户选择分布（stop/skip/continue）
 * - 误报率代理（action=continue 占比）
 * - 触发率（冲突次数 / 总 edit/write 次数）
 */

import { createHash } from "crypto";
import { getLogger } from "../debug/logger.ts";

/** 冲突事件类型 */
export type ConflictAction = "stop" | "skip" | "continue" | "blocked" | "headless_fallback";

/** 冲突事件数据 */
export interface ConflictEvent {
  /** 文件路径哈希（脱敏，只保留前 8 位） */
  filePathHash: string;
  /** 冲突的其他会话数量 */
  otherSessionCount: number;
  /** 严重程度 */
  severity: "warning" | "critical";
  /** 用户选择（或自动决策） */
  action: ConflictAction;
  /** 触发工具 */
  tool: "edit" | "write";
  /** 时间戳 */
  timestamp: number;
}

/**
 * 对文件路径做哈希脱敏
 * 只保留前 8 位，避免泄露完整路径
 */
export function hashFilePath(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 8);
}

/**
 * 记录冲突事件
 *
 * 当前实现：写入 debug 日志（后续可接入 trace 系统）
 * TODO: 接入 src/trace/collector.ts 的 appendEvent，写入 raw.jsonl
 */
export function emitConflictEvent(event: Omit<ConflictEvent, "timestamp">): void {
  const log = getLogger();
  const fullEvent: ConflictEvent = {
    ...event,
    timestamp: Date.now(),
  };

  // 写入 debug 日志（JSON 格式，便于后续解析）
  log.debug("CONFLICT", JSON.stringify(fullEvent));

  // TODO: 接入 trace 系统
  // import { getTraceCollector } from "../trace/collector.ts";
  // getTraceCollector()?.appendEvent({
  //   event: "ConflictDetected",
  //   data: fullEvent,
  // });
}

/**
 * 在冲突检测点调用此函数记录事件
 *
 * @param filePath 文件路径（会自动脱敏）
 * @param otherSessionCount 冲突的其他会话数量
 * @param severity 严重程度
 * @param action 用户选择（或自动决策）
 * @param tool 触发工具
 */
export function recordConflict(
  filePath: string,
  otherSessionCount: number,
  severity: "warning" | "critical",
  action: ConflictAction,
  tool: "edit" | "write",
): void {
  emitConflictEvent({
    filePathHash: hashFilePath(filePath),
    otherSessionCount,
    severity,
    action,
    tool,
  });
}
