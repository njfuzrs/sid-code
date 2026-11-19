/**
 * 记忆新鲜度管理（对齐 Claude Code）
 *
 * 记忆是"写入时的时间点观察"，不是实时状态。超过 1 天的记忆标记为
 * "可能过时"，要求模型验证后再当作事实使用。
 *
 * 年龄有两种出路：`memoryAge` 给索引行注解（绝对日期 + 天数，D-12），
 * `buildFreshnessWarning` 给 Read 出的正文加中文警告；两者判据共用
 * `memoryAgeDays`，避免出现「索引说今天、Read 不提醒」这种自相矛盾。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 计算记忆年龄（天数，向下取整） */
export function memoryAgeDays(mtimeMs: number, now: number = Date.now()): number {
  return Math.floor((now - mtimeMs) / MS_PER_DAY);
}

/**
 * 生成人类可读的年龄描述：`YYYY-MM-DD（N 天前）`（D-12，2026-11-19）。
 *
 * 为什么从「N days ago」改成绝对日期 + 相对天数并给出：
 *
 * - 相对天数只在**读到它的当天**成立。索引进 system prompt 后跨天不变，
 *   「47 days ago」相对的是写入时刻的 now，模型换个时间读到就已经对不上了；
 * - 与提示词自己那条纪律（记忆里的相对日期一律写成绝对日期再保存，
 *   「下周」届时已无意义）是**同一条理由**，原来两处口径互相矛盾；
 * - 绝对日期让它每天的漂移只发生在括号里的天数上，日期部分稳定，便于对照。
 *
 * 括号里的天数仍然保留：模型不擅长算日期差，直接给天数才触发得了「这条很旧」的判断
 * （与 cc 的 `memoryAge.ts` 同一个理由）。
 *
 * `days <= 0` 时不用「today」/「yesterday」这类英文：文案整体是中文，
 * 混排会与同段其它中文措辞割裂；统一成「今天 / 昨天」。
 *
 * 输出日期按本地时区取：`updatedAt` 是本地写入时间戳，用本地日期才对得上直觉。
 */
export function memoryAge(mtimeMs: number, now: number = Date.now()): string {
  const days = memoryAgeDays(mtimeMs, now);
  const d = new Date(mtimeMs);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  if (days <= 0) return `${ymd}（今天）`;
  if (days === 1) return `${ymd}（昨天）`;
  return `${ymd}（${days} 天前）`;
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
    `It records what was true when it was written; the code may have moved on since, ` +
    `so file paths, line numbers and described behavior can be stale. ` +
    `Re-check the current source before relying on it.`
  );
}
