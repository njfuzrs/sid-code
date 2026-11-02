/**
 * advanced.ts 迁移时被多条命令共用的辅助函数（命令体系收口时拆出）。
 */

/** 时长格式化 */
export function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
