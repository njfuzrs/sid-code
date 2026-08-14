/**
 * 韧性流入口（B2）—— 所有非主循环路径进入唯一漏斗的收口点。
 *
 * 背景（事故 20260730-183103-5e334145）：`agentic-loop.ts` / `forked-agent.ts` /
 * `headless.ts` 都是 `provider.sendMessageStream()` 直连，**完全绕过** `ModelFallback`
 * ——而重试/退避/降级/拉黑全部只存在于漏斗内部。结果：主循环遇 429 会重试到成功，
 * 子代理遇同一个 429 在 1ms 内直接失败。同一模型、同一网关，两条路径行为割裂。
 *
 * 修法不是"给子代理也补一套重试"（那是 R1 的做法，制造了第二份平行实现，
 * 两份实现必然漂移），而是**让它们走同一个漏斗**。本文件就是那个入口：
 * 调用方只需声明"我是谁"（querySource）与"我能不能弹窗"（switchMode），
 * 韧性能力由漏斗统一提供。
 *
 * ── 为什么默认每次调用构造一个 ModelFallback 实例 ──
 *
 * 看似浪费，实则是 B1 的直接收益：漏斗的**控制态已全部搬进 per-call 的
 * `RetryContext`**（`hasFallenBack` / `consecutive529` / `needsAuthRefresh` …），
 * 实例本身只剩一份不可变配置。所以：
 *   - 构造成本 ≈ 一个对象字面量，没有连接池、没有定时器、没有后台任务；
 *   - 并行子代理天然状态隔离（B4 想解决的问题在这里不存在）；
 *   - 唯一需要**跨实例共享**的是模型拉黑（availability），由调用方显式注入
 *     同一个 `ModelAvailabilityService` 来保证——共享该共享的，隔离该隔离的。
 *
 * 已有漏斗实例的路径（主循环 `engine.ts`）继续用自己的实例，传 `fallback` 复用即可。
 */

import type { Provider } from "./provider.ts";
import type { SendParams, StreamEvent } from "./types.ts";
import type { ModelAvailabilityService } from "./availability.ts";
import type { RetryTelemetryEvent } from "./retry-telemetry.ts";
import {
  ModelFallback,
  type FallbackSwitchMode,
  type PerCallOptions,
  type QuerySource,
} from "./fallback.ts";
import { resolveLoopTimeouts } from "../config/network-profile.ts";
import { LIFECYCLE_PRESETS } from "./stream-lifecycle.ts";
import { TokenEstimator } from "./token-estimator.ts";

/**
 * 非主循环路径的单次尝试流超时缺省值（P2-6）。
 *
 * 抽成导出常量 + 导出解析函数，是为了让"缺省档位取的是 overall 而不是 idle"这件事
 * 能被**直接断言**，而不是靠扫源码字符串。回归的形态是有人把它改回 idle 档，
 * 那种改动在行为上只表现为"慢首字节的子代理偶尔被杀"，没有任何断言会失败。
 */
export const DEFAULT_SIDE_STREAM_TIMEOUT_MS = LIFECYCLE_PRESETS.subAgent.overallTimeoutMs;

/**
 * 解析单次尝试的流超时。显式传入优先，否则走 {@link DEFAULT_SIDE_STREAM_TIMEOUT_MS}。
 */
export function resolveSideStreamTimeoutMs(explicit?: number): number {
  return explicit ?? DEFAULT_SIDE_STREAM_TIMEOUT_MS;
}

