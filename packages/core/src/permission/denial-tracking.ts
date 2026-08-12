/**
 * Denial Tracking 熔断器
 * 防止 LLM 进入"失败重试死循环"——同一操作被连续拒绝达到阈值时触发熔断
 * 对标 Claude Code 的 auto 模式安全兜底机制
 *
 * ─── 2026-07-30 负收益防线审计 · 发现 1 重构 ───
 *
 * 旧实现在 58,130 条真实审计日志里触发 **0 次**，根因是「判据与检查点错位」：
 *   - hard deny（如 `rm -rf /`）会 recordDenial 记账，但在 checker.ts 就地 return，
 *     **走不到**熔断检查点；
 *   - ask（needsConfirmation）能走到检查点，但**完全不记账**。
 *   → 喂计数器的路走不到检查点，走到检查点的路不喂计数器，两个阈值都不可达。
 *
 * 修复不能是「直接接线」。审计给出的反事实（58,139 条 tool_use，按 30min 间隔切会话）
 * 证明旧判据一旦可达就会从 0 误报跳到数万次误报：
 *
 * | 判据 | 全量语料触发 | 剔除单测污染后 |
 * |---|---|---|
 * | 全局 consecutive≥3 或 total≥20（旧值） | 46,006 | 6,751 |
 * | 全局 total≥500 | 11,619 | — |
 * | 全局无 total 上限（仅 consecutive≥3） | 11,156 | 1,720 |
 * | **同一操作签名 consecutive≥3（新判据）** | **5** | **0** |
 * | 同一操作签名 total≥3（非连续） | 8,937 | 1,855 |
 *
 * 结论：熔断要防的是「模型对**同一个**操作反复撞墙」，而不是「本会话拒绝总数多」。
 * 后者在正常排查里天然很高（p50=12 次/会话、max=157），拿它当判据必然误报。
 * 因此新判据是**按操作签名（工具名 + 资源）的连续拒绝**，并彻底移除 `maxTotal` 阈值——
 * `totalDenials` 降级为纯观测量（/permissions 展示、审计归因），不再参与熔断决策。
 * 这样也顺带解决了旧实现「totalDenials 单调不减 → 一旦接线就变成永久闩锁」的隐患。
 */

/** 单个操作签名的拒绝计数 */
interface SignatureDenials {
  /** 该签名连续被拒次数（同签名一次 allow 即归零） */
  consecutive: number;
  /** 最近一次拒绝原因 */
  reason: string;
}

/** 拒绝追踪状态 */
export interface DenialTrackingState {
  /**
   * 连续拒绝次数——**当前签名**的连续拒绝数（换签名即重置为 1）。
   * 保留该字段名以兼容 /permissions 展示与既有 decisionReason 结构。
   */
  consecutiveDenials: number;
  /**
   * 累计拒绝次数（不归零）。**纯观测量，不参与熔断判定**（见文件头反事实表：
   * 拿累计数当阈值在真实语料里会误报上万次）。
   */
  totalDenials: number;
  /** 最近一次拒绝的工具名 */
  lastDeniedTool?: string;
  /** 最近一次拒绝的原因 */
  lastDeniedReason?: string;
  /** 最近一次拒绝的操作签名（工具名 + 资源），用于判断"是否还在撞同一面墙" */
  lastDeniedSignature?: string;
  /** 按操作签名的连续拒绝计数（熔断真正的判据来源） */
  bySignature: Record<string, SignatureDenials>;
}

/** 熔断阈值 */
export const DENIAL_LIMITS = {
  /**
   * **同一操作签名**连续被拒上限 → 触发熔断。
   * 反事实：该判据在 58,139 条真实审计上仅触发 5 次（剔除单测污染后 0 次），
   * 而旧的「全局连续 3 次」触发 11,156 次。阈值 3 在新判据下是安全的。
   */
  maxConsecutive: 3,
} as const;

/**
 * 计算操作签名：工具名 + 资源（file_path / command）。
 *
 * 熔断只应对「反复尝试同一操作」生效，故签名必须包含资源；只用工具名会把
 * "连续编辑 3 个不同文件被拒" 误判成死循环。资源缺失（如无参工具）时退化为工具名，
 * 此时同工具连续被拒才算同签名——仍比全局计数精确。
 */
export function denialSignature(tool: string, resource?: string): string {
  return `${tool}\x00${resource ?? ""}`;
}

/** 创建初始状态 */
export function createDenialTrackingState(): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
    bySignature: {},
  };
}

/** 记录一次拒绝 */
export function recordDenial(
  state: DenialTrackingState,
  tool: string,
  reason: string,
  resource?: string,
): DenialTrackingState {
  const signature = denialSignature(tool, resource);
  const prev = state.bySignature[signature]?.consecutive ?? 0;
  const consecutive = prev + 1;
  return {
    // 同签名连续计数即对外暴露的 consecutiveDenials（换签名从 1 重新开始计）
    consecutiveDenials: consecutive,
    totalDenials: state.totalDenials + 1,
    lastDeniedTool: tool,
    lastDeniedReason: reason,
    lastDeniedSignature: signature,
    bySignature: { ...state.bySignature, [signature]: { consecutive, reason } },
  };
}

/**
 * 记录一次成功（重置该签名的连续计数）。
 *
 * 只清**本签名**的连续计数：模型"换个操作成功了"不代表它已经不再撞原来那面墙，
 * 但同一个操作成功了就说明墙没了。传 tool 时按签名精确清除；不传（兼容旧调用）
 * 则清空全部签名计数，语义等价于旧 recordSuccess。
 */
export function recordSuccess(
  state: DenialTrackingState,
  tool?: string,
  resource?: string,
): DenialTrackingState {
  if (!tool) {
    return {
      ...state,
      consecutiveDenials: 0,
      lastDeniedTool: undefined,
      lastDeniedReason: undefined,
      lastDeniedSignature: undefined,
      bySignature: {},
    };
  }
  const signature = denialSignature(tool, resource);
  const bySignature = { ...state.bySignature };
  delete bySignature[signature];
  const stillBlocked =
    state.lastDeniedSignature === signature ? undefined : state.lastDeniedSignature;
  return {
    ...state,
    // 当前展示的连续数只在"清掉的正是最近被拒的那个签名"时归零
    consecutiveDenials: stillBlocked === undefined ? 0 : state.consecutiveDenials,
    lastDeniedTool: stillBlocked === undefined ? undefined : state.lastDeniedTool,
    lastDeniedReason: stillBlocked === undefined ? undefined : state.lastDeniedReason,
    lastDeniedSignature: stillBlocked,
    bySignature,
  };
}

/**
 * 是否应该触发熔断。
 *
 * 判据：**当前请求的操作签名**已连续被拒 ≥ maxConsecutive 次。
 * 必须传入当前 tool/resource——熔断是"针对这次请求"的判断，而不是全局状态查询；
 * 不传则退化为看 lastDeniedSignature（兼容既有调用点/单测）。
 */
export function shouldFuse(state: DenialTrackingState, tool?: string, resource?: string): boolean {
  const signature = tool ? denialSignature(tool, resource) : state.lastDeniedSignature;
  if (!signature) return false;
  const consecutive = state.bySignature[signature]?.consecutive ?? 0;
  return consecutive >= DENIAL_LIMITS.maxConsecutive;
}
