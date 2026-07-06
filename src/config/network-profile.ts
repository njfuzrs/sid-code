/**
 * 网络超时/重试统一配置
 *
 * 背景：超时阈值此前分散在 openai.ts/anthropic.ts/loop.ts 等文件的 15+ 个独立环境
 * 变量里，且默认值只按官方直连 API 的延迟分布校准，未考虑经公司网关/代理转发场景下
 * 排队+鉴权带来的额外延迟——结果是网关抖动时看门狗把仍在正常排队的连接强杀。
 *
 * 设计原则（2026-07 与用户对齐，长期不变）：
 *   1. **只有一套默认值**，不区分 direct/gateway、不按模型分档。理由：
 *      - 两套规则 = 两套需要各自维护的真相，出问题难排查（网关判定错一次就走错档）。
 *      - 单套值只要放得足够宽，直连场景顶多"多等一会才判超时"，无功能性损害；
 *        网关场景则直接被这套宽松阈值兜住，用户无感。
 *      - 按模型名硬编码分档（deepseek/default）会随模型迭代漂移出隐患，见 memory
 *        `feedback-no-hardcoded-model-tier-rules.md`。一套够宽的值对所有模型都成立。
 *   2. 默认值按"保活优先"校准：宁可多等，也不无声杀死任务。真正卡死的连接由重试
 *      兜底，且重试全程在 TUI 可见（见 loop.ts 的 timeout_retry / app.ts 的展示），
 *      不会再表现为"死循环"。
 *
 * 优先级链（从高到低）：
 *   1. 环境变量（SID_CODE_*，保留向后兼容，供运维/测试注入）
 *   2. settings.json 的 network.* 具体字段
 *   3. 统一默认值表 DEFAULTS
 *
 * 本文件不依赖 Config 类型（故意）：resolveLoopTimeouts 接受扁平的 LoopTimeoutInputs
 * 而非整个 Config 对象，避免与 config.ts（Config.network 字段引用本文件的类型）之间
 * 产生双向类型依赖。
 */

/** settings.json network 配置块的运行时形状（与 settings/types.ts 的 Zod schema 对应） */
export interface NetworkTimeoutSettings {
  headerTimeoutMs?: number;
  watchdogNoProgressMs?: number;
  watchdogCheckIntervalMs?: number;
  watchdogHeaderGraceMs?: number;
  maxTurnDurationMs?: number;
  maxTimeoutRetries?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
}

export interface ResolvedLoopTimeouts {
  headerTimeoutMs: number;
  watchdogCheckIntervalMs: number;
  watchdogNoProgressMs: number;
  watchdogHeaderGraceMs: number;
  maxTurnDurationMs: number;
  maxTimeoutRetries: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
}

/**
 * 统一默认值表（唯一真相源）。按"保活优先 + 覆盖网关排队"校准：
 *   - headerTimeoutMs 300s：网关鉴权+排队后首字节可达 2-4 分钟属正常，给足余量。
 *   - watchdogNoProgressMs 300s：已建连后中途静默（网关缓冲/限速）同样给足 5 分钟，
 *     真·半开 TCP 卡死才会等满这个阈值后转重试——但重试可见，不再是死循环。
 *   - maxTurnDurationMs 30min：单轮硬顶兜底（覆盖任何挂起根因），远大于正常单轮耗时。
 *   - maxTimeoutRetries 4 + 指数退避：网关抖动往往是暂时的，多给几次带退避的重试机会。
 *   - watchdogCheckIntervalMs 5s / watchdogHeaderGraceMs 15s：检查频率与首字节余量，
 *     不是"能否容忍慢"的核心变量，取稳健值即可。
 *
 * 任何一项都可经环境变量或 settings.json 覆盖（见 resolveLoopTimeouts）。
 */
export const DEFAULTS: Readonly<ResolvedLoopTimeouts> = {
  headerTimeoutMs: 300_000,
  watchdogNoProgressMs: 300_000,
  watchdogCheckIntervalMs: 5_000,
  watchdogHeaderGraceMs: 15_000,
  maxTurnDurationMs: 30 * 60_000,
  maxTimeoutRetries: 4,
  retryBackoffBaseMs: 2_000,
  retryBackoffMaxMs: 30_000,
};

/** 指数退避 + ±15% jitter（避免多次重试同时撞线的惊群效应），封顶 maxMs。 */
export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const capped = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  return Math.round(capped * (0.85 + Math.random() * 0.3));
}

function readEnvMs(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function readEnvNonNegative(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** resolveLoopTimeouts 的输入——只取 network 覆盖块，不耦合整个 Config 类型。 */
export interface LoopTimeoutInputs {
  network?: NetworkTimeoutSettings;
}

/**
 * 面向 loop.ts：三层优先级 env override > settings.network 具体字段 > 统一默认值。
 * loop.ts 调用时传入 config.network 即可，无需整个 Config。
 */
export function resolveLoopTimeouts(input: LoopTimeoutInputs): ResolvedLoopTimeouts {
  const n = input.network;
  return {
    headerTimeoutMs:
      readEnvMs("SID_CODE_RESPONSE_HEADER_TIMEOUT_MS") ?? n?.headerTimeoutMs ?? DEFAULTS.headerTimeoutMs,
    watchdogCheckIntervalMs:
      readEnvMs("SID_CODE_WATCHDOG_CHECK_INTERVAL_MS") ?? n?.watchdogCheckIntervalMs ?? DEFAULTS.watchdogCheckIntervalMs,
    watchdogNoProgressMs:
      readEnvMs("SID_CODE_WATCHDOG_NO_PROGRESS_MS") ?? n?.watchdogNoProgressMs ?? DEFAULTS.watchdogNoProgressMs,
    watchdogHeaderGraceMs:
      readEnvNonNegative("SID_CODE_WATCHDOG_HEADER_GRACE_MS") ?? n?.watchdogHeaderGraceMs ?? DEFAULTS.watchdogHeaderGraceMs,
    maxTurnDurationMs:
      readEnvMs("SID_CODE_MAX_TURN_DURATION_MS") ?? n?.maxTurnDurationMs ?? DEFAULTS.maxTurnDurationMs,
    maxTimeoutRetries:
      readEnvNonNegative("SID_CODE_MAX_TIMEOUT_RETRIES") ?? n?.maxTimeoutRetries ?? DEFAULTS.maxTimeoutRetries,
    retryBackoffBaseMs:
      readEnvNonNegative("SID_CODE_RETRY_BACKOFF_BASE_MS") ?? n?.retryBackoffBaseMs ?? DEFAULTS.retryBackoffBaseMs,
    retryBackoffMaxMs:
      readEnvMs("SID_CODE_RETRY_BACKOFF_MAX_MS") ?? n?.retryBackoffMaxMs ?? DEFAULTS.retryBackoffMaxMs,
  };
}

/**
 * 面向 openai.ts/anthropic.ts 内部：Provider 实例只有 this.baseURL，读不到 settings.network，
 * 因此只支持 "env override > 统一默认值" 两层。header 超时与 loop 层用同一套值，
 * 保证 provider 的 fetch 级 header 超时 与 看门狗的 header 兜底阈值一致（不会一个先杀另一个）。
 */
export function resolveHeaderTimeoutMs(): number {
  return readEnvMs("SID_CODE_RESPONSE_HEADER_TIMEOUT_MS") ?? DEFAULTS.headerTimeoutMs;
}
