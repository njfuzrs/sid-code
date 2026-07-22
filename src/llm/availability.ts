/**
 * 模型可用性服务
 * 三态健康管理（healthy/retry_once/terminal），避免反复请求已知不可用的模型
 */

/** 模型健康状态 */
type HealthState =
  | { status: "healthy" }
  | { status: "retry_once"; reason: string; consumed: boolean }  // 本轮只允许重试一次
  | { status: "terminal"; reason: string };                       // 永久不可用

export class ModelAvailabilityService {
  private states = new Map<string, HealthState>();

  /** 标记模型为永久不可用（认证失败、模型不存在） */
  markTerminal(model: string, reason: string): void {
    this.states.set(model, { status: "terminal", reason });
  }

  /** 标记模型为"本轮重试一次"（限流、过载） */
  markRetryOnce(model: string, reason: string): void {
    const current = this.states.get(model);
    // terminal 状态不会被降级覆盖
    if (current?.status === "terminal") return;
    this.states.set(model, { status: "retry_once", reason, consumed: false });
  }

  /**
   * 标记模型恢复健康。
   *
   * @param force 是否强制清除 terminal 态（默认 false）。
   *   - false（默认）：保持旧语义，terminal 不可被自动流程恢复（避免一次瞬时成功就抹掉
   *     "模型不存在/认证失败"这类硬故障判定）。
   *   - true：强制清除，用于「用户显式切入该模型」「降级流确实产出内容」等携带明确正向信号的
   *     场景。H2 死锁根治：terminal 是进程内永久态，而 terminal 模型开头 isAvailable 就被拦、
   *     永远走不到主路径的 markHealthy 清除点 → 结构性死锁；用户 /model 切回被拉黑的模型也用不了。
   *     给用户主动选择 / 成功产出一次干净机会，清除 terminal。
   */
  markHealthy(model: string, force = false): void {
    const current = this.states.get(model);
    // terminal 状态默认不可恢复；仅在 force（用户显式切入 / 成功产出）时强制清除。
    if (current?.status === "terminal" && !force) return;
    this.states.delete(model);
  }

  /** 查询模型是否处于 terminal（永久不可用）态。供切模型选项置灰/标注用（H2）。 */
  isTerminal(model: string): boolean {
    return this.states.get(model)?.status === "terminal";
  }

  /** 检查模型是否可用（消耗 retry_once 的一次机会） */
  isAvailable(model: string): { available: boolean; reason?: string } {
    const state = this.states.get(model);
    if (!state || state.status === "healthy") {
      return { available: true };
    }
    if (state.status === "terminal") {
      return { available: false, reason: state.reason };
    }
    // retry_once：第一次允许，第二次拒绝
    if (!state.consumed) {
      state.consumed = true;
      return { available: true };
    }
    return { available: false, reason: state.reason };
  }

  /** 新一轮对话开始时重置 retry_once 的 consumed 标记 */
  resetTurn(): void {
    for (const state of this.states.values()) {
      if (state.status === "retry_once") {
        state.consumed = false;
      }
    }
  }

  /** 从候选模型列表中选择第一个可用的 */
  selectFirstAvailable(models: string[]): { model: string } | { unavailable: true; reason: string } {
    for (const model of models) {
      const check = this.isAvailable(model);
      if (check.available) return { model };
    }
    return { unavailable: true, reason: "所有候选模型均不可用" };
  }
}