/** 韧性流选项 */
export interface ResilientStreamOptions {
  /** 本次调用的查询来源（必填）。决定 529 前后台闸门与遥测归因。 */
  querySource: QuerySource;
  /**
   * 降级模式。默认 `"auto"`。
   *
   * 子代理 / fork / 无头**必须** auto：`"ask"` 会调 `onFallbackDecision` 弹 TUI 选择题，
   * 而这些路径没有 TUI，只会把调用挂死在一个永远等不到答案的 Promise 上。
   * 这也是旧文档把"子代理不能降级"记为合理设计差异的由来——B1 改成 per-call 之后，
   * 它只是一个参数。
   */
  switchMode?: FallbackSwitchMode;
  /** 流式阶段重试上界。缺省走 network-profile 的 maxTimeoutRetries。 */
  maxRetries?: number;
  /** 退避基数 / 上限（毫秒）。缺省走 network-profile。 */
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  /**
   * 单次尝试的流超时（毫秒）。缺省用 subAgent overall 档（180s）。
   *
   * 语义分层（三层各司其职，不要合并）：
   *   ① 本超时 = **单次尝试的整体上限**，触发后漏斗按可重试超时**重试**；
   *   ② 调用方 processStream 的 idle/overall = **跨重试**的兜底，触发即结束本轮（不重试）；
   *   ③ 子代理 wall-clock（`sub-agent.ts` 的 timeoutCtrl，120–360s）= 总预算硬顶。
   *
   * P2-6：缺省档位曾是 `subAgent.idleTimeoutMs`（60s），与本参数在漏斗里的**真实语义
   * 不匹配**。漏斗那个定时器（`fallback.ts:669` startStreamTimeout）只在发起尝试时
   * 武装一次，此后**只在重试路径**被 reset（:1010 / :1328），**收到数据不会续期**——
   * 所以它实际是"单次尝试的整体上限"，不是 idle 上限。拿三档里最激进的 idle 值去当
   * 整体上限，等于把 60s 当成"一次尝试最多允许跑多久"，慢首字节必被误杀。
   */
  streamTimeoutMs?: number;
  /** 模型可用性服务。**应注入与主路径同一实例**，让 terminal 拉黑跨路径共享。 */
  availability?: ModelAvailabilityService;
  /** 降级目标（未提供则重试耗尽后直接产出 error 事件，等价于旧的"放弃"语义）。 */
  fallbackModel?: string;
  fallbackProvider?: Provider;
  /** 发起方标识，进遥测便于回答"哪个子代理重试了几次"。 */
  agentId?: string;
  /**
   * S3（§5 缺口 C）：wall-clock 截止时刻（`Date.now()` 轴上的毫秒时间戳）。
   *
   * 传它的路径能获得「按剩余预算钳制重试」：退避睡完还来不及发请求时**提前停手**，
   * 而不是睡满最长 120s 再被外层 `timeoutCtrl` 硬砍——后者那段等待纯属白烧，
   * 且换来的是"什么结论都没有"。
   *
   * 谁该传：外层有 wall-clock 硬顶的路径（子代理 / fork / 无头）。
   * 谁不该传：主循环——它没有总超时，用户可以一直等，钳制反而会误砍。
   */
  deadlineAt?: number;
  /** 遥测回调（重试 / 降级 / 529 丢弃 / max_tokens 调整）。 */
  onTelemetry?: (event: RetryTelemetryEvent) => void;
  /**
   * 按模型名解析上下文窗口。缺省用 `TokenEstimator`（内置注册表）。
   *
   * **必须注入或有缺省，否则 max_tokens 溢出恢复整套是死代码**——漏斗的
   * `tryRecoverMaxTokens` 首行就是 `if (!contextLimit) return null`。这正是 H1
   * 记录过的同型事故（"构造从不传 contextLimit → 恒 return null"）。B2 接线时若
   * 只管重试不管这个，等于把已修好的坑在新路径上重新挖一遍：子代理是 token 消耗
   * 大户，撞上下文上限的概率**高于**主路径。
   *
   * 调用方持有 Config 时应注入自己的解析器（`availableModels` 里用户声明的
   * contextWindow 才是权威值，内置静态表会与自建/代理部署漂移）。
   */
  resolveContextLimit?: (model: string) => number | undefined;
  /** 每次重试前回调（attempt 1-based）。供调用方清理 per-turn 观测状态。 */
  onRetry?: (attempt: number, error: string, delayMs: number) => void;
  /** 复用已有漏斗实例（主循环路径）。给了就不再构造新实例。 */
  fallback?: ModelFallback;
}

/**
 * 走漏斗发起一次流式请求。
 *
 * 返回的 AsyncGenerator 语义与 `provider.sendMessageStream()` **完全一致**
 * （同样产出 StreamEvent 序列），因此调用方替换直连时无需改动下游消费逻辑。
 * 差别只在于：重试/退避/超时/降级/拉黑在内部发生，且**重试产生的多次尝试
 * 会连续 yield 进同一个下游消费者**——这正是"失败 attempt 已产出的 token
 * 照常计入 totalUsage"能自动成立的原因（服务端对已产出 token 照常计费，
 * 只算成功那次会让账单对不上）。
 */
export function streamWithResilience(
  provider: Provider,
  params: SendParams,
  signal: AbortSignal | undefined,
  opts: ResilientStreamOptions,
): AsyncGenerator<StreamEvent> {
  const perCall: PerCallOptions = {
    querySource: opts.querySource,
    switchMode: opts.switchMode ?? "auto",
    fallbackModel: opts.fallbackModel,
    fallbackProvider: opts.fallbackProvider,
    maxRetries: opts.maxRetries,
    agentId: opts.agentId,
    deadlineAt: opts.deadlineAt,
  };

  if (opts.fallback) {
    return opts.fallback.executeWithFallback(provider, params, signal, perCall);
  }

  // 缺省：构造一次性实例（见文件头注释——B1 之后实例只剩不可变配置）。
  // 超时/退避默认值走 resolveLoopTimeouts（env > settings > 统一默认），
  // 与主路径 app.ts 注入漏斗时**同一个入口**，不再各自硬编码平行常量。
  const net = resolveLoopTimeouts({});
  const fallback = new ModelFallback(
    {
      availability: opts.availability,
      fallbackModel: opts.fallbackModel,
      fallbackProvider: opts.fallbackProvider,
      fallbackSwitchMode: perCall.switchMode,
      querySource: opts.querySource,
      maxRetries: opts.maxRetries ?? net.maxTimeoutRetries,
      maxRetriesPerCall: net.maxRetriesPerCall,
      // P2-6：档位取 overall（180s）而非 idle（60s）——见 `streamTimeoutMs` 声明处的注释，
      // 漏斗那个定时器收到数据不续期，语义是"单次尝试整体上限"，只有 overall 档对得上。
      streamTimeoutMs: resolveSideStreamTimeoutMs(opts.streamTimeoutMs),
      retryBackoffBaseMs: opts.retryBackoffBaseMs ?? net.retryBackoffBaseMs,
      retryBackoffMaxMs: opts.retryBackoffMaxMs ?? net.retryBackoffMaxMs,
      onTelemetry: opts.onTelemetry,
      // 确认项 2：接线溢出恢复所需的上下文窗口解析。缺省走 TokenEstimator 内置注册表——
      // 不完美（用户自建部署的真实窗口只有 availableModels 知道），但**远好于 undefined**：
      // undefined 会让整套恢复静默失效，而内置表至少覆盖主流模型。
      resolveContextLimit:
        opts.resolveContextLimit ??
        ((model: string) => {
          try {
            return new TokenEstimator().getContextLimit(model);
          } catch {
            return undefined;
          }
        }),
    },
    opts.onRetry ? { onRetry: opts.onRetry } : undefined,
  );

  return fallback.executeWithFallback(provider, params, signal, perCall);
}
