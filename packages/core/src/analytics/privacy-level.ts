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

/**
 * 是否允许连接硬编码的第三方 / 发布服务器（essential-traffic 下为 false）。
 *
 * 实际接入方（P1-11 核对过调用点）：Feature Flag 拉取、自动更新检查
 * （update/index.ts）、外部模型目录同步（model-capabilities.ts syncExternalCatalogs）。
 *
 * **刻意不受它控制**的出网——它们只连用户自己配置的模型端点，不新增暴露面：
 * 主模型请求、网关定价同步（gateway-pricing.ts，关掉只会让成本估算失真）、
 * API 预连接（只连主模型 baseURL，取不到就不连）。
 * 轨迹上传 / 告警 webhook / `--upload-traces` 用的是 isEssentialTrafficOnly()。
 */
export function shouldLoadRemoteConfig(): boolean {
  return !isEssentialTrafficOnly();
}
