/**
 * TUI 数值格式化共享工具
 *
 * 底部状态栏、统计面板等多处需要把大数字（token 数、字符数等）
 * 格式化为人类可读形式（如 102.4k、1.22m），避免纯数字过长不直观。
 * 集中一处，避免重复实现。
 */

/**
 * 格式化大数字为人类可读形式。
 * - < 1000：直接显示数字
 * - >= 1000：除以 1000，加 "k" 后缀，保留 2 位小数并去掉尾部多余零
 * - >= 1_000_000：除以 1_000_000，加 "m" 后缀，同理
 *
 * 示例：999 → "999" / 102400 → "102.4k" / 1220000 → "1.22m"
 */
export function formatLargeNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${parseFloat(v.toFixed(2))}k`;
  }
  const v = n / 1_000_000;
  return `${parseFloat(v.toFixed(2))}m`;
}
