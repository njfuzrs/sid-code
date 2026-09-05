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
  /**
   * 产生该证据的工具调用是否失败（取自 tool_result.is_error）。
   *
   * F2（2026-09-03）：fast-path 判「测试是否通过」不能只看输出文本里有没有 `0 fail`
   * ——测试是否通过本质由退出码定义。缺省（旧会话恢复、非 bash 证据）视为未知，
   * 按 fail-open 处理，不因缺字段就把历史证据判成失败。
   */
  isError?: boolean;
}

export type GoalStatus =
  | "active" // 正在执行
  | "paused" // 用户暂停（/goal pause）
  | "blocked" // 模型报告卡住（连续 N 轮无进展）
  | "impossible" // 评估者判定目标无法达成
  | "budget_limited" // Token 预算耗尽
  | "turns_limited" // 轮次上限耗尽
  | "complete"; // 评估者确认完成

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

/** 序列化 GoalState 为 JSON 可存储格式（全量，内存/调试用） */
export function serializeGoalState(goal: GoalState): string {
  return JSON.stringify(goal);
}

/** 落盘时保留的证据条数（评估器只读最近 20 条，留 30 条有余量） */
const PERSIST_KEEP_RECENT_EVIDENCE = 30;

/** 落盘时保留 `raw` 的最近条数（更早的只留 summary） */
const PERSIST_KEEP_RAW_RECENT = 5;

/**
 * 序列化 GoalState **用于落盘**：内存保留全量，落盘只写最近 N 条 + 总数。
 *
 * ## 为什么需要跟 serializeGoalState 分开（F6，2026-09-03 排查）
 *
 * `appendMetadata` 是 **append 语义**——每次 persist 都把当时的完整 GoalState 再写一条。
 * 而 `evidenceLog` 无上限，于是第 N 轮那一次写入就带着 N 条证据的完整体积：
 * 150 轮实测**单次序列化 328KB、累计约 24MB**，而**评估器真正读的只有最近 20 条**。
 * 副作用是 session JSONL 膨胀 → 会话恢复要解析这坨东西。
 *
 * 改法刻意**不裁内存**：设计稿写的是「评估者输入取最近 20 条 / GoalState 保留全量
 * （用于持久化和 resume）」——全量保留是有意的，不是漏了裁剪。所以这里只治写放大：
 * - `evidenceLog` 落盘裁到最近 30 条（评估器窗口 20，留余量）
 * - `evidenceTotalCount` 记真实总数，`/goal status` 的「证据 N 条」不至于变成被裁后的数
 * - 较早证据剥掉 `raw`（2000 字符上限，量大且评估器对旧证据只看 summary），
 *   最近 5 条保留——`summary` 一条都不剥，它才是主判据
 *
 * resume 侧安全性已确认：`buildResumeTurnPrompt` 只读 `turnsUsed` 与 `lastEvalReason`，
 * 不读 `evidenceLog`。
 */
export function serializeGoalStateForPersist(
  goal: GoalState,
  keepRecent = PERSIST_KEEP_RECENT_EVIDENCE,
): string {
  const total = goal.evidenceLog.length;
  const kept = goal.evidenceLog.slice(-keepRecent);
  const rawCutoff = kept.length - PERSIST_KEEP_RAW_RECENT;
  const evidenceLog = kept.map((e, i) => {
    if (i >= rawCutoff) return e;
    // 剥 raw：保留其余字段（含 isError，fast-path 的退出码前提依赖它）
    const { raw: _raw, ...withoutRaw } = e;
    return withoutRaw;
  });
  return JSON.stringify({ ...goal, evidenceLog, evidenceTotalCount: total });
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
