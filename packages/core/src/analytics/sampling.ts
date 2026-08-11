// src/analytics/sampling.ts
// 事件采样——按事件名差异化,Feature Flag 动态驱动
//
// 对应 spec 17 §5.2。

import { getFeatureValue_CACHED_MAY_BE_STALE } from "./feature-flags.ts";

/** 采样配置的 Feature Flag 名称 */
const SAMPLING_CONFIG_FLAG = "event_sampling_config";

/**
 * 判断事件是否应该被采样发送。
 *
 * 返回值:
 * - null: 不采样,100% 发送(不附带 sample_rate)
 * - 0: 被采样掉,不发送
 * - (0, 1): 采样率,发送并附带 sample_rate 字段
 */
export function shouldSampleEvent(eventName: string): number | null {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, number>>(
    SAMPLING_CONFIG_FLAG,
    {},
  );

  const rate = config[eventName];
  if (rate === undefined) return null; // 未配置采样,100% 发送

  if (rate <= 0) return 0; // 完全禁止
  if (rate >= 1) return null; // 100% 发送

  // 随机采样
  if (Math.random() > rate) return 0; // 被采样掉
  return rate; // 通过采样,返回采样率
}
