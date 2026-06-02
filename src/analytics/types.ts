// src/analytics/types.ts
// 类型导出聚合——供外部模块统一引用 analytics 的公共类型
//
// 对应 spec 17 §3.1。本文件只做 re-export,不引入任何运行时依赖。

export type {
  AnalyticsSink,
  EventMetadata,
  EventMetadataValue,
  VerifiedNotCodeOrFilepaths,
  VerifiedPIITagged,
} from "./index.ts";

/**
 * 辅助函数:将普通字符串标记为"已确认不含代码/文件路径"。
 * 调用方需自行保证语义正确——这是开发者契约,不做运行时校验。
 * 用途:减少 `as VerifiedNotCodeOrFilepaths` 的 cast 样板。
 */
export function asVerified(
  value: string,
): import("./index.ts").VerifiedNotCodeOrFilepaths {
  return value as import("./index.ts").VerifiedNotCodeOrFilepaths;
}

/**
 * 辅助函数:将字符串标记为 PII(仅特权后端可见)。
 * 通常配合 `_PROTECTED_` 前缀字段使用。
 */
export function asPII(
  value: string,
): import("./index.ts").VerifiedPIITagged {
  return value as import("./index.ts").VerifiedPIITagged;
}
