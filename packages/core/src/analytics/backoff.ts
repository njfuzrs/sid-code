// src/analytics/backoff.ts
// 二次退避重试——n² 增长,比指数退避在短暂抖动时恢复更快
//
// 对应 spec 17 §4.1.2。
// 8 次重试总计约 100 秒(500ms × (1+4+9+16+25+36+49) ≈ 70s,封顶 30s)。

export class QuadraticBackoff {
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private baseDelayMs: number = 500,
    private maxDelayMs: number = 30_000,
    private maxAttempts: number = 8,
  ) {}

  /** 调度一次退避重试。超过最大次数则放弃。 */
  schedule(fn: () => Promise<void>): void {
    if (this.attempts >= this.maxAttempts) {
      this.reset();
      return; // 超过最大重试次数,放弃
    }

    // 二次退避: base * attempts²(首次 attempts=0 → 0 延迟,立即重试一次)
    const delay = Math.min(this.baseDelayMs * this.attempts * this.attempts, this.maxDelayMs);
    this.attempts++;

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn()
        .then(() => this.reset())
        .catch(() => this.schedule(fn));
    }, delay);
    this.timer.unref?.(); // 不阻止进程退出
  }

  /** 当前重试次数(测试用) */
  get attemptCount(): number {
    return this.attempts;
  }

  /** 计算下一次延迟(不调度,测试用) */
  peekDelay(): number {
    return Math.min(this.baseDelayMs * this.attempts * this.attempts, this.maxDelayMs);
  }

  /** 重置退避状态(成功后调用) */
  reset(): void {
    this.attempts = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
