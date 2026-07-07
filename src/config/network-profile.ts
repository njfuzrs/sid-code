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

/**
 * Provider 层流式超时默认值（parseSSE 字节级看门狗 + fetch 生命周期硬顶）。
 *
 * 设计原则同上：**不按模型名分档**（原 openai.ts 按 /deepseek/i 分 90/180s、120/300s，
 * 直接违反本文件顶部原则，见 memory `feedback-no-hardcoded-model-tier-rules.md`）。
 * 一套够宽的值对所有模型成立：慢模型（deepseek/qwen/kimi/glm 长文思考）不会被误杀，
 * 快模型顶多"多等一会才判超时"，真卡死由重试兜底且全程可见。
 *
 * 各项与 loop/lifecycle 层的对齐关系：
 *   - idleTimeoutMs 300s：字节级"reader 无任何 chunk"上限，与 watchdogNoProgressMs 同量级。
 *     （原 90/180s 偏紧，网关排队+慢模型思考期首字节可达数分钟。）
 *   - contentProgressTimeoutMs 300s：字节级"有 chunk 但无有效内容进展"（keep-alive/ping 续命）
 *     上限，与 watchdogNoProgressMs 一致。
 *   - fetchAbsoluteTimeoutMs 300s：整个 fetch 生命周期的绝对上限（AbortSignal.timeout），
 *     与 headerTimeoutMs 同值——原 openai.ts 是独立字面量 300_000，改一个不改另一个的隐患。
 *   - overallTimeoutMs 600s：请求级事件流硬顶（lifecycle Layer 3），单轮 30min 硬顶之下的更严一档。
 */
export interface ProviderStreamTimeouts {
  idleTimeoutMs: number;
  contentProgressTimeoutMs: number;
  fetchAbsoluteTimeoutMs: number;
  overallTimeoutMs: number;
}

export const PROVIDER_STREAM_DEFAULTS: Readonly<ProviderStreamTimeouts> = {
  idleTimeoutMs: 300_000,
  contentProgressTimeoutMs: 300_000,
  fetchAbsoluteTimeoutMs: 300_000,
  overallTimeoutMs: 600_000,
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

/**
 * Side-call 超时子表（配置-4）：warmup/compact/collapse/recall 四类轻量旁路调用的硬超时。
 *
 * 与主循环/provider 超时不同：这些是"锦上添花、失败即静默降级"的旁路（缓存预热、
 * 上下文压缩、分段折叠、记忆召回），语义各异故**保留分档**（不强行统一到一个值），
 * 但收敛此前散落 4 个文件、各自 IIFE `Number(process.env)` 的重复解析——统一走 readEnvMs
 * 校验 + 单一默认值表，消除"四份重复 + 数值各异又与 LIFECYCLE_PRESETS.sideCall 概念重叠"的碎裂。
 *
 * env 命名保留向后兼容：SID_CODE_WARMUP_TIMEOUT_MS / _COMPACT_TIMEOUT_MS /
 * _COLLAPSE_SEGMENT_TIMEOUT_MS / _RECALL_TIMEOUT_MS。
 */
export interface SideCallTimeouts {
  /** 缓存预热（会话启动，最短） */
  warmupMs: number;
  /** auto-compact LLM 摘要（最长，摘要不应超过 1 分钟） */
  compactMs: number;
  /** context-collapse 单段摘要 */
  collapseSegmentMs: number;
  /** 记忆召回初筛（轻量） */
  recallMs: number;
}

export const SIDE_CALL_DEFAULTS: Readonly<SideCallTimeouts> = {
  warmupMs: 10_000,
  compactMs: 60_000,
  collapseSegmentMs: 45_000,
  recallMs: 15_000,
};

/** 解析 side-call 超时子表：env override（readEnvMs 校验）> 统一默认值。 */
export function resolveSideCallTimeouts(): SideCallTimeouts {
  return {
    warmupMs: readEnvMs("SID_CODE_WARMUP_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.warmupMs,
    compactMs: readEnvMs("SID_CODE_COMPACT_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.compactMs,
    collapseSegmentMs:
      readEnvMs("SID_CODE_COLLAPSE_SEGMENT_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.collapseSegmentMs,
    recallMs: readEnvMs("SID_CODE_RECALL_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.recallMs,
  };
}

/**
 * 面向 provider 内部（openai/anthropic）的流式看门狗解析：env override > 统一默认值。
 * 统一入口替代此前散落在 openai.ts/anthropic.ts 的 `Number(process.env.X)`/`parseInt` 就地解析
 * （配置-3）。所有 env 都走 readEnvMs 校验（非法值静默回退默认，而非把 NaN 传给定时器）。
 *
 * env 命名保留向后兼容（运维/测试注入）：
 *   - SID_CODE_IDLE_TIMEOUT_MS：字节级 idle（openai parseSSE）
 *   - SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS：字节级 content progress（openai parseSSE）
 *   - SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS：anthropic lifecycle content progress
 *   - SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS：fetch 生命周期硬顶（两 provider 共用）
 *   - SID_CODE_OPENAI_OVERALL_TIMEOUT_MS / SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS：lifecycle overall
 */
export function resolveProviderStreamTimeouts(opts?: {
  /** anthropic 与 openai 的 content-progress / overall 用不同 env 名，用此区分 */
  providerKind?: "openai" | "anthropic";
}): ProviderStreamTimeouts {
  const kind = opts?.providerKind ?? "openai";
  const contentProgressEnv =
    kind === "anthropic"
      ? "SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS"
      : "SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS";
  const overallEnv =
    kind === "anthropic"
      ? "SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS"
      : "SID_CODE_OPENAI_OVERALL_TIMEOUT_MS";
  return {
    idleTimeoutMs:
      readEnvMs("SID_CODE_IDLE_TIMEOUT_MS") ?? PROVIDER_STREAM_DEFAULTS.idleTimeoutMs,
    contentProgressTimeoutMs:
      readEnvMs(contentProgressEnv) ?? PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs,
    fetchAbsoluteTimeoutMs:
      readEnvMs("SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS") ?? PROVIDER_STREAM_DEFAULTS.fetchAbsoluteTimeoutMs,
    overallTimeoutMs:
      readEnvMs(overallEnv) ?? PROVIDER_STREAM_DEFAULTS.overallTimeoutMs,
  };
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
