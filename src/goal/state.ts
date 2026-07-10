/**
 * Goal 状态数据模型
 *
 * GoalState 是 /goal 命令的核心数据结构，记录目标的完成条件、进度、证据日志等。
 * Evidence Log 独立于对话历史，Compact 不影响证据完整性。
 */

import { randomUUID } from "node:crypto";

// ─── 类型定义 ───

/** 证据条目：记录一次关键操作的结果 */
export interface EvidenceEntry {
  /** 轮次编号 */
  turn: number;
  /** 时间戳 */
  timestamp: number;
  /** 证据类型 */
  type: "command_output" | "test_result" | "build_result" | "file_change" | "verification";
  /** 证据摘要（单行，最长 500 字符） */
  summary: string;
  /** 原始输出片段（最长 2000 字符，截断保留头尾） */
  raw?: string;
}

export type GoalStatus =
  | "active"          // 正在执行
  | "paused"          // 用户暂停（/goal pause）
  | "blocked"         // 模型报告卡住（连续 N 轮无进展）
  | "impossible"      // 评估者判定目标无法达成
  | "budget_limited"  // Token 预算耗尽
  | "turns_limited"   // 轮次上限耗尽
  | "complete";       // 评估者确认完成

export interface GoalState {
  /** 唯一标识（UUID），每次 /goal set 生成新值 */
  id: string;
  /** 用户输入的完成条件（原文保留，最长 4000 字符） */
  objective: string;
  /** 目标状态 */
  status: GoalStatus;
  /** Token 预算（可选，默认无上限） */
  tokenBudget?: number;
  /** 已消耗 Token（input + output + cache_creation 累计） */
  tokensUsed: number;
  /** 已执行轮次 */
  turnsUsed: number;
  /** 最大轮次（goal 级别，默认 150） */
  maxTurns: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  updatedAt: number;
  /** 评估者最后一次返回的 reason（用于持久化断点信息） */
  lastEvalReason?: string;
  /**
   * 证据日志（Evidence Log）——独立于对话历史的结构化证据链。
   * 每次模型产出关键可验证输出时追加。Compact 不影响此数据。
   * 评估者以此为主要判据，不再依赖从对话中"挖"证据。
   */
  evidenceLog: EvidenceEntry[];
}

// ─── 工厂函数 ───

export interface CreateGoalOptions {
  tokenBudget?: number;
  maxTurns?: number;
}

/** 创建一个新的 GoalState */
export function createGoal(objective: string, options?: CreateGoalOptions): GoalState {
  const now = Date.now();
  return {
    id: randomUUID(),
    objective,
    status: "active",
    tokenBudget: options?.tokenBudget || undefined,
    tokensUsed: 0,
    turnsUsed: 0,
    maxTurns: options?.maxTurns ?? 150,
    createdAt: now,
    updatedAt: now,
    evidenceLog: [],
  };
}

// ─── 序列化 / 反序列化 ───

/** 序列化 GoalState 为 JSON 可存储格式 */
export function serializeGoalState(goal: GoalState): string {
  return JSON.stringify(goal);
}

/** 从 JSON 字符串反序列化 GoalState */
export function deserializeGoalState(json: string): GoalState {
  const parsed = JSON.parse(json);
  // 类型防御：确保关键字段存在
  return {
    id: parsed.id ?? randomUUID(),
    objective: parsed.objective ?? "",
    status: parsed.status ?? "active",
    tokenBudget: parsed.tokenBudget,
    tokensUsed: parsed.tokensUsed ?? 0,
    turnsUsed: parsed.turnsUsed ?? 0,
    maxTurns: parsed.maxTurns ?? 150,
    createdAt: parsed.createdAt ?? Date.now(),
    updatedAt: parsed.updatedAt ?? Date.now(),
    lastEvalReason: parsed.lastEvalReason,
    evidenceLog: Array.isArray(parsed.evidenceLog) ? parsed.evidenceLog : [],
  };
}
