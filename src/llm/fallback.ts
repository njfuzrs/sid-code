/**
 * 模型回退机制 — 统一的重试引擎
 *
 * Phase 1.2 重写：从双引擎（fallback.ts + retry-engine.ts）统一为单一引擎，
 * 吸收 retry-engine 的全部能力：
 * - QuerySource 前台/后台差异化
 * - 指数退避 + 25% jitter + Retry-After 优先
 * - x-should-retry header 支持
 * - rate-limit-reset header 解析
 * - 529 连续计数 + Fallback 触发
 * - max_tokens 溢出自动恢复
 * - 401 认证刷新重试
 * - keep-alive 管理（ECONNRESET/EPIPE）
 * - Telemetry 埋点回调
 *
 * Phase 4：persistent retry + fast-mode 预留
 */

import type { Provider } from "./provider.ts";
import type { SendParams, StreamEvent } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { emitTimeoutFired, armIneffectiveCheck, getStreamSnapshot } from "../trace/stream-observer.ts";
import { currentSseDumpContext } from "./sse-chunk-dumper.ts";
import {
  classifyError,
  classifyStreamError,
  TerminalError,
  RetryableError,
  StreamValidationError,
  isAbortError,
  toAbortError,
  RequestAbortedError,
  getNetworkErrorCode,
  parseXShouldRetry,
  is401Error,
  is408Error,
  is409Error,
} from "./errors.ts";
import { ModelAvailabilityService } from "./availability.ts";
import { lookupRegistry } from "./model-registry.ts";
import type { RetryTelemetryEvent } from "./retry-telemetry.ts";
import { DEFAULTS as NETWORK_DEFAULTS } from "../config/network-profile.ts";
import { calculateRetryDelay as calculateSharedRetryDelay } from "./retry-backoff.ts";
import { disableKeepAlive } from "./keepalive.ts";

// ═══════════════════════════════════════════════════════════════════
// 查询来源分类（从 retry-engine.ts 吸收）
// ═══════════════════════════════════════════════════════════════════

/** 查询来源分类 */
export type QuerySource =
  | "main_thread"   // 用户主对话（前台）
  | "agent"         // 子代理（前台）
  | "compact"       // 上下文压缩（前台）
  | "summary"       // 摘要生成（后台）
  | "title"         // 标题生成（后台）
  | "classifier";   // 分类器（后台）

/** 前台查询源 — 用户正在等待结果，529 时重试 */
export const FOREGROUND_SOURCES = new Set<QuerySource>([
  "main_thread",
  "agent",
  "compact",
]);

/** 后台查询遇到 529 时是否仍重试 */
export function shouldRetry529(querySource?: QuerySource): boolean {
  return querySource === undefined || FOREGROUND_SOURCES.has(querySource);
}

// ═══════════════════════════════════════════════════════════════════
// 重试常量
// ═══════════════════════════════════════════════════════════════════

// B1-b：原 CONNECTION_RETRY 常量已删除。它只服务于「连接阶段重试 for 循环」，
// 而该循环在生产路径不可达（sendMessageStream 是惰性 async generator 工厂 +
// 两个 provider 都把连接错误转成流内 error 事件而非抛出），已随之删除。
// 现在只有一套重试参数 STREAM_RETRY，不再有两份平行配置可供漂移。

/** 流式阶段重试配置。
 *  maxDelayMs 从 10s 抬到 120s（最关键）：旧值 10s 把流式退避硬砍到 10 秒内，遇限流/过载时
 *  几次重试全挤在十几秒内打完，未给服务恢复窗口。现与 network-profile.retryBackoffMaxMs 对齐。 */
const STREAM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 120000,
};

/** 默认流超时（毫秒）。配置-1：不再独立硬编码 300_000，从 network-profile 统一默认值派生
 *  （生产路径由 app.ts 注入 streamTimeoutMs；此默认仅在未注入时兜底，如直接 new ModelFallback() 的测试）。 */
const DEFAULT_STREAM_TIMEOUT_MS = NETWORK_DEFAULTS.watchdogNoProgressMs; // 300s

/** max_tokens 溢出恢复：安全余量 */
const SAFETY_BUFFER = 1_000;

/** max_tokens 溢出恢复：最小输出 token 数的绝对下限（兜底）。
 *  历史固定值 3000——对输出能力 128K 的模型，降到 3K 几乎等于放弃恢复。
 *  现改为"按 contextLimit 比例算 floor，再与此绝对下限取较大者"（见 resolveFloorOutputTokens），
 *  可经 SID_RECOVERY_FLOOR_TOKENS 显式覆盖。保成功：让需要大段输出的任务更易从溢出中恢复。 */
const FLOOR_OUTPUT_TOKENS = 3_000;

/** 溢出恢复 floor 占 contextLimit 的比例（默认 5%）。
 *  对 1M 窗口模型给出 50K floor，对 200K 给 10K，远比固定 3K 更贴合模型能力。 */
const FLOOR_OUTPUT_RATIO = 0.05;

/** 解析溢出恢复的最小输出 token 下限。
 *  优先级：SID_RECOVERY_FLOOR_TOKENS 显式值 > contextLimit × 5%（与绝对下限取大）> 绝对下限 3000。
 *  非法 env 值（NaN/≤0）静默回退，绝不更紧。 */
function resolveFloorOutputTokens(contextLimit: number): number {
  const raw = process.env.SID_RECOVERY_FLOOR_TOKENS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (contextLimit > 0) {
    return Math.max(FLOOR_OUTPUT_TOKENS, Math.floor(contextLimit * FLOOR_OUTPUT_RATIO));
  }
  return FLOOR_OUTPUT_TOKENS;
}

/** 连续 529 触发降级的阈值 */
const MAX_529_CONSECUTIVE = 3;

/** persistent retry 最大退避（5 分钟） */
const PERSISTENT_MAX_DELAY_MS = 300_000;

// B1-b：原 PERSISTENT_HEARTBEAT_MS（30s）已删除。它只用于「重连同步抛错后 persistent
// 模式的心跳等待」——该分支随重连 try/catch 一并删除（重连现走 openStream 归一化，
// 同步抛错会回到统一的流式 catch，persistent 无限重试由
// `attempt >= streamMaxRetries` 分支的 `attempt = -1` 承担，语义不变且只剩一处）。

// ═══════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════

/**
 * Fallback 切换决策结果（onFallbackDecision 钩子返回）。
 * - switch：切换到指定模型（含已构建好的 provider）。
 * - abort：不切换，终止本轮（yield error 让上层展示"已终止，可重发/换模型"）。
 */
export type FallbackDecision =
  | { action: "switch"; model: string; provider: Provider }
  | { action: "abort" };

/** Fallback 切换模式：ask 询问用户 / auto 自动切默认 / off 不降级直接报错。 */
export type FallbackSwitchMode = "ask" | "auto" | "off";

