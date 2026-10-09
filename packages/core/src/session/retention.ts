/**
 * 会话保留策略的单一事实源。
 *
 * 会话（sessions/）、轨迹（trajectories/sessions/）、Session Memory 笔记三处的「留多久」
 * 此前各写各的 30 天，且会话侧还叠了一道 `maxCount: 50`。两个默认值都是错的：
 *
 * - **`maxCount: 50` 是把示例值当成了默认值**。它与 Gemini CLI 文档示例
 *   （`"maxAge": "30d", "maxCount": 50`）一字不差，而 Gemini 自己的配置参考写明
 *   `maxCount` 默认 `undefined`（不限）。一天几十个会话的用户，50 个配额只够一两天，
 *   而删会话会连带删轨迹 —— 北极星曲线的数据源跟着被截成最近两天。
 * - **30 天对「后面还要 --resume」的用户太短**。Claude Code 的同款 30 天默认值正在被集中投诉
 *   （anthropics/claude-code#62476、#64999）；Codex / opencode / Cursor 则根本不自动清理会话。
 *
 * 新口径：默认按时间保留 365 天、不限数量；防磁盘撑爆的兜底改成**总体积上限**
 * （Codex#34061 的 755 GiB 就是没有这一层的后果）。理由是：真正要防的是「盘满」，
 * 不是「会话多」或「会话旧」 —— 拿数量和天数去近似体积，误伤的恰好是最想留的那批。
 *
 * 用户覆盖：`settings.json` 的 `sessionRetention.{enabled,maxAge,maxCount,maxTotalSize,minRetention}`；
 * 旧字段 `cleanupPeriodDays` 仍认，作为 `maxAge` 的别名（显式写了 `maxAge` 时以 `maxAge` 为准）。
 */

/** 默认按时间保留：365 天 */
export const DEFAULT_SESSION_MAX_AGE = "365d";

/** 默认防误删窗口：1 天内更新过的会话无论如何不删 */
export const DEFAULT_SESSION_MIN_RETENTION = "1d";

/** 默认总体积上限：sessions/ + trajectories/sessions/ 合计 10GB，超出才从最旧的开始删 */
export const DEFAULT_SESSION_MAX_TOTAL_SIZE = "10GB";

/** 时间周期格式：数字 + h/d/w/m（m = 30 天）。schema.ts 内联了同款正则，改这里要同步那边。 */
export const RETENTION_PERIOD_PATTERN = /^(\d+)([hdwm])$/;

/** 体积格式：数字（可带小数）+ KB/MB/GB/TB，大小写不敏感。schema.ts 内联了同款正则。 */
export const RETENTION_SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i;

/**
 * 解析时间周期（如 "30d" → 毫秒）
 */
export function parseRetentionPeriod(period: string): number {
  const match = period.match(RETENTION_PERIOD_PATTERN);
  if (!match) {
    throw new Error(`无效的时间周期格式: ${period}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    case "m":
      return value * 30 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`未知的时间单位: ${unit}`);
  }
}

/** 解析体积（如 "10GB" → 字节） */
export function parseRetentionSize(size: string): number {
  const match = size.trim().match(RETENTION_SIZE_PATTERN);
  if (!match) {
    throw new Error(`无效的体积格式: ${size}`);
  }
  const value = parseFloat(match[1]);
  const exp = { KB: 1, MB: 2, GB: 3, TB: 4 }[match[2].toUpperCase() as "KB" | "MB" | "GB" | "TB"];
  return Math.floor(value * 1024 ** exp);
}

/** 用户可写的原始配置形态（settings.json 的 sessionRetention 段） */
export interface SessionRetentionInput {
  enabled?: boolean;
  maxAge?: string;
  maxCount?: number;
  maxTotalSize?: string;
  minRetention?: string;
}

/** 归一后的生效策略 */
export interface SessionRetentionSettings {
  /** 是否启用自动清理 */
  enabled: boolean;
  /** 最大保留时间（如 "365d"） */
  maxAge?: string;
  /** 最大保留数量。默认不限（undefined）—— 防盘满靠 maxTotalSize，不靠数量 */
  maxCount?: number;
  /** 总体积上限（如 "10GB"），超出才按最旧优先删 */
  maxTotalSize?: string;
  /** 最小保留时间（防止误删，如 "1d"） */
  minRetention?: string;
}

/**
 * 从用户配置得到生效策略。
 *
 * `cleanupPeriodDays` 是旧字段（此前只管轨迹目录），这里把它收成 maxAge 的别名，
 * 让「会话」与「轨迹」只剩一个保留期 —— 两个旋钮各管一半时，用户改了一个、
 * 另一半仍按 30 天删，结果是会话还在、轨迹没了（或反过来），恢复与指标同时出问题。
 */
export function resolveRetentionSettings(
  input: SessionRetentionInput | undefined,
  cleanupPeriodDays?: number,
): SessionRetentionSettings {
  const s = input ?? {};
  const legacyAge =
    typeof cleanupPeriodDays === "number" && cleanupPeriodDays > 0
      ? `${Math.ceil(cleanupPeriodDays)}d`
      : undefined;
  return {
    enabled: s.enabled ?? true,
    maxAge: s.maxAge || legacyAge || DEFAULT_SESSION_MAX_AGE,
    // 只认正整数；0 / 负数 / 非数字一律视为「不限」，绝不能解读成「保留 0 个 = 全删」
    maxCount:
      typeof s.maxCount === "number" && Number.isFinite(s.maxCount) && s.maxCount > 0
        ? Math.floor(s.maxCount)
        : undefined,
    maxTotalSize: s.maxTotalSize || DEFAULT_SESSION_MAX_TOTAL_SIZE,
    minRetention: s.minRetention || DEFAULT_SESSION_MIN_RETENTION,
  };
}

/** 把生效的保留期折成毫秒（解析失败回退默认值，不让一个写错的配置变成「立刻全删」） */
export function retentionMaxAgeMs(settings: SessionRetentionSettings): number {
  try {
    return parseRetentionPeriod(settings.maxAge ?? DEFAULT_SESSION_MAX_AGE);
  } catch {
    return parseRetentionPeriod(DEFAULT_SESSION_MAX_AGE);
  }
}
