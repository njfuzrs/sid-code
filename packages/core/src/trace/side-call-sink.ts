/**
 * 辅助 LLM 调用（影子调用）用量收集器 — 全局单例。
 *
 * 设计目标：让不经过主循环 BeforeModel/AfterModel 的 LLM 调用（标题生成/记忆召回/
 * 权限分类/摘要压缩/缓存预热/目标评估等）也能被统计到 session.traj 中。
 *
 * 使用方式：
 *   1. 影子调用完成后调用 recordSideCall({ label, model, usage, durationMs })
 *   2. TraceCollector 在 handleAfterModel / handleSessionEnd 时调用 getSideStats() 读取累加值
 *   3. 重置：SessionStart 时调用 reset()
 *
 * 不走 Hook 事件系统的原因：影子调用点（recall.ts / bash-classifier.ts 等）不持有
 * hookSystem / sessionState，传参改面太大。全局 sink 是最轻量的接入方式。
 */

export interface SideCallRecord {
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  costUSD: number;
  /** T13.2：调用是否成功（默认 true，向后兼容） */
  success: boolean;
  /** T13.2：失败原因 */
  error?: string;
  /** T13.2：是否超时 */
  timedOut?: boolean;
}

export interface SideCallStats {
  apiCalls: number;
  costUSD: number;
  tokensSent: number;
  tokensReceived: number;
  details: Array<{
    label: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
  /** T13.4：失败统计 */
  failed: number;
  timedOut: number;
  byLabel: Record<string, { success: number; failed: number }>;
}

let _calls: SideCallRecord[] = [];
let _costCalculator: ((model: string, usage: any) => number) | null = null;
let _costObserver: ((costUSD: number) => void) | null = null;
let _statsObserver: (() => void) | null = null;

/**
 * 注册成本计算函数（由 app.ts 在启动时注入，复用 SessionState.calculateCost）。
 * 不注册时 costUSD 按 0 计（降级而非崩溃）。
 */
export function setSideCostCalculator(fn: (model: string, usage: any) => number): void {
  _costCalculator = fn;
}

/**
 * 注册成本观察者（由 app.ts 在启动时注入，回调 SessionState.addSideCost）。
 * 使辅助调用花费实时反映到 TUI 费用列 / /cost 命令 / quota 守卫。
 */
export function setSideCostObserver(fn: (costUSD: number) => void): void {
  _costObserver = fn;
}

/**
 * 注册用量变化观察者（由 TraceCollector 在启动时注入）：每次 recordSideCall 后触发，
 * 不携带具体记录——观察者自行调用 getSideStats() 取最新累计快照。
 *
 * 背景：此前 side-call 统计只在 SessionEnd 时被读入 trajectory metadata（见 collector.ts
 * handleSessionEnd）。若会话未走到 SessionEnd（崩溃/被杀/挂起——例如标题生成这类
 * fire-and-forget 调用可能在最后一轮之后才完成），累计的 token/费用/命中率会从
 * trajectory 中永久丢失，即便 provider 已经计费。注册此观察者后，TraceCollector 能在
 * 每次辅助调用落定的瞬间就把最新汇总同步进 metadata 并重建 session.traj，
 * 不必等待（可能永远不会到来的）SessionEnd。
 */
export function setSideStatsObserver(fn: () => void): void {
  _statsObserver = fn;
}

/**
 * 记录一次辅助 LLM 调用的用量。影子调用点在收到响应后调用。
 * T13.2：扩展支持 success/error/timedOut 字段记录失败调用。
 */
export function recordSideCall(
  record: Omit<SideCallRecord, "costUSD" | "success"> & {
    costUSD?: number;
    success?: boolean;
    error?: string;
    timedOut?: boolean;
  },
): void {
  const cost =
    record.costUSD ??
    (_costCalculator
      ? _costCalculator(record.model, {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadInputTokens: record.cacheReadTokens,
          cacheCreationInputTokens: record.cacheCreationTokens,
        })
      : 0);
  _calls.push({ ...record, costUSD: cost, success: record.success ?? true });
  // 实时通知观察者（SessionState.addSideCost），使展示层和 quota 守卫看到真实总花费
  if (_costObserver && cost > 0) {
    try {
      _costObserver(cost);
    } catch {
      /* 观察者异常不影响记录 */
    }
  }
  // 实时通知统计观察者（TraceCollector），使 trajectory 不必等 SessionEnd 才落盘本次用量
  if (_statsObserver) {
    try {
      _statsObserver();
    } catch {
      /* 观察者异常不影响记录 */
    }
  }
}

/**
 * 获取累计统计。TraceCollector 在 handleAfterModel / handleSessionEnd 时调用。
 */
export function getSideStats(): SideCallStats {
  let costUSD = 0;
  let tokensSent = 0;
  let tokensReceived = 0;
  let failed = 0;
  let timedOut = 0;
  const byLabel: Record<string, { success: number; failed: number }> = {};
  const details: SideCallStats["details"] = [];

  for (const c of _calls) {
    costUSD += c.costUSD;
    tokensSent += c.inputTokens;
    tokensReceived += c.outputTokens;
    details.push({
      label: c.label,
      model: c.model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      costUSD: c.costUSD,
    });
    // T13.4：累计失败统计
    if (!c.success) {
      failed++;
      if (c.timedOut) timedOut++;
    }
    if (!byLabel[c.label]) byLabel[c.label] = { success: 0, failed: 0 };
    if (c.success) byLabel[c.label].success++;
    else byLabel[c.label].failed++;
  }

  return {
    apiCalls: _calls.length,
    costUSD,
    tokensSent,
    tokensReceived,
    details,
    failed,
    timedOut,
    byLabel,
  };
}

/**
 * 重置（SessionStart 时调用，避免跨会话污染）。
 */
export function resetSideCallStats(): void {
  _calls = [];
}