/** 回退配置 */
export interface FallbackConfig {
  /** 降级 Provider */
  fallbackProvider?: Provider;
  /** 降级模型 */
  fallbackModel?: string;
  /**
   * 切换模式（默认 "auto"，保护直接 new ModelFallback() 的测试不被弹窗阻塞；
   * 生产由 app.ts 从 config.fallbackSwitchMode ?? "ask" 注入——即生产默认询问）。
   * - "ask"：主模型失败且有 onFallbackDecision 钩子时，询问用户是否切换、切到哪个模型。
   * - "auto"：保持旧行为，重试耗尽直接切 fallbackModel。
   * - "off"：不降级，直接 yield error 终止本轮。
   */
  fallbackSwitchMode?: FallbackSwitchMode;
  /**
   * 切换决策钩子（ask 模式生效）。由 app.ts 注入，内部弹出选择题并阻塞等用户作答。
   * 惰性执行：仅在真正触发降级那一刻调用（此时 TUI handler 早已就绪）。
   * headless/无交互通道时应内部降级为 auto 语义（切默认或 abort），绝不阻塞无头进程。
   */
  onFallbackDecision?: (ctx: {
    failedModel: string;
    reason: string;
    defaultFallbackModel?: string;
    signal?: AbortSignal;
  }) => Promise<FallbackDecision>;
  /** 模型可用性服务 */
  availability?: ModelAvailabilityService;
  /** 查询来源（前台/后台），影响 529 重试策略 */
  querySource?: QuerySource;
  /** 最大重试次数（默认由各阶段配置决定） */
  maxRetries?: number;
  /** 不确定-2/3：单次 executeWithFallback 调用内"连接阶段 + 流式阶段"重试的共享总上界。
   *  防止两阶段各自独立计数叠加成退避风暴。默认由 network-profile 的 maxRetriesPerCall 注入。 */
  maxRetriesPerCall?: number;
  /** 流式整体超时（毫秒，默认 5 分钟） */
  streamTimeoutMs?: number;
  /** 配置-1：退避基数（毫秒）。默认由 network-profile 的 retryBackoffBaseMs 注入 */
  retryBackoffBaseMs?: number;
  /** 配置-1：退避上限（毫秒）。默认由 network-profile 的 retryBackoffMaxMs 注入 */
  retryBackoffMaxMs?: number;
  /** 上下文窗口大小（用于 max_tokens 溢出恢复）。
   *  H1：此前构造从不注入 → tryRecoverMaxTokens 恒 return null（死代码）。
   *  静态值适合固定单模型；主模型可切换时优先用 resolveContextLimit 回调按当前模型实时解析。 */
  contextLimit?: number;
  /** H1：按模型名解析上下文窗口的回调（主模型可切换时用，优先于静态 contextLimit）。
   *  由 app.ts 注入，内部走 TokenEstimator().getContextLimit(model, availableModels)。 */
  resolveContextLimit?: (model: string) => number | undefined;
  /** H4：按模型名解析输出上限（maxOutputTokens）的回调。
   *  由 app.ts 注入，内部走 resolveMaxOutputTokensForModel（availableModels > 注册表）。
   *  fallback 目标钳制 maxTokens 时用它替代「只查内置注册表」，避免注册表外的自定义模型漏钳制。 */
  resolveMaxOutputTokens?: (model: string) => number | undefined;
  /** 是否禁用 keep-alive（ECONNRESET 后自动置位） */
  disableKeepAlive?: boolean;
  /** Phase 4：无人值守 persistent retry 模式 */
  persistent?: boolean;
  /** Phase 4：fast-mode 感知（预留，暂未启用） */
  fastMode?: boolean;
  /** Telemetry 埋点回调 */
  onTelemetry?: (event: RetryTelemetryEvent) => void;
}

/** 回退事件监听器 */
export interface FallbackListener {
  onRetry?: (attempt: number, error: string, delayMs: number) => void;
  onFallback?: (reason: string, fallbackModel: string) => void;
  /** 后台 529 被丢弃时的回调 */
  on529Dropped?: (querySource: string) => void;
  /** max_tokens 自动调整时的回调 */
  onMaxTokensAdjusted?: (originalTokens: number, adjustedTokens: number) => void;
}

/** 系统 API 错误消息 — 对标 claude-code 的 SystemAPIErrorMessage */
export interface SystemAPIErrorMessage {
  type: "system_api_error";
  /** 用户可读的错误描述 */
  content: string;
  /** 等待时间（毫秒） */
  delayMs: number;
  /** 当前尝试次数（1-based） */
  attempt: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 错误分类标签 */
  category: string;
}

/**
 * 单次调用级参数覆盖（B1-a）。
 *
 * 对标 claude-code `withRetry.ts` 的 `options` 参数：**per-call 差异靠传参表达，
 * 而不是靠实例配置**。背景（§0.2 实证 4）：`querySource` 等字段原本只存在于
 * `this.config`，而 `app.ts:709` 是全进程单实例 —— 单实例无法同时正确服务
 * `main_thread`（前台）与 `agent`（子代理）/ 后台 side-call，而 529 前后台闸门
 * 恰好依赖 querySource，故闸门在并发下必然失准。
 *
 * 未传的字段**全部回落 `this.config`**，因此现有调用方（`engine.ts:275` 等）
 * 零改动、行为逐字段不变。B2 让子代理走漏斗时，只需在这里传
 * `{ querySource: "agent:builtin", switchMode: "auto" }` —— 旧文档因
 * 「生产默认 switchMode=ask 需要 TUI」把「子代理不能降级」记为合理设计差异，
 * 改成 per-call 后这只是一个参数，差异消失。
 */
export interface PerCallOptions {
  /** 本次调用的查询来源（影响 529 前后台闸门）。未传回落 config.querySource。 */
  querySource?: QuerySource;
  /** 本次调用的降级模式。未传回落 config.fallbackSwitchMode（生产默认 ask）。 */
  switchMode?: FallbackSwitchMode;
  /** 本次调用的降级目标模型。未传回落 config.fallbackModel。 */
  fallbackModel?: string;
  /** 本次调用的降级目标 provider。未传回落 config.fallbackProvider。 */
  fallbackProvider?: Provider;
  /** 本次调用的重试上界。未传回落 config.maxRetries。 */
  maxRetries?: number;
  /** 发起方 agent 标识（遥测归因与 B4 per-agent 状态隔离用）。 */
  agentId?: string;
}

/** 内部重试上下文 */
interface RetryContext {
  /** 401 认证错误的「只重试一次」闸门（首个 401 置位并立即重试；第二个 401 因已置位落到
   *  classifyError → TerminalError → markTerminal + fallback）。
   *  N1（另案）：当前无 auth 刷新钩子消费此标志——重试用的仍是同一份旧凭据，故它实际只是
   *  「retry-once 闸门」而非「刷新触发器」。真正接线凭据刷新钩子超出本次修复范围，另案跟踪；
   *  在此之前**不可删除**该标志——删了会让首个 401 直接 terminal 拉黑，丧失「瞬时 401 重试一次」
   *  的容错。 */
  needsAuthRefresh: boolean;
  /** 是否需要禁用 keep-alive（ECONNRESET 后置位） */
  disableKeepAlive: boolean;
  /** 连续 529 计数 */
  consecutive529: number;
  /** max_tokens 溢出恢复时的覆盖值 */
  maxTokensOverride?: number;
  /** 不确定-2/3：本次 executeWithFallback 调用内累计的重试次数（连接阶段 + 流式阶段共享）。
   *  达到 maxRetriesPerCall 上界后不再重试，防两阶段独立计数叠加成退避风暴。 */
  totalRetriesThisCall: number;
  /** B1-a：本次调用内是否已降级过（二次降级短路判据）。
   *
   *  原为实例字段 `this.hasFallenBack`，而 `app.ts` 是全进程单实例 → 6 个并行子代理
   *  共用一个标志：A 降级过一次置位后，B/C/D 再想降级会被 `tryFallback` 静默拒绝
   *  （§0.2 实证 2）。`engine.ts:275` 每次调用前先 `reset()` 正是「状态共享」的证据
   *  —— 无状态的实现不需要 reset，且并行调用会互相 reset 打架。
   *
   *  搬到 per-call 后职责分离：**控制流判据**取本上下文（并发安全）；实例侧
   *  `lastCallFellBack` 只作为「上次调用是否降级」的**上报位**给
   *  `checkFallbackOccurred()`（`loop.ts:2643` 消费它 yield tombstone）。 */
  hasFallenBack: boolean;
  /** B1-a：本次调用的有效 per-call 覆盖（未传字段已在入口回落 this.config）。 */
  perCall: PerCallOptions;
}

