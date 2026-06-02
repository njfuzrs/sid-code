// src/analytics/privacy-level.ts
// 隐私级别体系——三级递进模型
//
// 对应 spec 17 §3.3。
// 限制性递增: default < no-telemetry < essential-traffic
// 最严格的环境变量信号优先。

/** 隐私级别,限制性递增 */
export type PrivacyLevel = "default" | "no-telemetry" | "essential-traffic";

/** 配置文件中可设置的隐私级别覆盖(优先级低于环境变量) */
let configuredLevel: PrivacyLevel | null = null;

/**
 * 设置配置文件中的隐私级别(由 config 加载时调用)。
 * 环境变量优先级更高,配置值仅在无环境变量时生效。
 */
export function setConfiguredPrivacyLevel(level: PrivacyLevel | null): void {
  configuredLevel = level;
}

/**
 * 获取当前隐私级别。
 * 最严格的信号优先:环境变量 > 配置文件 > 默认。
 */
export function getPrivacyLevel(): PrivacyLevel {
  // 最严格:只保留 API 调用
  if (process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1") {
    return "essential-traffic";
  }
  // 中等:禁用遥测,保留其他功能
  if (process.env.SID_CODE_DISABLE_TELEMETRY === "1") {
    return "no-telemetry";
  }
  // 配置文件覆盖
  if (configuredLevel !== null) {
    return configuredLevel;
  }
  return "default";
}

/** 遥测是否被禁用(no-telemetry 或 essential-traffic) */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== "default";
}

/** 是否只允许必要流量(essential-traffic) */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === "essential-traffic";
}

/** 是否允许加载远程配置(Feature Flag / 自动更新检查) */
export function shouldLoadRemoteConfig(): boolean {
  return !isEssentialTrafficOnly();
}
