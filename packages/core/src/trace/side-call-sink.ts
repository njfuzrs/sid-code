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
  /**
   * 缺陷 16：调用成功但 provider 没返 usage —— token 记 0，但这次调用**发生过、花了钱**。
   * 与「真的 0 token」区分开，否则两者在统计上塌缩成同一个值。
   */
  usageMissing?: boolean;
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
  /** 缺陷 16：成功但无 usage 的调用数（成本未知，不是 0） */
  usageMissing: number;
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
 *
 * 传 `null` 摘除观察者。摘除是必需能力而非对称性洁癖：会话目录被判空壳删除后，
 * 观察者若仍在，下一次 side-call 落定会触发 `forceRebuildTraj()`，而 `Bun.write()`
 * **会自动重建缺失的父目录** —— 于是盘上冒出一个只含 `session.traj` 的幽灵目录
 * （实测 inode 变化可证是删后重建），启动清理还会放它过。详见 collector.ts
 * `sessionDisposed` 字段注释。
 */
export function setSideStatsObserver(fn: (() => void) | null): void {
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
  let usageMissing = 0;
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
    if (c.usageMissing) usageMissing++;
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
    usageMissing,
    byLabel,
  };
}

/**
 * 重置（SessionStart 时调用，避免跨会话污染）。
 *
 * ⚠️ 只清进程内记录，**不清会话基线**（N12）：restoreSession 回灌基线发生在 doInit 之前，
 * 而 TraceCollector 的 SessionStart（调本函数）在 doInit 里才 fire —— 清了基线，
 * resume 回灌的那份数据当场就没了。基线的清空走 resetSessionSideStats（/clear）。
 */
export function resetSideCallStats(): void {
  _calls = [];
  _sessionMark = 0;
}

// ─── 会话维度（N12）：resume 回灌的基线 + 本进程记录 ───
//
// 两个视角刻意分开：
//   - getSideStats()        进程维度，TraceCollector 用（trajectory 按进程重建 pairs，口径不变）；
//   - getSessionSideStats() 会话维度 = 回灌基线 + 本进程 mark 之后的记录，
//                            供会话 jsonl 落盘（side_call_stats）与用量账本用。
// 以前 side_call_stats 只写不读：resume 后 apiCalls / tokens / failed / timedOut / byLabel
// 全部从零开始，下一轮落盘还会用「只含本进程」的值覆盖掉旧快照 —— 丢的不只是展示，是数据。

/** side_call_stats 落盘 / 回灌的快照形态（不含 details 全量，避免 JSONL 膨胀）。 */
export interface SideCallSnapshot {
  apiCalls: number;
  costUSD: number;
  tokensSent: number;
  tokensReceived: number;
  failed: number;
  timedOut: number;
  byLabel: Record<string, { success: number; failed: number }>;
}

let _baseline: SideCallSnapshot | null = null;
/** 会话视角的起点下标：/clear 后此前的进程内记录不再计入会话维度。 */
let _sessionMark = 0;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * resume 时用落盘的最后一条 side_call_stats 回灌会话基线。
 *
 * **不触发 costObserver**：影子成本已经经 usage_stats.sideCostUSD 回灌进 SessionState，
 * 这里再通知一次就是双计（北极星铁律④ stock/flow 混用的近亲）。
 * 形态不合法时整条忽略并返回 false —— 宁可从零开始，也不拿半截脏数据当基线。
 */
export function hydrateSideCallBaseline(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const s = snapshot as Record<string, unknown>;
  const fields = ["apiCalls", "costUSD", "tokensSent", "tokensReceived", "failed", "timedOut"];
  // 旧版本落盘可能缺 failed / timedOut（T13 之前），缺失按 0；存在但非法则整条拒绝。
  for (const f of fields) {
    if (s[f] !== undefined && !isCount(s[f])) return false;
  }
  if (!isCount(s.apiCalls)) return false;
  const byLabel: SideCallSnapshot["byLabel"] = {};
  if (s.byLabel !== undefined) {
    if (!s.byLabel || typeof s.byLabel !== "object" || Array.isArray(s.byLabel)) return false;
    for (const [label, v] of Object.entries(s.byLabel as Record<string, unknown>)) {
      const e = v as { success?: unknown; failed?: unknown } | null;
      if (!e || !isCount(e.success) || !isCount(e.failed)) return false;
      byLabel[label] = { success: e.success, failed: e.failed };
    }
  }
  _baseline = {
    apiCalls: s.apiCalls,
    costUSD: (s.costUSD as number | undefined) ?? 0,
    tokensSent: (s.tokensSent as number | undefined) ?? 0,
    tokensReceived: (s.tokensReceived as number | undefined) ?? 0,
    failed: (s.failed as number | undefined) ?? 0,
    timedOut: (s.timedOut as number | undefined) ?? 0,
    byLabel,
  };
  return true;
}

/** 会话维度累计 = 回灌基线 + 本进程 mark 之后的记录。 */
export function getSessionSideStats(): SideCallSnapshot {
  const out: SideCallSnapshot = _baseline
    ? { ..._baseline, byLabel: structuredClone(_baseline.byLabel) }
    : {
        apiCalls: 0,
        costUSD: 0,
        tokensSent: 0,
        tokensReceived: 0,
        failed: 0,
        timedOut: 0,
        byLabel: {},
      };
  for (let i = _sessionMark; i < _calls.length; i++) {
    const c = _calls[i]!;
    out.apiCalls++;
    out.costUSD += c.costUSD;
    out.tokensSent += c.inputTokens;
    out.tokensReceived += c.outputTokens;
    if (!c.success) {
      out.failed++;
      if (c.timedOut) out.timedOut++;
    }
    const e = (out.byLabel[c.label] ??= { success: 0, failed: 0 });
    if (c.success) e.success++;
    else e.failed++;
  }
  return out;
}

/**
 * /clear：会话维度归零（清基线 + 把 mark 挪到末尾）。进程内记录保留给 trajectory ——
 * trajectory 不随 /clear 重开，它的 side_* 口径不该被 /clear 改写。
 */
export function resetSessionSideStats(): void {
  _baseline = null;
  _sessionMark = _calls.length;
}
