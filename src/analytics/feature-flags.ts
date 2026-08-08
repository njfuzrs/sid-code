// src/analytics/feature-flags.ts
// 轻量级 Feature Flag 系统——不依赖特定 SaaS
//
// 对应 spec 17 §5.1。
// 读取优先级:环境变量 > 远程配置(内存缓存) > 磁盘缓存 > 本地配置 > 默认值。
// 远程刷新 fire-and-forget,磁盘缓存解决冷启动,环境变量覆盖用于测试/CI。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- 类型 ---

export type FlagValue = string | number | boolean | Record<string, unknown>;

export interface FeatureFlagConfig {
  /** 配置目录(默认 ~/.sid-code/) */
  configDir: string;
  /** 远程配置端点(可选) */
  remoteEndpoint?: string;
  /** 刷新间隔(ms),默认 6 小时 */
  refreshIntervalMs?: number;
  /** 本地 flag 定义 */
  localFlags?: Record<string, FlagValue>;
}

// --- 状态 ---

/** 内存缓存(来自远程配置 + 磁盘缓存合并) */
const remoteValues = new Map<string, FlagValue>();

/** 磁盘缓存路径 */
let diskCachePath: string | null = null;

/** 刷新定时器 */
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** 本地 flag 定义 */
let localFlags: Record<string, FlagValue> = {};

/** 刷新监听器 */
const refreshListeners: Array<() => void> = [];

// --- 公共 API ---

/**
 * 获取 flag 值。函数名明确标注:返回值可能是缓存的、过期的。
 */
export function getFeatureValue_CACHED_MAY_BE_STALE<T extends FlagValue>(
  feature: string,
  defaultValue: T,
): T {
  // 优先级 1: 环境变量覆盖
  const envKey = `SID_CODE_FLAG_${feature.toUpperCase()}`;
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    return parseEnvValue(envValue) as T;
  }

  // 优先级 2+3: 内存缓存(已合并磁盘缓存)
  if (remoteValues.has(feature)) {
    return remoteValues.get(feature) as T;
  }

  // 优先级 4: 本地配置
  if (feature in localFlags) {
    return localFlags[feature] as T;
  }

  // 优先级 5: 默认值
  return defaultValue;
}

/**
 * 初始化 Feature Flag 系统。
 * 加载磁盘缓存,启动远程刷新(如果配置了端点)。
 */
export function initFeatureFlags(config: FeatureFlagConfig): void {
  diskCachePath = join(config.configDir, "feature-flags-cache.json");
  localFlags = config.localFlags ?? {};

  // 加载磁盘缓存
  loadDiskCache();

  // 启动远程刷新
  if (config.remoteEndpoint) {
    const interval = config.refreshIntervalMs ?? 6 * 60 * 60 * 1000;
    const endpoint = config.remoteEndpoint;
    // 首次立即刷新(不阻塞)
    void refreshFromRemote(endpoint);
    // 周期刷新
    refreshTimer = setInterval(() => void refreshFromRemote(endpoint), interval);
    refreshTimer.unref?.();
  }
}

/**
 * 注册刷新监听器。远程配置更新后触发。返回取消订阅函数。
 *
 * **当前零消费者，且这是正确状态,不是接线缺口。** 两个 flag 消费方
 * (sampling.ts / killswitch.ts) 都在每次调用时现读 getFeatureValue_*,不缓存任何
 * 派生状态,因此没有「配置变了要重算」的东西需要被通知。
 * 保留它是为了将来出现「读一次就缓存」的消费方时有现成的失效通道——若一直没有,
 * 应连同 refreshListeners 一并删除,而不是留着假装有订阅机制。
 */
export function onFeatureFlagRefresh(listener: () => void): () => void {
  refreshListeners.push(listener);
  // 如果已有远程值,立即触发一次(处理竞态)
  if (remoteValues.size > 0) {
    queueMicrotask(listener);
  }
  return () => {
    const idx = refreshListeners.indexOf(listener);
    if (idx >= 0) refreshListeners.splice(idx, 1);
  };
}

/** 关闭 Feature Flag 系统 */
export function shutdownFeatureFlags(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** 重置状态(仅测试用) */
export function __resetFeatureFlagsForTest(): void {
  shutdownFeatureFlags();
  remoteValues.clear();
  localFlags = {};
  diskCachePath = null;
  refreshListeners.length = 0;
}

// --- 内部实现 ---

async function refreshFromRemote(endpoint: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (!response.ok) return;

    const payload = (await response.json()) as Record<string, FlagValue>;

    // 全量替换内存缓存(感知远程删除的 flag)
    remoteValues.clear();
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) {
        remoteValues.set(key, value);
      }
    }

    // 同步到磁盘
    syncToDisk();

    // 通知监听器
    for (const listener of refreshListeners) {
      try {
        listener();
      } catch {
        /* 静默 */
      }
    }
  } catch {
    // 远程刷新失败不影响运行——磁盘缓存兜底
  }
}

function loadDiskCache(): void {
  if (!diskCachePath) return;
  try {
    const content = readFileSync(diskCachePath, "utf-8");
    const cached = JSON.parse(content) as Record<string, FlagValue>;
    // 磁盘缓存合并进内存缓存,仅作为 fallback(不覆盖已有内存值)
    for (const [key, value] of Object.entries(cached)) {
      if (!remoteValues.has(key)) {
        remoteValues.set(key, value);
      }
    }
  } catch {
    // 文件不存在或解析失败,跳过
  }
}

function syncToDisk(): void {
  if (!diskCachePath) return;
  try {
    const data = Object.fromEntries(remoteValues);
    writeFileSync(diskCachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // 写入失败不影响运行
  }
}

function parseEnvValue(value: string): FlagValue {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (value.trim() !== "" && !isNaN(num)) return num;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
