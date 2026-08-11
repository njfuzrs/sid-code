// src/analytics/killswitch.ts
// Sink Killswitch——紧急情况下不发版关闭特定后端
//
// 对应 spec 17 §5.2。

import { getFeatureValue_CACHED_MAY_BE_STALE } from "./feature-flags.ts";

/** Killswitch 的 Feature Flag 名称 */
const KILLSWITCH_FLAG = "sink_killswitch";

/**
 * 检查指定的 Sink 后端是否被 killswitch 关闭。
 * 用于紧急情况下不发版关闭特定后端。
 */
export function isSinkKilled(sinkName: string): boolean {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, boolean>>(
    KILLSWITCH_FLAG,
    {},
  );

  return config[sinkName] === true;
}
