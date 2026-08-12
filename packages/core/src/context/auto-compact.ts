/**
 * 上下文层压缩阈值与诊断工具
 *
 * 提供四层阈值体系、压缩级别判断、Token 减量追踪和压缩来源标记。
 * 实际的压缩执行由 query/loop.ts（runCompactPipeline）和 query/auto-compact.ts
 * （LLM 摘要）负责，本模块只提供它们共享的阈值常量与诊断辅助。
 *
 * 四层阈值体系（对标 claude-code autoCompact.ts:62-65）：
 * - autoCompact(13K)：剩余 ≤ 13K tokens → 触发自动压缩
 * - warning(20K)：剩余 ≤ 20K tokens → 警告
 * - error(20K)：剩余 ≤ 20K tokens → 错误
 * - blocking(3K)：剩余 ≤ 3K tokens → 阻塞（强制截断，不调用 LLM）
 */

import type { Message } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";

// ─── 阻塞底线阈值 ───

/**
 * 绝对安全底线阈值（剩余 token 数）。
 *
 * §12 P2-2 清理：此前这里有 autoCompact(13K)/warning(20K)/error(20K) 三档，号称「对标 CC
 * autoCompact.ts:62-65」。但主循环 loop.ts 只消费 `blocking` 一档——渐进压缩（soft/hard/emergency）
 * 全部由 manager.ts 的 getCompactionLevel（绝对 buffer + 相对系数）接管，那三档从不参与触发决策，
 * 是事实死代码。CC 的 autoCompact 是真触发阈值，我们这套只有 blocking 生效，保留原注释会误导维护者
 * 以为 13K 是触发点。故删除三个死档，只保留真正生效的 blocking 绝对底线。
 *
 * blocking 与 manager.ts 的 emergency（剩 40K / 窗口×10%）并存合理：emergency 走「摘要失败降级截断」
 * 或渐进管线，blocking 是「剩余极少、连一次 LLM 往返都危险」的最后一道强制截断（不调 LLM）。
 */
export const TOKEN_THRESHOLDS = {
  /** 剩余 ≤ 3K → 阻塞（强制截断，不调用 LLM）——唯一真正参与主循环触发决策的档 */
  blocking: 3_000,
} as const;

/**
 * §12 P1-1：读取 autoCompact 触发使用率的 env 覆盖。
 *
 * 语义：上下文使用率达到 N% 时触发 LLM 摘要压缩（等价 CC 的 hard 档提前）。
 * - `SID_CODE_AUTOCOMPACT_PCT` 优先于兼容别名 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（自有变量 > 迁移别名）。
 * - 接受 `0<小数<1`（0.5）或 `1<整数<100`（50），归一化为 0~1 小数返回。
 * - 范围校验：归一化后须落在 (0,1)。非法值（`0` / `abc` / `100` / `150`）忽略并 log.warn，返回 null。
 * - 未设 → 返回 null（用默认相对系数，不覆盖）。
 *
 * 对齐 CC `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（autoCompact.ts:79-84，按百分比覆盖触发阈值）。
 *
 * @returns 归一化后的使用率上限（0~1 小数），或 null（未设/非法）。
 */
export function resolveAutoCompactPctOverride(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.SID_CODE_AUTOCOMPACT_PCT ?? env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    getLogger().warn(
      "COMPACT",
      `AUTOCOMPACT_PCT 非法值「${raw}」，已忽略（需为 (0,1) 小数或 (0,100) 整数）`,
    );
    return null;
  }
  // 归一化：>1 视为百分数（50 → 0.5）
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  if (normalized <= 0 || normalized >= 1) {
    getLogger().warn(
      "COMPACT",
      `AUTOCOMPACT_PCT 超出范围「${raw}」（归一化 ${normalized}），已忽略（须 0<pct<1）`,
    );
    return null;
  }
  return normalized;
}

// ─── Token 减量追踪 ───

/**
 * Token 减量追踪器
 *
 * 记录每次压缩策略释放的 token 数，用于统计和诊断。
 */
export class TokenFreedTracker {
  private totalFreed = 0;
  private records: Array<{ strategy: string; tokensFreed: number; timestamp: number }> = [];

  /**
   * 记录一次压缩释放的 token 数
   *
   * @param tokensFreed 释放的 token 数
   * @param strategy 使用的压缩策略（如 "microCompact", "sessionMemory", "llmSummary"）
   */
  recordCompact(tokensFreed: number, strategy: string): void {
    if (tokensFreed <= 0) return;
    this.totalFreed += tokensFreed;
    this.records.push({
      strategy,
      tokensFreed,
      timestamp: Date.now(),
    });
  }

  /** 获取总计释放的 token 数 */
  getTotalFreed(): number {
    return this.totalFreed;
  }

  /** 获取压缩记录 */
  getRecords(): ReadonlyArray<{ strategy: string; tokensFreed: number; timestamp: number }> {
    return this.records;
  }

  /** 重置追踪器 */
  reset(): void {
    this.totalFreed = 0;
    this.records = [];
  }
}

// ─── 压缩来源标记 ───

/**
 * 检查消息是否为压缩来源（session_memory / compact），
 * 压缩来源的消息不应再次触发压缩。
 */
export function isCompactSourceMessage(msg: Message): boolean {
  if (!msg._meta) return false;

  const source = msg._meta.compact_source as string | undefined;
  return source === "session_memory" || source === "compact";
}
