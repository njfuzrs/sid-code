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

  /** 标记模型恢复健康 */
  markHealthy(model: string): void {
    const current = this.states.get(model);
    // terminal 状态不可恢复
    if (current?.status === "terminal") return;
    this.states.delete(model);
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
    for (const [model, state] of this.states) {
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