// ═══════════════════════════════════════════════════════════════════
// ModelFallback — 核心引擎
// ═══════════════════════════════════════════════════════════════════

export class ModelFallback {
  private config: FallbackConfig;
  private listener: FallbackListener | null;
  /** B1-a：**上报位**，不是控制位。
   *
   *  记录「最近一次 executeWithFallback 调用是否发生过降级」，供
   *  `checkFallbackOccurred()` → `loop.ts:2643` yield tombstone 撤回已推给 UI 的
   *  半截 assistant 消息。降级的**控制流判据**已搬进 per-call 的
   *  `RetryContext.hasFallenBack`（见其注释），故并行子代理不再互相干扰彼此的
   *  降级能力；本字段被并发覆盖最坏只影响 tombstone 时机（UI 提示），不影响韧性决策。 */
  private lastCallFellBack = false;
  private availability: ModelAvailabilityService;

  constructor(config: Partial<FallbackConfig> = {}, listener?: FallbackListener) {
    this.config = {
      fallbackProvider: config.fallbackProvider,
      fallbackModel: config.fallbackModel,
      fallbackSwitchMode: config.fallbackSwitchMode,
      onFallbackDecision: config.onFallbackDecision,
      availability: config.availability,
      querySource: config.querySource,
      maxRetries: config.maxRetries,
      maxRetriesPerCall: config.maxRetriesPerCall,
      streamTimeoutMs: config.streamTimeoutMs,
      retryBackoffBaseMs: config.retryBackoffBaseMs,
      retryBackoffMaxMs: config.retryBackoffMaxMs,
      contextLimit: config.contextLimit,
      resolveContextLimit: config.resolveContextLimit,
      resolveMaxOutputTokens: config.resolveMaxOutputTokens,
      disableKeepAlive: config.disableKeepAlive,
      persistent: config.persistent,
      fastMode: config.fastMode,
      onTelemetry: config.onTelemetry,
    };
    this.listener = listener ?? null;
    this.availability = config.availability ?? new ModelAvailabilityService();
  }

  /** 获取可用性服务（供外部访问） */
  getAvailability(): ModelAvailabilityService {
    return this.availability;
  }

  /**
   * 运行时更新 fallback 目标（/model fallback 切换用）。
   * fallback 的 provider/model 原本只在构造时定死；/model 切换 fallbackModel 后若不同步更新，
   * 主模型出错降级仍会走旧目标。传 undefined 表示清除 fallback（回退到"无降级"）。
   */
  setFallbackTarget(fallbackModel: string | undefined, fallbackProvider: Provider | undefined): void {
    this.config.fallbackModel = fallbackModel;
    this.config.fallbackProvider = fallbackProvider;
    // 已发生过的降级状态重置，避免旧降级标志影响新目标判定。
    this.lastCallFellBack = false;
  }

