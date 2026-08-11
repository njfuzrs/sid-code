/**
 * 终端工具函数
 *
 * 提供终端能力检测（色深、iTerm2 等）。
 * 参考 gemini-cli/packages/cli/src/ui/utils/terminalUtils.ts
 */

import process from "node:process";

/**
 * 返回当前终端的色深
 * 如果未知或不是 TTY，返回 24（TrueColor）
 */
export function getColorDepth(): number {
  return process.stdout.getColorDepth ? process.stdout.getColorDepth() : 24;
}

/**
 * 返回终端是否为低色深（小于 24 位）
 */
export function isLowColorDepth(): boolean {
  return getColorDepth() < 24;
}

let cachedIsITerm2: boolean | undefined;

/**
 * 返回当前终端是否为 iTerm2
 */
export function isITerm2(): boolean {
  if (cachedIsITerm2 !== undefined) {
    return cachedIsITerm2;
  }

  cachedIsITerm2 = process.env["TERM_PROGRAM"] === "iTerm.app";

  return cachedIsITerm2;
}

/**
 * 重置 iTerm2 检测缓存
 * 主要用于测试
 */
export function resetITerm2Cache(): void {
  cachedIsITerm2 = undefined;
}
