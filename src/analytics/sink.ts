// src/analytics/sink.ts
// Sink 路由层——事件生产与消费解耦
//
// 对应 spec 17 §3.2 / §4.3 / §5.2 / §5.3。
// 事件入口(index.ts)只知道 AnalyticsSink 接口;Sink 内部决定:
//   1. 隐私级别门控(privacy-level)
//   2. 采样(sampling, Feature Flag 驱动)
//   3. 元数据富化(metadata)
//   4. 路由到各后端,每个后端按 stripProtected 决定看到脱敏版还是完整版
//   5. Killswitch 门控(killswitch, Feature Flag 驱动)
//
// 采样/killswitch/元数据通过可注入的 hook 实现,默认 no-op,
// Phase 3 通过 setSamplingHook/setKillswitchHook/setMetadataHook 接入,
// 避免本文件直接依赖 feature-flags(保持冷启动轻量)。

import type { AnalyticsSink, EventMetadata } from "./index.ts";
import { stripProtectedFields } from "./privacy.ts";
import { isTelemetryDisabled } from "./privacy-level.ts";

export interface SinkBackend {
  name: string;
  /** 是否接受此事件 */
  accepts(eventName: string): boolean;
  /** 发送事件 */
  send(eventName: string, metadata: EventMetadata): void;
  /** 是否需要脱敏 _PROTECTED_* 字段(true=非特权后端,只看脱敏版) */
  stripProtected: boolean;
  /** 可选:关闭时刷新缓冲 */
  shutdown?(): Promise<void>;
}

// --- 状态 ---

const backends: SinkBackend[] = [];

/** 静态采样配置(Phase 1 兜底;Phase 3 由 Feature Flag hook 覆盖) */
let staticSamplingConfig: Record<string, number> = {};

/** 静态 killswitch(Phase 1 兜底;Phase 3 由 Feature Flag hook 覆盖) */
let staticKilledSinks = new Set<string>();

// --- 可注入 hook(Phase 3 接入)---

/**
 * 采样 hook:返回 null=不采样(100% 发送),0=采样掉,(0,1]=采样率。
 * 默认走静态配置。
 */
let samplingHook: (eventName: string) => number | null = (eventName) => {
  const rate = staticSamplingConfig[eventName];
  if (rate === undefined) return null;
  if (rate <= 0) return 0;
  if (rate >= 1) return null;
  if (Math.random() > rate) return 0;
  return rate;
};

/** killswitch hook:返回 true=该后端被关闭。默认走静态集合。 */
let killswitchHook: (sinkName: string) => boolean = (name) =>
  staticKilledSinks.has(name);

/** 元数据富化 hook:返回要合并进每个事件的上下文字段。默认空。 */
let metadataHook: () => EventMetadata = () => ({});

/** 注册一个导出后端 */
export function registerBackend(backend: SinkBackend): void {
  backends.push(backend);
}

/**
 * 获取已注册后端。
 *
 * 注释原写「测试与关闭流程用」,但两处都不用它:关闭流程直接读模块内的 backends
 * (见 shutdownBackends),测试用 __clearBackendsForTest 重置。属实际零消费者,
 * 保留仅作调试断点用——若下次清理时仍无消费者,直接删。
 */
export function getBackends(): readonly SinkBackend[] {
  return backends;
}

/** 清空已注册后端(仅测试用) */
export function __clearBackendsForTest(): void {
  backends.length = 0;
  staticSamplingConfig = {};
  staticKilledSinks = new Set();
  // 复位 hook 到默认实现
  samplingHook = (eventName) => {
    const rate = staticSamplingConfig[eventName];
    if (rate === undefined) return null;
    if (rate <= 0) return 0;
    if (rate >= 1) return null;
    if (Math.random() > rate) return 0;
    return rate;
  };
  killswitchHook = (name) => staticKilledSinks.has(name);
  metadataHook = () => ({});
}

/** 创建 Sink 实例,绑定到 analytics/index.ts */
export function createAnalyticsSink(): AnalyticsSink {
  return {
    logEvent(eventName: string, metadata: EventMetadata): void {
      // 0. 隐私级别门控——no-telemetry / essential-traffic 直接丢弃
      if (isTelemetryDisabled()) return;

      // 1. 采样检查
      const sampleResult = samplingHook(eventName);
      if (sampleResult === 0) return; // 被采样掉

      // 2. 元数据富化 + 采样率标记
      const ctx = metadataHook();
      const enrichedMetadata: EventMetadata = {
        ...ctx,
        ...metadata,
        ...(sampleResult !== null ? { sample_rate: sampleResult } : {}),
      };

      // 3. 路由到各后端
      for (const backend of backends) {
        if (killswitchHook(backend.name)) continue;
        if (!backend.accepts(eventName)) continue;

        const finalMetadata = backend.stripProtected
          ? stripProtectedFields(enrichedMetadata)
          : enrichedMetadata;

        try {
          backend.send(eventName, finalMetadata);
        } catch {
          // 遥测失败静默吞掉——绝不影响主流程
        }
      }
    },
  };
}

/**
 * 更新静态采样配置(不经 Feature Flag 的兜底路径)。
 *
 * 生产零调用点,但静态路径**本身是可达的**:`init-helpers.ts` 只在
 * `shouldLoadRemoteConfig()` 为真时才 setSamplingHook 覆盖默认实现,而
 * essential-traffic 隐私级别下它返回 false —— 此时生效的就是读 staticSamplingConfig
 * 的默认 hook。既然没人填这个表,它恒为空 = "不采样,全量发送"。
 * 这个 fail-open 默认对隐私级别而言是安全的(essential-traffic 已在
 * createAnalyticsSink 开头由 isTelemetryDisabled 整体拦掉),所以不是缺陷。
 * 保留二者是为了给"不接远程配置但想本地压采样"留一个入口。
 */
export function updateSamplingConfig(config: Record<string, number>): void {
  staticSamplingConfig = config;
}

/** 更新静态 killswitch。生产零调用点,理由同 {@link updateSamplingConfig}。 */
export function updateKilledSinks(sinks: Set<string>): void {
  staticKilledSinks = sinks;
}

// --- Phase 3 接入点 ---

/** 注入采样 hook(Feature Flag 驱动) */
export function setSamplingHook(fn: (eventName: string) => number | null): void {
  samplingHook = fn;
}

/** 注入 killswitch hook(Feature Flag 驱动) */
export function setKillswitchHook(fn: (sinkName: string) => boolean): void {
  killswitchHook = fn;
}

/** 注入元数据富化 hook */
export function setMetadataHook(fn: () => EventMetadata): void {
  metadataHook = fn;
}

/** 关闭所有后端,刷新剩余事件 */
export async function shutdownBackends(): Promise<void> {
  await Promise.allSettled(
    backends.map((b) => (b.shutdown ? b.shutdown() : Promise.resolve())),
  );
}
