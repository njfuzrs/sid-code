/**
 * 时长格式化工具（统一收口）
 *
 * 此前 formatElapsed / formatDuration 散落在 ToolStatus / Composer / TodoPanel /
 * LoadingIndicator 多处，且 ms 精度未控制导致显示浮点数（如 5.967083499999717ms）。
 *
 * 统一后规则：
 * - 输入 ms 先四舍五入到整数
 * - < 1s     → "230ms"
 * - 1s–59s   → "5s"
 * - 1m–59m   → "2m 30s"
 * - >= 1h    → "1h 15m"
 *
 * 对标 CLAUDE.md L1 视觉原子层的「克制」原则，时长不堆砌全量单位。
 */

/**
 * 格式化毫秒为人类可读的时长字符串。
 * @param ms 毫秒数（可以是浮点数，内部会四舍五入）
 * @returns 格式化后的时长字符串
 */
export function formatDuration(ms: number): string {
  const rounded = Math.round(ms);

  if (rounded < 1000) {
    return `${rounded}ms`;
  }

  const totalSeconds = Math.floor(rounded / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  if (minutes < 60) {
    if (remainingSeconds > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h`;
}
