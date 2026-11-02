/**
 * 按调用方（agentId）聚合的会话用量 —— 账本行 `byAgent` 字段的取数源（记忆横向剖析 T1.2）。
 *
 * ## 为什么不是「账本条目加一个 agentId」
 *
 * `usage-ledger.jsonl` 是**每会话一行**（upsert，见 usage-ledger.ts），不是每请求一行。
 * 一行里同时有主循环、memory-extract、session-memory-update、子代理的钱，单个 `agentId`
 * 字段表达不了；拆成多行又会让 `aggregateEntries` 的 sessions += 1 口径翻倍。
 * 所以落一个 `byAgent: { [agentId]: {requests, inputTokens, outputTokens, costUSD} }`。
 *
 * ## 取数点在计费发生侧
 *
 * `recordBilledRequest` 是唯一必然经过的点（去重之后调本模块），与 `BilledRequest.agent_id`
 * 同源。主循环（agentId 为空）不进表：它的量已经是行上的 promptTotal / costUSD。
 *
 * ## stock / flow（北极星铁律 4）
 *
 * 账本行是会话累计值（stock），本模块进程内只看得到本进程的 fetch（flow）。resume 后
 * 若直接用本进程聚合覆盖旧行，历史调用方用量就丢了 —— 与 side-call-sink 的 N12 同一个坑。
 * 所以与它同构：resume 时用旧账本行回灌基线，会话值 = 基线 + 本进程记录。
 */

import type { Usage } from "../llm/types.ts";

/** 单个调用方的会话累计用量 */
export interface AgentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** 由注入的计价函数算出；未注入时为 0（不猜价） */
  costUSD: number;
}

export type AgentUsageMap = Record<string, AgentUsage>;

/** 计价函数注入点（app.ts 注入 SessionState.calculateCost，与账本 costUSD 同口径） */
export type AgentUsageCostFn = (req: {
  model: string;
  provider: string;
  baseURL?: string;
  /** 与 BilledRequest.usage 同类型：计价函数（SessionState.calculateCost）直接吃它 */
  usage: Usage;
  atMs?: number;
}) => number;

let _baseline: AgentUsageMap = {};
let _current: AgentUsageMap = {};
let _costFn: AgentUsageCostFn | null = null;

export function setAgentUsageCostCalculator(fn: AgentUsageCostFn | null): void {
  _costFn = fn;
}

/** 由 billing-sink 在去重之后调用。主循环（无 agentId）直接忽略。 */
export function recordAgentUsage(
  req: Parameters<AgentUsageCostFn>[0] & { agentId?: string },
): void {
  if (!req.agentId) return;
  let cost = 0;
  try {
    cost = _costFn ? _costFn(req) : 0;
  } catch {
    cost = 0;
  }
  const e = (_current[req.agentId] ??= {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  });
  e.requests += 1;
  e.inputTokens += req.usage.inputTokens ?? 0;
  e.outputTokens += req.usage.outputTokens ?? 0;
  e.costUSD += Number.isFinite(cost) ? cost : 0;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * resume 时用该会话已有账本行的 `byAgent` 回灌基线。形态不合法整条忽略（返回 false）——
 * 宁可从零开始，也不拿半截脏数据当基线。
 */
export function hydrateAgentUsageBaseline(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const out: AgentUsageMap = {};
  for (const [id, v] of Object.entries(snapshot as Record<string, unknown>)) {
    const e = v as Partial<AgentUsage> | null;
    if (!e || !isCount(e.requests) || !isCount(e.inputTokens) || !isCount(e.outputTokens)) {
      return false;
    }
    out[id] = {
      requests: e.requests,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      costUSD: isCount(e.costUSD) ? e.costUSD : 0,
    };
  }
  _baseline = out;
  return true;
}

/** 会话维度 = 基线 + 本进程记录。空表返回 undefined（账本不落空对象）。 */
export function getSessionAgentUsage(): AgentUsageMap | undefined {
  const out: AgentUsageMap = structuredClone(_baseline);
  for (const [id, e] of Object.entries(_current)) {
    const t = (out[id] ??= { requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 });
    t.requests += e.requests;
    t.inputTokens += e.inputTokens;
    t.outputTokens += e.outputTokens;
    t.costUSD += e.costUSD;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * SessionStart 时调：只清本进程记录，**不清基线** —— resume 回灌发生在 SessionStart 之前，
 * 清了基线回灌就白做了（与 side-call-sink `resetSideCallStats` 同一时序约束）。
 */
export function resetAgentUsageProcess(): void {
  _current = {};
}

/** /clear 与测试用：基线与本进程记录一起清。 */
export function resetAgentUsageSession(): void {
  _baseline = {};
  _current = {};
}
