/**
 * Denial Tracking 熔断器
 * 防止 LLM 进入"失败重试死循环"——连续拒绝达到阈值时触发熔断
 * 对标 Claude Code 的 auto 模式安全兜底机制
 */

/** 拒绝追踪状态 */
export interface DenialTrackingState {
  /** 连续拒绝次数（每次 allow 归零） */
  consecutiveDenials: number;
  /** 累计拒绝次数（不归零） */
  totalDenials: number;
  /** 最近一次拒绝的工具名 */
  lastDeniedTool?: string;
  /** 最近一次拒绝的原因 */
  lastDeniedReason?: string;
}

/** 熔断阈值 */
export const DENIAL_LIMITS = {
  /** 连续拒绝上限 → 触发熔断 */
  maxConsecutive: 3,
  /** 累计拒绝上限 → 触发熔断 */
  maxTotal: 20,
} as const;

/** 创建初始状态 */
export function createDenialTrackingState(): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
  };
}

/** 记录一次拒绝 */
export function recordDenial(
  state: DenialTrackingState,
  tool: string,
  reason: string,
): DenialTrackingState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
    lastDeniedTool: tool,
    lastDeniedReason: reason,
  };
}

/** 记录一次成功（重置连续计数） */
export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: 0,
    lastDeniedTool: undefined,
    lastDeniedReason: undefined,
  };
}

/** 是否应该触发熔断 */
export function shouldFuse(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  );
}
