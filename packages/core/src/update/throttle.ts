/**
 * 自动更新 — 节流逻辑
 *
 * 每 24 小时最多检查一次（可经 env `SID_CODE_UPDATE_CHECK_INTERVAL_HOURS` 覆盖，未文档化）
 *
 * 节流依据：state.json 的 `lastCheckAt`（ISO timestamp）
 */

import type { UpdateState } from "./state.ts";

const DEFAULT_INTERVAL_HOURS = 24;

/**
 * 获取检查间隔（小时）
 */
function getIntervalHours(): number {
  const envVal = process.env.SID_CODE_UPDATE_CHECK_INTERVAL_HOURS?.trim();
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INTERVAL_HOURS;
}

/**
 * 判断是否应该执行检查
 * @param state 当前状态
 * @param now 当前时间（可注入，便于测试）
 * @returns true 如果应该检查（距上次检查 >= 间隔，或从未检查过）
 */
export function shouldCheck(state: UpdateState, now: Date = new Date()): boolean {
  if (!state.lastCheckAt) return true; // 从未检查过

  const lastCheck = new Date(state.lastCheckAt);
  if (isNaN(lastCheck.getTime())) return true; // 时间戳损坏，视为从未检查

  const intervalMs = getIntervalHours() * 60 * 60 * 1000;
  const elapsed = now.getTime() - lastCheck.getTime();
  return elapsed >= intervalMs;
}