  /**
   * 执行带回退的操作
   *
   * 分阶段：
   * 1. 连接阶段重试（含 401 认证刷新、ECONNRESET keep-alive 处理）
   * 2. 流式阶段消费（含 529 计数、max_tokens 溢出恢复、超时保护）
   * 3. Fallback Provider
   */
  async *executeWithFallback(
    primaryProvider: Provider,
    params: SendParams,
    signal?: AbortSignal,
    perCallOptions?: PerCallOptions,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    // B1-a：解析 per-call 覆盖 —— 未传的字段**逐个回落 this.config**，
    // 故现有三参调用方（engine.ts:275 等）行为逐字段不变。
    const perCall: PerCallOptions = {
      querySource: perCallOptions?.querySource ?? this.config.querySource,
      switchMode: perCallOptions?.switchMode ?? this.config.fallbackSwitchMode,
      fallbackModel: perCallOptions?.fallbackModel ?? this.config.fallbackModel,
      fallbackProvider: perCallOptions?.fallbackProvider ?? this.config.fallbackProvider,
      maxRetries: perCallOptions?.maxRetries ?? this.config.maxRetries,
      agentId: perCallOptions?.agentId,
    };

    // § 注入流内遥测转发：把 provider 产出的协议无关 StreamTelemetrySignal
    // 转成 RetryTelemetryEvent，进入统一遥测通道（events.jsonl / trace-digest.ts）。
    // 链式保留调用方可能已传入的回调（通常为空）。
    const upstreamStreamTelemetry = params.onStreamTelemetry;
    params = {
      ...params,
      onStreamTelemetry: (sig) => {
        try { upstreamStreamTelemetry?.(sig); } catch { /* ignore */ }
        this.emitTelemetry({ ...sig, model: params.model });
      },
    };

    // 检查模型可用性
    const availCheck = this.availability.isAvailable(params.model);
    if (!availCheck.available) {
      log.warn("FALLBACK", `模型 ${params.model} 不可用: ${availCheck.reason}`);
      yield* this.tryFallback(params, signal);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // 流超时保护：AbortController 主动中断 HTTP 连接
    // ═══════════════════════════════════════════════════════════════
    const streamTimeoutMs = this.config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    let streamTimeoutCtl = new AbortController();
    let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
    // 缺口 2 进阶：fallback 整体超时 fire 后武装未生效检查；abort 被流循环观察到时 disarm。
    // 若 5s 内 abort 未能中断已进入的 SSE 消费（parseSSE hang 场景）→ TimeoutIneffective。
    let disarmStreamIneffective: (() => void) | null = null;

    const startStreamTimeout = () => {
      streamTimeoutId = setTimeout(() => {
        log.warn("FALLBACK", `流式整体超时: ${streamTimeoutMs / 1000}s，主动中断连接`);
        // 缺口 2：记录 fallback 流式整体超时触发
        emitTimeoutFired(currentSseDumpContext().turnIndex, "fallback_stream_timeout", {
          threshold_ms: streamTimeoutMs,
          model: params.model,
        });
        // 缺口 2 进阶：武装未生效检查（abort 后若流循环 5s 内未抛出 → TimeoutIneffective）
        disarmStreamIneffective = armIneffectiveCheck(
          currentSseDumpContext().turnIndex,
          "fallback_stream_timeout",
          "abort_not_observed_by_stream_after_5s",
        );
        streamTimeoutCtl.abort();
      }, streamTimeoutMs);
      // 不调 unref()：fdb47f30 教训——index 23 请求发出后 hang 死,若定时器被 unref,
      // 在事件循环空闲时 Node/Bun 不保证它按时 fire,整体超时形同虚设、无法自愈。
      // 这里是"受管理的非 unref 定时器"：resetStreamTimeout / 正常收尾路径都会 clearTimeout,
      // 不会泄漏阻止进程退出。宁可让它确实持有事件循环,也要保证超时一定触发。
    };

    const resetStreamTimeout = () => {
      if (streamTimeoutId !== null) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = null;
      }
      // 缺口 2 进阶：旧超时窗口作废 → disarm 其未生效检查（避免误报）。
      (disarmStreamIneffective as (() => void) | null)?.();
      disarmStreamIneffective = null;
      streamTimeoutCtl = new AbortController();
      startStreamTimeout();
    };

    const makeCombinedSignal = (): AbortSignal => {
      if (signal && !signal.aborted) {
        return AbortSignal.any([signal, streamTimeoutCtl.signal]);
      }
      return streamTimeoutCtl.signal;
    };

    startStreamTimeout();

    // 重试上下文（跨 phase 共享）
    const ctx: RetryContext = {
      needsAuthRefresh: false,
      disableKeepAlive: this.config.disableKeepAlive ?? false,
      consecutive529: 0,
      totalRetriesThisCall: 0,
      // B1-a：降级控制态从实例字段搬入 per-call 上下文（并发安全，见字段注释）。
      hasFallenBack: false,
      perCall,
    };
    // 不确定-2/3：单次调用共享重试预算上界（连接 + 流式两阶段合并计数）。
    const maxRetriesPerCall = this.config.maxRetriesPerCall ?? NETWORK_DEFAULTS.maxTimeoutRetries;

    // ═══════════════════════════════════════════════════════════════
    // 建流（不重试）——B1-b：原「阶段 1：连接重试 for 循环」已删除
    // ═══════════════════════════════════════════════════════════════
    //
    // 为什么删：`sendMessageStream` 是 **async generator 工厂**，调用它只是构造
    // 生成器对象、**不执行任何函数体**（惰性求值）——真正的网络 IO 直到下方流式
    // 阶段第一次 `iterator.next()` 才发生。因此原循环的 catch 在生产路径**永远
    // 捕不到网络错误**：401/ECONNRESET/529 全部在流式阶段抛出。
    //
    // 更强的证据（实测两条 provider 路径）：两个 provider 都**不抛**连接错误，
    // 而是把它转成流内 error 事件 —— `anthropic.ts:610-617` catch 后
    // `yield {type:"error"}`，`openai.ts:862-880` 对 `!response.ok` 同样
    // `yield {type:"error"}`。即连接失败在生产路径连「抛出」都不会发生，
    // 原循环的 catch 是双重不可达。
    //
    // 于是它承载的三项能力（401 retry-once 闸门 / ECONNRESET 禁 keep-alive /
    // 529 计数）全是**死代码**，看着有、实际从不生效。B1-b 把它们搬进下方流式
    // catch（真正会执行的地方），此处只保留一次同步建流：
    //   - 生产：构造生成器不会抛，等价于原循环首次迭代成功；
    //   - 测试：少数 mock 用**非 generator 函数**同步 throw（如 `throwProvider`），
    //     这条 try 保证它们仍被归一化为流式路径的可重试错误，而不是穿透成未捕获异常。
    // 防复发：`tests/llm/fallback-connection-loop-removed.test.ts` 钉住「本文件
    // 不得再出现连接阶段重试循环」，避免日后被"修活"成第二份平行实现。
    const initialParams = ctx.maxTokensOverride
      ? { ...params, maxTokens: ctx.maxTokensOverride }
      : params;
    let stream: AsyncIterable<StreamEvent> = this.openStream(
      primaryProvider,
      initialParams,
      makeCombinedSignal(),
      signal,
    );

    // ═══════════════════════════════════════════════════════════════
    // 流式消费（唯一的重试点）
    // ═══════════════════════════════════════════════════════════════
    let hasYieldedContent = false;
    const streamMaxRetries = perCall.maxRetries ?? STREAM_RETRY.maxRetries;

    try {
      for (let attempt = 0; attempt <= streamMaxRetries; attempt++) {
        try {
          log.debug("FALLBACK", `流式阶段尝试 ${attempt + 1}/${streamMaxRetries + 1}`);

          // P0-2 修复：将 `for await` 改为手动迭代 + Promise.race(abortPromise)。
          // 当 SSE 半开（TCP 连接在、服务端不再发 event）时，`for await` 内的 reader.read()
          // 永不 settle，signal?.aborted 检查永远执行不到。通过 race abort，abort 触发时
          // 立即 reject，不等下一个 event。参考模板：openai.ts:1291-1343。
          const abortPromise: Promise<never> | null = (() => {
            if (!signal || signal.aborted) return null;
            return new Promise<never>((_, reject) => {
              const onAbort = () => reject(new RequestAbortedError("请求已中止（abort race）"));
              signal.addEventListener("abort", onAbort, { once: true });
            });
          })();

          const iterator = stream[Symbol.asyncIterator]();
          let iterDone = false;
          while (!iterDone) {
            const racers: Promise<IteratorResult<StreamEvent>>[] = [iterator.next()];
            if (abortPromise) racers.push(abortPromise as any);
            const iterResult = await Promise.race(racers);
            if (iterResult.done) {
              iterDone = true;
              break;
            }
            const event = iterResult.value;

            if (signal?.aborted) {
              throw new RequestAbortedError("请求已中止");
            }

            if (event.type === "error") {
              if (isAbortError(event.error.message)) {
                throw toAbortError(event.error.message);
              }

              // ── max_tokens 溢出自动恢复（感知 thinking budget）──
              const maxTokensResult = this.tryRecoverMaxTokens(
                event.error.message,
                params.model,
                params.thinking?.budgetTokens,
              );
              if (maxTokensResult !== null) {
                const adjusted = maxTokensResult;
                const original = params.maxTokens;
                log.info("FALLBACK", `max_tokens 溢出恢复: ${original} → ${adjusted}`);
                ctx.maxTokensOverride = adjusted;
                this.listener?.onMaxTokensAdjusted?.(original, adjusted);
                this.emitTelemetry({
                  type: "max_tokens_adjust",
                  model: params.model,
                  originalTokens: original,
                  adjustedTokens: adjusted,
                });
                // 跳出当前流，进入流式重试（会使用新的 maxTokens）
                throw new RetryableError(event.error.message, "server_error");
              }

              const classified = event.error.streamLevel
                ? classifyStreamError(
                    params.model.split(":")[0] || params.model,
                    event.error.message,
                    event.error.type,
                    event.error.statusCode,
                  )
                : classifyError(new Error(event.error.message));

              if (classified instanceof TerminalError) {
                this.availability.markTerminal(params.model, classified.reason);
                log.error("FALLBACK", `流式终端错误: ${classified.reason}`);
                yield* this.tryFallback(params, signal, ctx);
                return;
              }

              // ── 529 计数维护 ──
              if (classified instanceof RetryableError && classified.reason === "overloaded") {
                ctx.consecutive529++;
              } else {
                ctx.consecutive529 = 0;
              }

              // ── 后台 529 立即放弃 ──
              if (
                classified instanceof RetryableError &&
                classified.reason === "overloaded" &&
                !shouldRetry529(perCall.querySource)
              ) {
                log.info("FALLBACK", `后台查询遇 529，立即放弃`);
                this.listener?.on529Dropped?.(perCall.querySource ?? "unknown");
                this.emitTelemetry({
                  type: "529_dropped",
                  model: params.model,
                  querySource: perCall.querySource ?? "unknown",
                });
                yield* this.tryFallback(params, signal, ctx);
                return;
              }

              // ── 529 连续达上限 ──
              if (
                classified instanceof RetryableError &&
                classified.reason === "overloaded" &&
                ctx.consecutive529 >= MAX_529_CONSECUTIVE
              ) {
                log.warn("FALLBACK", `连续 ${ctx.consecutive529} 次 529，触发降级`);
                this.emitTelemetry({
                  type: "fallback",
                  model: params.model,
                  fallbackModel: perCall.fallbackModel,
                  error: "连续 529 错误",
                });
                yield* this.tryFallback(params, signal, ctx);
                return;
              }

              if (classified instanceof RetryableError && attempt < streamMaxRetries) {
                log.warn("FALLBACK", `流式错误，准备重试: ${event.error.message}`);
                throw classified;
              }

              yield* this.tryFallback(params, signal, ctx);
              return;
            }

            if (event.type === "content_block_delta") {
              hasYieldedContent = true;
            }

            yield event;
          }

          // 验证流完整性
          if (!hasYieldedContent) {
            throw new StreamValidationError("响应为空", "empty_response");
          }

          // 成功完成，标记模型健康
          this.availability.markHealthy(params.model);
          return;

        } catch (err) {
          // 用户主动中断（ESC）：立即传播，终止整轮对话
          if (signal?.aborted) {
            throw toAbortError(err);
          }

          // 区分「流式超时中断」与「其他 abort」：
          // - 超时中断（streamTimeoutCtl 触发）当作可重试的 timeout 错误，
          //   走正常重试 → fallback 路径（对标文档承诺的「超时 → 流重试 → fallback」）
          // - 其他 abort（非用户、非超时，理论上少见）仍传播
          const isTimeoutAbort = isAbortError(err) && streamTimeoutCtl.signal.aborted;
          // 缺口 2 进阶：流循环观察到超时 abort → 超时确实生效，disarm 未生效检查。
          if (isTimeoutAbort) {
            (disarmStreamIneffective as (() => void) | null)?.();
            disarmStreamIneffective = null;
          }
          if (isAbortError(err) && !isTimeoutAbort) {
            throw toAbortError(err);
          }

          // ═══════════════════════════════════════════════════════════
          // B1-b 复活①：401 retry-once 闸门
          // ═══════════════════════════════════════════════════════════
          //
          // **必须置于 classifyError 之前**：401 会被 classifyError 判成
          // TerminalError("auth_failed") → 下面立刻 markTerminal 拉黑模型 + 转
          // fallback。放在其后等于闸门永不生效（这正是它在原连接循环里"看着有、
          // 实际从不执行"之外的第二重失效）。
          //
          // 语义（沿用 RetryContext.needsAuthRefresh 注释）：首个 401 置位并**不退避**
          // 立即重试一次——覆盖凭据瞬时失效/网关抖动；第二个 401 因已置位而落到
          // classifyError → TerminalError → 拉黑 + fallback，不会无限重试。
          // N1（另案）：暂无凭据刷新钩子，重试用的仍是旧凭据，故它只是「retry-once
          // 闸门」而非「刷新触发器」。
          if (!isTimeoutAbort && is401Error(err) && !ctx.needsAuthRefresh) {
            log.info("FALLBACK", "401 认证错误，触发 retry-once 闸门并重试（暂无凭据刷新钩子，不退避）");
            ctx.needsAuthRefresh = true;
            this.emitTelemetry({ type: "auth_refresh", model: params.model, error: String(err) });
            resetStreamTimeout();
            try {
              const retryParams = ctx.maxTokensOverride
                ? { ...params, maxTokens: ctx.maxTokensOverride }
                : params;
              stream = primaryProvider.sendMessageStream(retryParams, makeCombinedSignal());
              hasYieldedContent = false;
              // 不消耗 attempt 预算：retry-once 闸门自带"只一次"上界（needsAuthRefresh
              // 已置位），且不退避——与 CC withRetry 的 401 刷新重试同语义。
              attempt--;
              continue;
            } catch (reauthErr) {
              if (signal?.aborted || isAbortError(reauthErr)) {
                throw toAbortError(reauthErr);
              }
              log.error("FALLBACK", `401 重试建流失败: ${reauthErr}`);
              yield* this.tryFallback(params, signal, ctx);
              return;
            }
          }

          // ═══════════════════════════════════════════════════════════
          // B1-b 复活②：ECONNRESET / EPIPE → 禁用 keep-alive
          // ═══════════════════════════════════════════════════════════
          //
          // 与①同理，原先只在不可达的连接 catch 里置位；且置位的两个字段
          // （ctx.disableKeepAlive / config.disableKeepAlive）**全仓无消费者**，
          // 即便执行了也是空转。现同时接线真消费者：`keepalive.ts` 的进程级开关
          // → provider fetch 选项 `{ keepalive: false }`（anthropic 走自定义 fetch
          // 包装，openai 走 fetch init 展开）。
          //
          // 为什么必须禁用而非原样重试：ECONNRESET/EPIPE 的典型成因是连接池里的
          // socket 已被对端/网关单方面关闭而本地仍认为可用，**原样重试会命中同一条
          // 死连接**，重试次数被白烧。禁用复用后强制新建连接才可能自愈。
          const netCode = getNetworkErrorCode(err);
          if ((netCode === "ECONNRESET" || netCode === "EPIPE") && !ctx.disableKeepAlive) {
            log.info("FALLBACK", `${netCode} 检测到，禁用 keep-alive 连接池（进程级，后续请求不复用连接）`);
            ctx.disableKeepAlive = true;
            this.config.disableKeepAlive = true;
            disableKeepAlive(); // ← 真消费者：进入 provider 的 fetch 选项
          }

          const classified = isTimeoutAbort
            ? new RetryableError(`流式整体超时（${streamTimeoutMs / 1000}s 无数据）`, "timeout")
            : classifyError(err);

          if (classified instanceof TerminalError) {
            this.availability.markTerminal(params.model, classified.reason);
            log.error("FALLBACK", `终端错误: ${classified.reason}`);
            yield* this.tryFallback(params, signal, ctx);
            return;
          }

          if (attempt >= streamMaxRetries) {
            log.warn("FALLBACK", `流式阶段重试 ${streamMaxRetries} 次后仍失败`);
            this.availability.markRetryOnce(params.model, "流式传输失败");

            // persistent 模式：无限重试
            if (this.config.persistent) {
              log.info("FALLBACK", "persistent 模式，继续重试");
              const delayMs = PERSISTENT_MAX_DELAY_MS;
              this.emitTelemetry({
                type: "persistent_retry_wait",
                model: params.model,
                delayMs,
              });
              yield* this.sleepWithProgress(
                delayMs,
                attempt + 1,
                streamMaxRetries + 1,
                "persistent_retry",
                signal,
              );
              // 重置计数，继续循环
              attempt = -1;
              continue;
            }

            break;
          }

          // 不确定-2/3：单次调用共享重试预算上界。persistent（无人值守）模式豁免——它明确
          // 要求无限重试直到成功，不受此上界约束（其无限循环在上面的 attempt>=streamMaxRetries
          // 分支内自成一路）。非 persistent 路径达到上界即停止重试、转 fallback。
          if (!this.config.persistent && ctx.totalRetriesThisCall >= maxRetriesPerCall) {
            log.warn(
              "FALLBACK",
              `流式阶段：单次调用累计重试已达上界 ${maxRetriesPerCall}，停止重试转 fallback`,
            );
            this.availability.markRetryOnce(params.model, "单次调用重试上界");
            break;
          }
          ctx.totalRetriesThisCall++;

          // 流式重试：重新发起完整请求
          const delayMs = this.calculateRetryDelay(err, attempt, classified, STREAM_RETRY.maxDelayMs);

          log.info("FALLBACK", `流式重试 ${attempt + 1}，延迟 ${delayMs}ms`);
          this.listener?.onRetry?.(attempt + 1, classified.message, delayMs);
          // §6.3 重复开流成因遥测：推导本次"重新获取流"的结构化原因。
          // 优先取 stream-observer snapshot 里最近触发的超时层（idle_timeout /
          // content_progress_timeout / fallback_stream_timeout——这些是导致重开的精确信号），
          // 无超时记录则取 classified.reason（network_error/overloaded/empty_response 等）。
          // 这是 §2.7 "同一轮重复开流"观测盲区的根因定位钥匙——回放会话时可据此判断
          // 重复开流是 idle 超时、内容进展超时、还是网络抖动导致，而非仅凭 error 字符串猜测。
          // 控制流收窄在深层嵌套循环里退化为 Error，用显式 instanceof 取 reason。
          let reopenReason = "unknown";
          if (classified instanceof RetryableError) {
            reopenReason = classified.reason;
          }
          try {
            const { turnIndex, loopId } = currentSseDumpContext();
            const snapshot = getStreamSnapshot(turnIndex, loopId);
            if (snapshot && snapshot.timeoutsFired.length > 0) {
              reopenReason = snapshot.timeoutsFired[snapshot.timeoutsFired.length - 1];
            }
          } catch { /* 可观测性不影响重试 */ }
          this.emitTelemetry({
            type: "retry",
            model: params.model,
            attempt: attempt + 1,
            delayMs,
            error: classified.message,
            phase: "stream",
            reopenReason,
          });

          yield* this.sleepWithProgress(
            delayMs,
            attempt + 1,
            streamMaxRetries + 1,
            "retry",
            signal,
          );

          // 重置超时计时器
          resetStreamTimeout();

          // 重新获取流
          // B1-b：与首次建流走**同一个** openStream —— 同步抛错被归一化成「首次
          // next() 即抛」的流，于是下一轮迭代照常进入本 catch 继续退避重试。
          //
          // 修复前这里是独立 try/catch，同步抛错直接 `break` 转 fallback，形成
          // 「首次同步抛错可重试、重试时同步抛错却立刻放弃」两套语义。实测回归：
          // `stream-interrupt-recovery.test.ts` 的 ECONNRESET 用例断言 3 次尝试
          // （2 失败 + 1 成功），旧 break 路径只跑 2 次就降级。
          stream = this.openStream(
            primaryProvider,
            ctx.maxTokensOverride ? { ...params, maxTokens: ctx.maxTokensOverride } : params,
            makeCombinedSignal(),
            signal,
          );
          // 清空内容标志（新流需要重新检测）
          hasYieldedContent = false;
        }
      }
    } finally {
      if (streamTimeoutId !== null) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = null;
      }
      // 缺口 2 进阶：流式阶段收尾（正常/异常/fallback）→ disarm 未生效检查兜底。
      (disarmStreamIneffective as (() => void) | null)?.();
      disarmStreamIneffective = null;
    }

