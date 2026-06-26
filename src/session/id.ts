/**
 * 会话 ID 生成（单一事实源）。
 *
 * 格式：`YYYYMMDD-HHMMSS-<8位hex>`，例如 `20260627-143052-a1b2c3d4`。
 *
 * 为什么是这个格式（取代旧的 `crypto.randomUUID().slice(0, 8)` 纯 8 位 hex）：
 * - **可排序、好分类**：时间戳前缀使目录名/文件名的字典序天然等于时间序，
 *   `ls ~/.sid-code/trajectories/sessions` 直接按会话发生时间排列，无需读 mtime。
 * - **抗碰撞不退化**：随机后缀仍是 32 bit（8 位 hex，与旧方案等熵），且额外叠加
 *   了秒级时间分桶——两个会话要碰撞必须「同一秒」且随机后缀相同，实际碰撞域比
 *   旧的「全时间域内 32 bit 纯随机」大得多。同秒并发开 ~100 个会话才约 0.03% 概率，
 *   人工交互场景不可能触及。
 * - **可读**：肉眼即可判断会话日期，排查 / 反馈问题时无需查映射表。
 *
 * 业界参照：ULID / UUIDv7 / KSUID 均采用「时间前缀 + 随机后缀」（可排序 + 抗碰撞）。
 *
 * 向后兼容：旧的 8 位 hex 会话 id 仍可被加载/匹配——所有消费方按「字符串包含/相等」
 * 而非「定长 8 字符」识别 id（见 session/utils.ts、command/advanced.ts）。
 */

import { randomUUID } from "node:crypto";

/**
 * 生成一个新的会话 ID。
 * @param date 时间基准（默认当前时刻）；显式传入便于测试可重现。
 */
export function generateSessionId(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  // 8 位 hex 随机后缀（32 bit 熵，与旧 randomUUID().slice(0,8) 等强）
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${datePart}-${timePart}-${rand}`;
}
