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
import {
  classifyError,
  TerminalError,
  RetryableError,
  StreamValidationError,
  isAbortError,
  toAbortError,
  RequestAbortedError,
  getNetworkErrorCode,
  parseXShouldRetry,
  parseRetryAfterFromHeaders,
  parseRateLimitReset,
  is401Error,
  is408Error,
  is409Error,
} from "./errors.ts";
import { ModelAvailabilityService } from "./availability.ts";
import type { RetryTelemetryEvent } from "./retry-telemetry.ts";

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

/** 连接阶段重试配置 */
const CONNECTION_RETRY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/** 流式阶段重试配置 */
const STREAM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
};

/** 默认流超时（毫秒） */
const DEFAULT_STREAM_TIMEOUT_MS = 300_000; // 5 分钟

/** 退避延迟上限 */
const MAX_DELAY_MS = 32_000;

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

/** persistent retry heartbeat 间隔（30 秒） */
const PERSISTENT_HEARTBEAT_MS = 30_000;

// ═══════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════

/** 回退配置 */
export interface FallbackConfig {
  /** 降级 Provider */
  fallbackProvider?: Provider;
  /** 降级模型 */
  fallbackModel?: string;
  /** 模型可用性服务 */
  availability?: ModelAvailabilityService;
  /** 查询来源（前台/后台），影响 529 重试策略 */
  querySource?: QuerySource;
  /** 最大重试次数（默认由各阶段配置决定） */
  maxRetries?: number;
  /** 流式整体超时（毫秒，默认 5 分钟） */
  streamTimeoutMs?: number;
  /** 上下文窗口大小（用于 max_tokens 溢出恢复） */
  contextLimit?: number;
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

/** 内部重试上下文 */
interface RetryContext {
  /** 是否需要刷新认证（401 后置位） */
  needsAuthRefresh: boolean;
  /** 是否需要禁用 keep-alive（ECONNRESET 后置位） */
  disableKeepAlive: boolean;
  /** 连续 529 计数 */
  consecutive529: number;
  /** max_tokens 溢出恢复时的覆盖值 */
  maxTokensOverride?: number;
}

// ═══════════════════════════════════════════════════════════════════
// ModelFallback — 核心引擎
// ═══════════════════════════════════════════════════════════════════

export class ModelFallback {
  private config: FallbackConfig;
  private listener: FallbackListener | null;
  private hasFallenBack = false;
  private availability: ModelAvailabilityService;