    // ═══════════════════════════════════════════════════════════════
    // 重试耗尽 → Fallback Provider
    // ═══════════════════════════════════════════════════════════════
    yield* this.tryFallback(params, signal, ctx);
  }

  /**
   * 尝试使用 fallback Provider。
   *
   * 三态切换（fallbackSwitchMode，默认 auto）：
   * - "off"：不降级，直接 yield error 终止本轮。
   * - "auto"（或无 onFallbackDecision 钩子）：保持旧行为，直接切 config.fallbackModel。
   * - "ask"：调 onFallbackDecision 钩子（app.ts 注入，弹选择题）决定切哪个模型 / 不切。
   *
   * 所有降级路径都汇聚到本方法，故三态决策在此单点生效即全覆盖。
   */
  private async *tryFallback(
    params: SendParams,
    signal?: AbortSignal,
    ctx?: RetryContext,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    // 已经用过 fallback（二次降级）→ 不再重复切换，直接报错。
    // B1-a：判据取 per-call 上下文（并发安全）；ctx 缺省时（理论上不发生，仅防御
    // 未来新增调用路径漏传）回落实例上报位，保持旧行为而非静默放开二次降级。
    if (ctx ? ctx.hasFallenBack : this.lastCallFellBack) {
      log.error("FALLBACK", "主 Provider 失败且 fallback 已用尽");
      yield {
        type: "error",
        error: { message: "模型请求失败，已达最大重试次数且 fallback 已用尽" },
      };
      return;
    }

    // B1-a：per-call 覆盖优先（ctx 缺省时回落 config，行为不变）。
    // B2 让子代理走漏斗时传 switchMode:"auto" 即可绕开需要 TUI 的 ask 模式——
    // 旧文档把「子代理不能降级」记为设计差异，改成 per-call 后它只是一个参数。
    const pc = ctx?.perCall;
    const mode = pc?.switchMode ?? this.config.fallbackSwitchMode ?? "auto";
    const cfgFallbackModel = pc?.fallbackModel ?? this.config.fallbackModel;
    const cfgFallbackProvider = pc?.fallbackProvider ?? this.config.fallbackProvider;

    // ── "off"：禁用降级，直接报错终止本轮 ──
    if (mode === "off") {
      log.warn("FALLBACK", "fallbackSwitchMode=off，不降级，直接终止本轮");
      yield {
        type: "error",
        error: { message: "模型请求失败，已达最大重试次数（降级已禁用 fallbackSwitchMode=off）" },
      };
      return;
    }

    // ── 决定切换目标：ask 走钩子，auto 走 config.fallbackModel ──
    let targetModel: string | undefined;
    let targetProvider: Provider | undefined;

    if (mode === "ask" && this.config.onFallbackDecision) {
      let decision: FallbackDecision;
      try {
        decision = await this.config.onFallbackDecision({
          failedModel: params.model,
          reason: "主模型重试耗尽",
          defaultFallbackModel: cfgFallbackModel || undefined,
          signal,
        });
      } catch (err) {
        // 钩子抛错 → fail-open 到 auto 语义（保任务不中断，切默认 fallback）。
        log.warn("FALLBACK", `onFallbackDecision 钩子异常，fail-open 到默认降级: ${err}`);
        decision = { action: "abort" };
        if (cfgFallbackProvider && cfgFallbackModel) {
          decision = {
            action: "switch",
            model: cfgFallbackModel,
            provider: cfgFallbackProvider,
          };
        }
      }
      if (decision.action === "abort") {
        log.warn("FALLBACK", "用户/钩子选择不切换，终止本轮");
        yield {
          type: "error",
          error: { message: "主模型请求失败，已终止本轮。可重新发送消息重试，或用 /model 切换模型。" },
        };
        return;
      }
      targetModel = decision.model;
      targetProvider = decision.provider;
    } else {
      // auto（或 ask 但无钩子）：切 config 里的默认 fallback。
      targetModel = cfgFallbackModel || undefined;
      targetProvider = cfgFallbackProvider;
    }

    // ── 无可用目标 → 报错 ──
    if (!targetProvider || !targetModel) {
      log.error("FALLBACK", "主 Provider 失败且无可用 fallback");
      yield {
        type: "error",
        error: { message: "模型请求失败，已达最大重试次数且无可用 fallback" },
      };
      return;
    }

    // ── 执行切换 ──
    // B1-a：控制态记在 per-call 上下文（并发安全，决定"本次调用不再二次降级"）；
    // 实例侧只更新上报位，供 loop.ts 的 tombstone 检查消费。
    if (ctx) ctx.hasFallenBack = true;
    this.lastCallFellBack = true;
    log.warn("FALLBACK", `切换到 fallback 模型: ${targetModel}`);
    this.listener?.onFallback?.("主模型失败", targetModel);
    this.emitTelemetry({
      type: "fallback",
      model: params.model,
      fallbackModel: targetModel,
      error: "主模型失败",
    });

    yield* this.streamFromFallback(params, targetModel, targetProvider, signal);
  }

  /**
   * 建流并归一化「同步抛错」（B1-b）。
   *
   * `sendMessageStream` 在生产路径是 async generator 工厂：调用它只构造生成器、
   * 不执行函数体，故网络错误都在首次 `next()`（即流式消费阶段）抛出，本函数的
   * catch 在生产路径不会命中。但部分测试 mock 用**非 generator 函数**同步 throw，
   * 若不归一化就会穿透成未捕获异常、绕过全部韧性逻辑。
   *
   * 归一化为「首次 next() 即抛该错误」的流后，两类 provider 走**完全相同**的
   * 处置路径（401 闸门 / keep-alive / 529 计数 / 退避重试），不再有第二份实现。
   *
   * abort 例外：用户中断（ESC）必须立即传播，不能包装成可重试错误。
   */
  private openStream(
    provider: Provider,
    params: SendParams,
    combinedSignal: AbortSignal | undefined,
    outerSignal: AbortSignal | undefined,
  ): AsyncIterable<StreamEvent> {
    try {
      return provider.sendMessageStream(params, combinedSignal);
    } catch (err) {
      if (outerSignal?.aborted || isAbortError(err)) {
        throw toAbortError(err);
      }
      const thrown = err;
      return (async function* (): AsyncIterable<StreamEvent> {
        throw thrown;
      })();
    }
  }

  /**
   * 从指定 fallback provider/model 拉流并做完整性校验。
   *
   * 流完整性校验：与主路径（executeWithFallback 的 hasYieldedContent 校验）对齐。
   * 背景（事故复盘 session 20260708-102143）：tryFallback 此前直接透传 fallback 流，
   * 缺了主路径那道空响应校验——fallback provider 返回 0 内容事件（如网关回 text/html
   * 错误页被 openai.ts 拦成 error，或真返回空流）时不会 throw，空流被原样透传给上层，
   * 最终以 stopReason=null 静默收尾，用户界面毫无提示。这里补齐：fallback 流也必须产出
   * 过内容/工具调用，否则 yield error 事件（error 本身即显式失败信号，放行让上层
   * stream-processor 转 throw 展示）。
   */
  private async *streamFromFallback(
    params: SendParams,
    fallbackModel: string,
    fallbackProvider: Provider,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();
    // maxTokens 钳制：切到 fallback 模型时若沿用主模型的 maxTokens，可能超过 fallback
    // 模型的物理输出上限（如主模型 deepseek 384K 降级到 glm 128K），触发网关 400
    // "max_tokens out of range"——与主模型「切模型不重算 maxTokens」是同一类 bug。
    // 用内置注册表解析 fallback 模型上限并钳制（拿不到上限的未知模型不臆测、保持原值）。
    const fallbackParams = { ...params, model: fallbackModel };
    // H4：钳制上限优先走 resolveMaxOutputTokens 回调（availableModels > 注册表，与主路径
    // resolveModelMaxOutputTokens 同源），回调缺失才回退到「只查内置注册表」。修前只查注册表，
    // fallback 目标若是注册表外的自定义模型 → fbCeiling=undefined → 不钳制 → 主模型高 maxTokens
    // 原样发给 fallback → 400 → markTerminal 拉黑 fallback 目标。
    const fbCeiling = this.config.resolveMaxOutputTokens?.(fallbackModel)
      ?? lookupRegistry(fallbackModel)?.maxOutputTokens;
    if (fbCeiling && fallbackParams.maxTokens && fallbackParams.maxTokens > fbCeiling) {
      log.info(
        "FALLBACK",
        `fallback 模型 ${fallbackModel} maxTokens ${fallbackParams.maxTokens} 超上限 ${fbCeiling}，已钳制`,
      );
      fallbackParams.maxTokens = fbCeiling;
    }
    let fbYieldedContent = false;
    let fbYieldedError = false;
    for await (const event of fallbackProvider.sendMessageStream(fallbackParams, signal)) {
      // A4 纵深防御：fallback provider 流消费中检查 signal
      if (signal?.aborted) {
        throw new RequestAbortedError("请求已中止");
      }
      if (event.type === "content_block_delta") {
        fbYieldedContent = true;
      } else if (event.type === "error") {
        // fallback 流内已有显式 error（含 openai.ts 的 Content-Type 守卫）→ 透传，
        // 由上层 stream-processor 转 throw 展示；不再叠加"响应为空"掩盖真实原因。
        fbYieldedError = true;
      }
      yield event;
    }
    // fallback 流跑完却既无内容事件、也无显式 error → 判定空响应（伪装成功的空流）。
    if (!fbYieldedContent && !fbYieldedError) {
      log.error("FALLBACK", `fallback 模型 ${fallbackModel} 返回空响应（0 内容事件），判定失败`);
      yield {
        type: "error",
        error: {
          message: `fallback 模型 ${fallbackModel} 返回空响应（0 内容事件），疑似模型不可用或网关返回非流式错误页`,
          type: "empty_response",
          streamLevel: true,
        },
      };
      return;
    }
    // N2（H2 加剧因素修复）：降级流确实产出内容后，标记 fallbackModel 健康，清除其可能残留的
    // terminal 拉黑态。背景：主路径成功时会 markHealthy(params.model)（fallback.ts 阶段2 末尾），
    // 但降级路径此前无此调用——若 fallbackModel 曾被 markTerminal（如主备双模型走同一网关、网关
    // 整体故障双双 terminal），即便本次 streamFromFallback(T) 成功，T 的 availability 仍停在
    // terminal → 下一轮 isAvailable(T)=false 又 tryFallback。仅在确有内容产出时清除，空响应/纯
    // error 不清（那本就是失败信号）。
    if (fbYieldedContent) {
      // force=true：降级流确实产出内容是明确正向信号，强制清除 fallbackModel 可能残留的
      // terminal 态（否则被拉黑的模型即便成功也永远停在 terminal，下轮又被拦）。
      this.availability.markHealthy(fallbackModel, true);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 退避延迟计算（对标 retry-engine 的 getRetryDelay）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 计算重试延迟。
   * 优先级：服务端 Retry-After > rate-limit-reset > 指数退避 + 25% jitter
   */
  private calculateRetryDelay(
    err: unknown,
    attempt: number,
    classified: TerminalError | RetryableError | Error,
    maxDelayMs: number,
  ): number {
    // 实现已抽到 retry-backoff.ts，与子代理路径（agentic-loop.ts）共用同一份。
    // 此前只存在于本类内部 → 子代理走 provider 直连时完全无退避可用（事故
    // 20260730-183103-5e334145：一次 429 即失败）。
    return calculateSharedRetryDelay(err, attempt, classified, {
      maxDelayMs,
      retryBackoffBaseMs: this.config.retryBackoffBaseMs,
      retryBackoffMaxMs: this.config.retryBackoffMaxMs,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // max_tokens 溢出自动恢复
  // ═══════════════════════════════════════════════════════════════

  /**
   * 尝试从错误消息中恢复 max_tokens 溢出。
   * 返回调整后的 maxTokens，或 null（无法恢复）。
   *
   * @param errorMessage 错误消息
   * @param thinkingBudget thinking 预算 token 数（Extended Thinking 场景，需从可用空间中扣除）
   */
  private tryRecoverMaxTokens(
    errorMessage: string,
    model: string,
    thinkingBudget?: number,
  ): number | null {
    // H1：优先用 resolveContextLimit 回调按当前模型实时解析（主模型可切换），
    // 回调缺失或返回空时回退到静态 contextLimit。修前构造从不注入 contextLimit →
    // this.config.contextLimit 恒 undefined → 恒 return null，整套溢出恢复是死代码。
    const contextLimit = this.config.resolveContextLimit?.(model) ?? this.config.contextLimit;
    if (!contextLimit) return null;

    // 匹配: "188059 + 20000 > 200000"
    const sumMatch = errorMessage.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
    if (sumMatch) {
      const inputTokens = parseInt(sumMatch[1], 10);
      return this.computeSafeMaxTokens(inputTokens, contextLimit, thinkingBudget);
    }

    // 匹配: "prompt is too long: 137500 tokens > 135000 maximum"
    const tokenMatch = errorMessage.match(/(\d+)\s*tokens?\s*>\s*(\d+)/i);
    if (tokenMatch) {
      const inputTokens = parseInt(tokenMatch[1], 10);
      return this.computeSafeMaxTokens(inputTokens, contextLimit, thinkingBudget);
    }

    return null;
  }

  /**
   * 计算安全的 maxTokens 值。
   *
   * 对标 claude-code 的 thinking budget 感知：当 Extended Thinking 启用时，
   * thinking 消耗的 token 不计入 output，但仍占用上下文窗口，需要从可用空间中扣除。
   */
  private computeSafeMaxTokens(
    inputTokens: number,
    contextLimit: number,
    thinkingBudget?: number,
  ): number | null {
    const thinkingCost = thinkingBudget ?? 0;
    const available = Math.max(0, contextLimit - inputTokens - thinkingCost - SAFETY_BUFFER);
    const floor = resolveFloorOutputTokens(contextLimit);
    if (available < floor) return null;
    return Math.max(floor, available);
  }

  // ═══════════════════════════════════════════════════════════════
  // Telemetry 埋点
  // ═══════════════════════════════════════════════════════════════

  private emitTelemetry(event: RetryTelemetryEvent): void {
    if (this.config.onTelemetry) {
      try {
        this.config.onTelemetry(event);
      } catch {
        // telemetry 不应影响主流程
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════════════

  /** 异步睡眠 */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new RequestAbortedError("Request aborted"));
    }

    // 防御性检查：某些环境（如 Bun）中 AbortSignal 可能不支持 addEventListener
    const hasListener = signal && typeof (signal as any).addEventListener === "function";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (hasListener) signal!.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        if (hasListener) signal!.removeEventListener("abort", onAbort);
        reject(new RequestAbortedError("Request aborted"));
      };

      if (hasListener) {
        signal!.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * 带进度报告的异步睡眠。
   *
   * 对标 claude-code 的 withRetry() 中 yield SystemAPIErrorMessage 到 UI 层：
   * - 短延迟（< 15s）：yield 一次进度消息后 sleep
   * - 长延迟（≥ 15s）：拆分为 10s 心跳块，每块 yield 剩余时间
   * 让 TUI 在重试等待期间能向用户展示"正在重试…"等反馈。
   */
  private async *sleepWithProgress(
    delayMs: number,
    attempt: number,
    maxRetries: number,
    category: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // 短延迟：单次 sleep + yield 一条进度消息
    if (delayMs < 15_000) {
      yield {
        type: "system_api_error",
        content: `正在重试 (${attempt}/${maxRetries})…`,
        delayMs,
        attempt,
        maxRetries,
        category,
      };
      await this.sleep(delayMs, signal);
      return;
    }

    // 长延迟（persistent retry 等）：拆分为心跳块
    const heartbeatMs = 10_000;
    let remaining = delayMs;
    let chunkIndex = 0;

    while (remaining > 0) {
      const chunk = Math.min(heartbeatMs, remaining);
      await this.sleep(chunk, signal);
      remaining -= chunk;
      chunkIndex++;

      if (remaining > 0) {
        yield {
          type: "system_api_error",
          content: `等待中… 剩余 ${Math.ceil(remaining / 1000)}s (${attempt}/${maxRetries})`,
          delayMs: remaining,
          attempt,
          maxRetries,
          category,
        };
      }
    }
  }

  /** 检查最近一次调用是否发生了模型降级（上报位，非控制位）。
   *  消费方：`loop.ts:2643` —— 降级发生时 yield tombstone 撤回已推给 UI 的半截
   *  assistant 消息。控制流判据在 per-call 的 `RetryContext.hasFallenBack`。 */
  checkFallbackOccurred(): boolean {
    return this.lastCallFellBack;
  }

  /** 清除降级上报位。
   *
   *  B1-a 说明：方案原文要求删除本方法，理由是「reset() 的存在本身就是状态共享的
   *  证据」。该论断对**控制态**成立（已搬进 per-call，见 RetryContext.hasFallenBack），
   *  但本方法在搬迁后语义已变 —— 它清的是**上报位**，且有真实消费者：
   *  `loop.ts:2648` 在 yield tombstone 之后调 `resetFallbackFlag()` 把信号消费掉，
   *  否则同一轮后续检查会重复 yield tombstone。故保留，不再删除。 */
  reset(): void {
    this.lastCallFellBack = false;
  }
}
