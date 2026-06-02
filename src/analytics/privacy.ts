// src/analytics/privacy.ts
// 隐私工具函数——_PROTECTED_* 双通道机制
//
// 对应 spec 17 §3.2 / §4.3。
// _PROTECTED_ 前缀标记的字段仅流向特权后端(如本地 JSONL),
// 非特权后端(如远程监控平台)看到的是去除这些字段后的脱敏版本。

import type { EventMetadata, EventMetadataValue } from "./index.ts";

/** _PROTECTED_ 前缀标记的字段仅流向特权后端 */
export const PROTECTED_PREFIX = "_PROTECTED_";

/**
 * 移除所有 _PROTECTED_* 前缀的字段。
 * 用于发送到非特权后端(如公开的监控平台)。
 *
 * 性能优化:只在发现 _PROTECTED_ 前缀时才创建新对象,
 * 否则返回原引用(零拷贝)。
 */
export function stripProtectedFields(metadata: EventMetadata): EventMetadata {
  let result: Record<string, EventMetadataValue> | undefined;

  for (const key in metadata) {
    if (key.startsWith(PROTECTED_PREFIX)) {
      if (result === undefined) {
        result = { ...metadata }; // 惰性拷贝
      }
      delete result[key];
    }
  }

  return (result ?? metadata) as EventMetadata;
}

/**
 * 提取 _PROTECTED_* 字段,返回去除前缀后的键值对。
 * 用于特权后端将这些字段路由到受控存储。
 */
export function extractProtectedFields(
  metadata: EventMetadata,
): Record<string, EventMetadataValue> {
  const out: Record<string, EventMetadataValue> = {};

  for (const key in metadata) {
    if (key.startsWith(PROTECTED_PREFIX)) {
      const cleanKey = key.slice(PROTECTED_PREFIX.length);
      out[cleanKey] = metadata[key];
    }
  }

  return out;
}

/** 是否包含任何 _PROTECTED_* 字段 */
export function hasProtectedFields(metadata: EventMetadata): boolean {
  for (const key in metadata) {
    if (key.startsWith(PROTECTED_PREFIX)) return true;
  }
  return false;
}
