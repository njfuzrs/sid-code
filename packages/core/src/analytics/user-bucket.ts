// src/analytics/user-bucket.ts
// 用户分桶——用于估算受影响的用户数量
//
// 对应 spec 17 §5.3。
// SHA256 哈希 → 30 桶。无法反推用户身份;基数固定(不导致标签爆炸);
// 可统计"有多少个不同的桶出现了错误"来估算受影响用户比例。

import { createHash } from "node:crypto";

const NUM_USER_BUCKETS = 30;

let cachedBucket: number | null = null;
let cachedKey: string | null = null;

/**
 * 获取指定用户 ID 的桶号(0-29)。
 * 同一 userId 在进程内缓存,避免重复哈希。
 */
export function getUserBucket(userId: string): number {
  if (cachedBucket !== null && cachedKey === userId) return cachedBucket;

  const hash = createHash("sha256").update(userId).digest("hex");
  cachedBucket = parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS;
  cachedKey = userId;
  return cachedBucket;
}

/** 重置缓存(仅测试用) */
export function __resetUserBucketForTest(): void {
  cachedBucket = null;
  cachedKey = null;
}
