/**
 * 记忆新鲜度管理（对齐 Claude Code）
 *
 * 记忆是"写入时的时间点观察"，不是实时状态。超过 1 天的记忆标记为
 * "可能过时"，要求模型验证后再当作事实使用。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 计算记忆年龄（天数，向下取整） */
export function memoryAgeDays(mtimeMs: number, now: number = Date.now()): number {
  return Math.floor((now - mtimeMs) / MS_PER_DAY);
}

/** 生成人类可读的年龄描述 */
export function memoryAge(mtimeMs: number, now: number = Date.now()): string {
  const days = memoryAgeDays(mtimeMs, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * 为超过 1 天的记忆生成新鲜度警告。
 * 1 天以内返回 null（不需要警告）。
 */
export function buildFreshnessWarning(mtimeMs: number, now: number = Date.now()): string | null {
  const days = memoryAgeDays(mtimeMs, now);
  if (days < 1) return null;
  return (
    `This memory is ${days} day${days === 1 ? "" : "s"} old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}