  constructor(config: Partial<FallbackConfig> = {}, listener?: FallbackListener) {
    this.config = {
      fallbackProvider: config.fallbackProvider,
      fallbackModel: config.fallbackModel,
      availability: config.availability,
      querySource: config.querySource,
      maxRetries: config.maxRetries,
      streamTimeoutMs: config.streamTimeoutMs,
      contextLimit: config.contextLimit,
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
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

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

    const startStreamTimeout = () => {
      streamTimeoutId = setTimeout(() => {
        log.warn("FALLBACK", `流式整体超时: ${streamTimeoutMs / 1000}s，主动中断连接`);
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
    };

    // ═══════════════════════════════════════════════════════════════
    // 阶段 1：连接（获取流对象）
    // ═══════════════════════════════════════════════════════════════
    let stream: AsyncIterable<StreamEvent> | null = null;

    const connMaxRetries = this.config.maxRetries ?? CONNECTION_RETRY.maxRetries;
    for (let attempt = 0; attempt <= connMaxRetries; attempt++) {
      try {
        log.debug("FALLBACK", `连接阶段尝试 ${attempt + 1}/${connMaxRetries + 1}`);

        // 应用 max_tokens 覆盖（溢出恢复时）
        const effectiveParams = ctx.maxTokensOverride
          ? { ...params, maxTokens: ctx.maxTokensOverride }
          : params;

        stream = primaryProvider.sendMessageStream(effectiveParams, makeCombinedSignal());
        ctx.consecutive529 = 0; // 连接成功，重置 529 计数
        break;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          throw toAbortError(err);
        }

        // ── 401 认证错误：标记刷新 + 重试一次 ──
        if (is401Error(err) && !ctx.needsAuthRefresh) {
          log.info("FALLBACK", "401 认证错误，标记刷新标志并重试");
          ctx.needsAuthRefresh = true;
          this.emitTelemetry({ type: "auth_refresh", model: params.model, error: String(err) });
          // 不退避，直接重试
          continue;
        }

        // ── ECONNRESET / EPIPE：禁用 keep-alive ──
        const code = getNetworkErrorCode(err);
        if ((code === "ECONNRESET" || code === "EPIPE") && !ctx.disableKeepAlive) {
          log.info("FALLBACK", `${code} 检测到，禁用 keep-alive 连接池`);
          ctx.disableKeepAlive = true;
          this.config.disableKeepAlive = true;
        }

        const classified = classifyError(err);

        // ── 终端错误：直接 fallback ──
        if (classified instanceof TerminalError) {
          this.availability.markTerminal(params.model, classified.reason);
          log.error("FALLBACK", `终端错误: ${classified.reason}`);
          yield* this.tryFallback(params, signal);
          return;
        }

        // ── 529 连续计数 ──
        if (classified instanceof RetryableError && classified.reason === "overloaded") {
          ctx.consecutive529++;
        }

        if (attempt >= connMaxRetries) {
          log.warn("FALLBACK", `连接阶段重试 ${connMaxRetries} 次后仍失败`);
          this.availability.markRetryOnce(params.model, "连接失败");
          break;
        }

        // ── 可重试：计算延迟 ──
        const delayMs = this.calculateRetryDelay(err, attempt, classified, CONNECTION_RETRY.maxDelayMs);

        log.info("FALLBACK", `连接重试 ${attempt + 1}，延迟 ${delayMs}ms`);
        this.listener?.onRetry?.(attempt + 1, classified.message, delayMs);
        this.emitTelemetry({
          type: "retry",
          model: params.model,
          attempt: attempt + 1,
          delayMs,
          error: classified.message,
          phase: "connection",
        });

        yield* this.sleepWithProgress(
          delayMs,
          attempt + 1,
          connMaxRetries + 1,
          "retry",
          signal,
        );
      }
    }

    if (!stream) {
      yield* this.tryFallback(params, signal);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // 阶段 2：流式消费
    // ═══════════════════════════════════════════════════════════════
    let hasYieldedContent = false;
    const streamMaxRetries = this.config.maxRetries ?? STREAM_RETRY.maxRetries;

    try {
      for (let attempt = 0; attempt <= streamMaxRetries; attempt++) {
        try {
          log.debug("FALLBACK", `流式阶段尝试 ${attempt + 1}/${streamMaxRetries + 1}`);

          for await (const event of stream) {
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

              const classified = classifyError(new Error(event.error.message));

              if (classified instanceof TerminalError) {
                this.availability.markTerminal(params.model, classified.reason);
                log.error("FALLBACK", `流式终端错误: ${classified.reason}`);
                yield* this.tryFallback(params, signal);
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
                !shouldRetry529(this.config.querySource)
              ) {
                log.info("FALLBACK", `后台查询遇 529，立即放弃`);
                this.listener?.on529Dropped?.(this.config.querySource ?? "unknown");
                this.emitTelemetry({
                  type: "529_dropped",
                  model: params.model,
                  querySource: this.config.querySource ?? "unknown",
                });
                yield* this.tryFallback(params, signal);
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
                  fallbackModel: this.config.fallbackModel,
                  error: "连续 529 错误",
                });
                yield* this.tryFallback(params, signal);
                return;
              }

              if (classified instanceof RetryableError && attempt < streamMaxRetries) {
                log.warn("FALLBACK", `流式错误，准备重试: ${event.error.message}`);
                throw classified;
              }

              yield* this.tryFallback(params, signal);
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
          if (isAbortError(err) && !isTimeoutAbort) {
            throw toAbortError(err);
          }

          const classified = isTimeoutAbort
            ? new RetryableError(`流式整体超时（${streamTimeoutMs / 1000}s 无数据）`, "timeout")
            : classifyError(err);

          if (classified instanceof TerminalError) {
            this.availability.markTerminal(params.model, classified.reason);
            log.error("FALLBACK", `终端错误: ${classified.reason}`);
            yield* this.tryFallback(params, signal);
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

          // 流式重试：重新发起完整请求
          const delayMs = this.calculateRetryDelay(err, attempt, classified, STREAM_RETRY.maxDelayMs);

          log.info("FALLBACK", `流式重试 ${attempt + 1}，延迟 ${delayMs}ms`);
          this.listener?.onRetry?.(attempt + 1, classified.message, delayMs);
          this.emitTelemetry({
            type: "retry",
            model: params.model,
            attempt: attempt + 1,
            delayMs,
            error: classified.message,
            phase: "stream",
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
          try {
            const effectiveParams = ctx.maxTokensOverride
              ? { ...params, maxTokens: ctx.maxTokensOverride }
              : params;
            stream = primaryProvider.sendMessageStream(effectiveParams, makeCombinedSignal());
            // 清空内容标志（新流需要重新检测）
            hasYieldedContent = false;
          } catch (reconnectErr) {
            if (signal?.aborted || isAbortError(reconnectErr)) {
              throw toAbortError(reconnectErr);
            }
            log.error("FALLBACK", `重连失败: ${reconnectErr}`);

            if (this.config.persistent) {
              log.info("FALLBACK", "persistent 模式，重连失败后继续等待");
              yield* this.sleepWithProgress(
                PERSISTENT_HEARTBEAT_MS,
                attempt + 1,
                streamMaxRetries + 1,
                "persistent_retry",
                signal,
              );
              attempt = -1;
              continue;
            }

            break;
          }
        }
      }
    } finally {
      if (streamTimeoutId !== null) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = null;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 阶段 3：Fallback Provider
    // ═══════════════════════════════════════════════════════════════
    yield* this.tryFallback(params, signal);
  }

  /** 尝试使用 fallback Provider */
  private async *tryFallback(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    if (this.config.fallbackProvider && this.config.fallbackModel && !this.hasFallenBack) {
      this.hasFallenBack = true;
      const fallbackModel = this.config.fallbackModel;

      log.warn("FALLBACK", `切换到 fallback 模型: ${fallbackModel}`);
      this.listener?.onFallback?.("主模型失败", fallbackModel);
      this.emitTelemetry({
        type: "fallback",
        model: params.model,
        fallbackModel,
        error: "主模型失败",
      });

      const fallbackParams = { ...params, model: fallbackModel };
      for await (const event of this.config.fallbackProvider.sendMessageStream(fallbackParams, signal)) {
        yield event;
      }
      return;
    }

    // 没有 fallback 或已经用过 fallback
    log.error("FALLBACK", "主 Provider 失败且无可用 fallback");
    yield {
      type: "error",
      error: { message: "模型请求失败，已达最大重试次数且无可用 fallback" },
    };
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
    // 1. 服务端明确指定的 Retry-After（headers 优先）
    const retryAfterMs = parseRetryAfterFromHeaders(err);
    if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_DELAY_MS);

    // 2. RetryableError 携带的 retryAfterMs
    if (classified instanceof RetryableError && classified.retryAfterMs && classified.retryAfterMs > 0) {
      return Math.min(classified.retryAfterMs, MAX_DELAY_MS);
    }

    // 3. rate-limit-reset header：计算等待到 reset 时刻的延迟
    const resetTime = parseRateLimitReset(err);
    if (resetTime) {
      const waitMs = Math.max(0, resetTime - Date.now());
      if (waitMs > 0 && waitMs <= MAX_DELAY_MS) return waitMs;
    }

    // 4. 指数退避 + 25% jitter
    const isRateLimit = classified instanceof RetryableError && classified.reason === "rate_limit";
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), maxDelayMs);

    if (isRateLimit) {
      // 限流错误：+20% 正向抖动（尊重服务器最小延迟）
      const jitter = baseDelay * 0.2 * Math.random();
      return Math.round(baseDelay + jitter);
    }

    // 其他错误：±30% 双向抖动（避免惊群效应）
    const jitter = baseDelay * 0.3;
    return Math.round(baseDelay + Math.random() * jitter * 2 - jitter);
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
  private tryRecoverMaxTokens(errorMessage: string, thinkingBudget?: number): number | null {
    const contextLimit = this.config.contextLimit;
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

  /** 检查是否发生了模型降级 */
  checkFallbackOccurred(): boolean {
    return this.hasFallenBack;
  }

  /** 重置回退状态（用于新的请求） */
  reset(): void {
    this.hasFallenBack = false;
  }
}
