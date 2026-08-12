/**
 * Blocked Detector — 连续卡住检测
 *
 * 当模型连续多轮在同一问题上卡住时，自动检测并暂停。
 * 使用评估者返回的结构化 blockerKey 做精确匹配，而非纯文本关键词交集。
 */

import { getLogger } from "../debug/logger.ts";

const log = getLogger();

export class BlockedDetector {
  private recentBlockerKeys: string[] = [];
  private threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  /** 记录一次评估的 blockerKey，返回是否判定为 blocked */
  record(blockerKey: string | undefined): boolean {
    if (!blockerKey) {
      // 无 blockerKey 意味着评估者认为有进展，重置计数
      this.recentBlockerKeys = [];
      return false;
    }

    this.recentBlockerKeys.push(blockerKey);

    // 只保留最近 N+2 条
    if (this.recentBlockerKeys.length > this.threshold + 2) {
      this.recentBlockerKeys = this.recentBlockerKeys.slice(-this.threshold - 2);
    }

    // 检查最近 threshold 条是否为同一个 blockerKey
    if (this.recentBlockerKeys.length < this.threshold) return false;

    const recent = this.recentBlockerKeys.slice(-this.threshold);
    const isBlocked = recent.every((k) => k === recent[0]);
    if (isBlocked) {
      log.warn(
        "GOAL_BLOCKED",
        `卡住检测触发: key="${blockerKey}", 连续 ${this.threshold} 轮相同阻塞原因`,
      );
    }
    return isBlocked;
  }

  reset(): void {
    this.recentBlockerKeys = [];
  }
}
