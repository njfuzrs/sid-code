/**
 * autoCompact 熔断器
 *
 * 连续 N 次 autoCompact 失败时触发熔断，停止浪费 API 调用。
 * 熔断后降级为简单截断策略。
 * 一段时间后自动恢复（半开状态）。
 */

import { getLogger } from "../debug/index.ts";

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
        log.debug("CIRCUIT_BREAKER", `熔断中，剩余 ${Math.ceil((this.options.recoveryTimeMs - elapsed) / 1000)}s`);
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
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  /** 记录失败 */
  recordFailure(): void {
    const log = getLogger();
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      log.warn("CIRCUIT_BREAKER", "半开状态执行失败，重新熔断");
      this.state = "open";
      return;
    }

    if (this.consecutiveFailures >= this.options.failureThreshold) {
      log.warn("CIRCUIT_BREAKER", `连续 ${this.consecutiveFailures} 次失败，触发熔断`);
      this.state = "open";
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
