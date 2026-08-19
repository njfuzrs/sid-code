/**
 * autoCompact 熔断器
 *
 * 连续 N 次 autoCompact 失败时触发熔断，停止浪费 API 调用。
 * 熔断后降级为简单截断策略。
 * 一段时间后自动恢复（半开状态）。
 */

import { getLogger } from "../debug/index.ts";
import { recordDefenseTrigger } from "../telemetry/metrics/defense-metrics.ts";

/** 熔断器状态 */
export type CircuitState = "closed" | "open" | "half-open";

/** 熔断器配置 */
export interface CircuitBreakerOptions {
  /** 连续失败次数阈值（默认 3） */
  failureThreshold?: number;
  /** 熔断恢复时间（毫秒，默认 5 分钟） */
  recoveryTimeMs?: number;
}

const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  failureThreshold: 3,
  recoveryTimeMs: 5 * 60 * 1000, // 5 分钟
};

export class AutoCompactCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private options: Required<CircuitBreakerOptions>;

  constructor(options?: CircuitBreakerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 检查是否允许执行 autoCompact
   * - closed: 允许
   * - open: 检查是否到了恢复时间，是则转为 half-open 允许一次
   * - half-open: 允许（试探性执行）
   */
  canExecute(): boolean {
    const log = getLogger();

    switch (this.state) {
      case "closed":
        return true;

      case "open": {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.options.recoveryTimeMs) {
          log.info("CIRCUIT_BREAKER", "熔断恢复时间到，转为半开状态");
          this.state = "half-open";
          return true;
        }
        log.debug(
          "CIRCUIT_BREAKER",
          `熔断中，剩余 ${Math.ceil((this.options.recoveryTimeMs - elapsed) / 1000)}s`,
        );
        return false;
      }

      case "half-open":
        return true;
    }
  }

  /** 记录成功 */
  recordSuccess(): void {
    const log = getLogger();
    if (this.state === "half-open") {
      log.info("CIRCUIT_BREAKER", "半开状态执行成功，恢复为关闭状态");
      // 只在 half-open→closed 这条边上记 recovered：closed→closed 是绝大多数调用，
      // 每次都记等于把一个"防线状态变化"指标变成"总调用量"指标。
      recordDefenseTrigger("compact_breaker", "recovered", {
        count: this.consecutiveFailures,
        threshold: this.options.failureThreshold,
      });
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  /** 记录失败 */
  recordFailure(): void {
    const log = getLogger();
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    // 两条进入 open 的路径各记一次、且互斥（half-open 分支直接 return）。
    // reason 区分它们：探针失败与连续失败达阈值是两种不同的健康状况，
    // 前者说明"服务还没恢复"，后者说明"刚开始坏"。
    if (this.state === "half-open") {
      log.warn("CIRCUIT_BREAKER", "半开状态执行失败，重新熔断");
      this.state = "open";
      recordDefenseTrigger("compact_breaker", "tripped", {
        reason: "half_open_probe_failed",
        count: this.consecutiveFailures,
        threshold: this.options.failureThreshold,
      });
      return;
    }

    if (this.consecutiveFailures >= this.options.failureThreshold) {
      log.warn("CIRCUIT_BREAKER", `连续 ${this.consecutiveFailures} 次失败，触发熔断`);
      // ⚠️ 只在**状态真的发生变化**（closed → open）时记 metric。
      // 已经 open 之后继续失败仍会走到这里（阈值条件恒成立），无条件记就会把
      // "熔断触发了几次"退化成"失败了几次"——两个不同的问题，混在一个指标里
      // 谁也答不了。判据取 `state !== "open"`，与日志刻意不同步：
      // 日志每次都打是对的（排查要看到每次失败），指标不是。
      const wasOpen = this.state === "open";
      this.state = "open";
      if (!wasOpen) {
        recordDefenseTrigger("compact_breaker", "tripped", {
          reason: "consecutive_failures",
          count: this.consecutiveFailures,
          threshold: this.options.failureThreshold,
        });
      }
    }
  }

  /** 获取当前状态 */
  getState(): CircuitState {
    return this.state;
  }

  /** 获取连续失败次数 */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /** 重置熔断器 */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}
