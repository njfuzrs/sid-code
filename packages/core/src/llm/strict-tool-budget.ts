/**
 * D11：Anthropic strict 工具的**单请求容量**。
 *
 * 上游对 strict（Constrained Decoding）有两道容量限制，超了都回 400：
 *
 *   ① 数量：`Too many strict tools (N). The maximum number of strict tools supported is M.`
 *      文档写 20。企业网关 2026-10-17 实测 24 个工具：24 strict 6/6 400、21 strict 6/6 400、
 *      20 strict 5/6 200 —— **稳定执行**，不是偶发。而 `registry.ts` 给全部内置工具
 *      （约 40 个）打了 `strict: true`，于是网关上的 Claude 渠道**每次都踩**。
 *   ② 语法体积：`The compiled grammar is too large, which would cause performance issues.`
 *      20 strict 以内也会出现（同一实测里 1/6），schema 越大越早触发。数量收到 20 不够。
 *
 * 处置分两层：
 *
 *   - **发前收口**：单请求 strict 数不超过「该端点的已知上限」（默认 20）。超出的按
 *     `strictPriority` 降为非 strict —— 优先保曾因漏字段出过事故的工具与编辑类工具。
 *     优先级来自工具自报的元数据，本模块**不写工具名清单**。
 *   - **事后学习**：两类容量错误都按端点记下更小的上限，以新上限重发。不按
 *     `same_fingerprint` 原样重试 —— 同一请求原样重发必然同样 400（数量那条实测 6/6）。
 *
 * 取舍：strict 是从协议层杜绝「required 字段漏发」的机制，降级一个就少一份保证（更准 ↓）。
 * 但不降级的结局是**整轮 400 终止**，连非 strict 的正常调用都没有。两害相权取前者，
 * 并用优先级把损失压到最不要紧的工具上。
 *
 * 学到的上限只存进程内存：上游上限会变（网关换路由、官方调额），落盘会把一次
 * 偶发的语法体积错误永久固化成"这个端点只能发 5 个 strict"。
 */

/** 文档与实测一致的数量上限。 */
export const DEFAULT_STRICT_TOOL_LIMIT = 20;

/** 单请求最多因容量错误重发几次。数量错误一次就够；语法体积错误要逐级减半。 */
export const MAX_STRICT_CAPACITY_RETRIES = 3;

/** 端点 → 已学到的 strict 上限。key 由调用方给出（真名模型 + 归一化 baseURL）。 */
const learnedLimits = new Map<string, number>();

export function getStrictToolLimit(endpointKey: string): number {
  return learnedLimits.get(endpointKey) ?? DEFAULT_STRICT_TOOL_LIMIT;
}

/** 只收紧不放宽：两条不同错误先后到达时，取更小的那个。 */
export function learnStrictToolLimit(endpointKey: string, limit: number): void {
  const next = Math.max(0, Math.floor(limit));
  const prev = learnedLimits.get(endpointKey);
  if (prev === undefined || next < prev) learnedLimits.set(endpointKey, next);
}

/** 仅测试用：清空学习状态，避免用例之间互相污染。 */
export function resetStrictToolLimitsForTest(): void {
  learnedLimits.clear();
}

export type StrictCapacityError =
  | { kind: "count"; /** 上游报的上限 M；文案没给出时为 undefined */ limit?: number }
  | { kind: "grammar" };

const COUNT_RE = /too many strict tools/i;
const COUNT_LIMIT_RE = /maximum number of strict tools supported is\s*(\d+)/i;
const GRAMMAR_RE = /compiled grammar is too large/i;

/**
 * 从错误里识别 strict 容量错误。只认上游原文的两个固定短语 —— 裸 400 与别的
 * `invalid_request` 一律不是（把普通 400 当容量错误，会让真正的请求错误被"降 strict 重发"
 * 掩盖成另一种失败）。
 *
 * SDK 的 APIError 把 body 解析在 `err.error`，`err.message` 里是拼好的整串，两处都看。
 */
export function parseStrictCapacityError(err: unknown): StrictCapacityError | null {
  const e = err as { message?: unknown; error?: { error?: { message?: unknown } } } | null;
  const texts = [e?.error?.error?.message, e?.message].filter(
    (t): t is string => typeof t === "string",
  );
  for (const text of texts) {
    if (COUNT_RE.test(text)) {
      const m = COUNT_LIMIT_RE.exec(text);
      return { kind: "count", ...(m && { limit: Number(m[1]) }) };
    }
    if (GRAMMAR_RE.test(text)) return { kind: "grammar" };
  }
  return null;
}

/**
 * 给定刚失败那次请求的 strict 数，算出下一次该发多少。返回 null = 无法再降（已经是 0）。
 *
 * - 数量错误：用上游报的 M；没报就退一格（当前数 − 1 与默认上限取小）。
 * - 语法体积错误：减半。体积上限没有可读数字，二分是收敛最快且不至于一次砍光的走法。
 */
export function nextStrictToolLimit(error: StrictCapacityError, sentStrict: number): number | null {
  if (sentStrict <= 0) return null;
  let next: number;
  if (error.kind === "count") {
    next = error.limit ?? Math.min(sentStrict - 1, DEFAULT_STRICT_TOOL_LIMIT);
    // 上游报的上限若不小于本次发的数（文案与事实不符），至少退一格，避免原样重发
    if (next >= sentStrict) next = sentStrict - 1;
  } else {
    next = Math.floor(sentStrict / 2);
  }
  return Math.max(0, next);
}

/** 已转换成线格式的工具（只关心本模块要读写的字段）。 */
export interface StrictBudgetTool {
  name: string;
  strict?: boolean;
}

export function countStrictTools(tools: readonly StrictBudgetTool[] | undefined): number {
  return tools?.reduce((n, t) => n + (t.strict ? 1 : 0), 0) ?? 0;
}

/**
 * 把 strict 工具数收到 `limit` 以内。超出的去掉 `strict` 字段（schema 照发，只是不受约束解码）。
 *
 * 保留顺序：`strictPriority` 高者先，同优先级按工具在列表里的原顺序。**工具列表本身的
 * 顺序不变** —— 动顺序会改工具区前缀、击穿 prompt cache。
 *
 * @param priorityOf 工具名 → 优先级（来自工具元数据，未声明为 0）
 */
export function applyStrictToolBudget<T extends StrictBudgetTool>(
  tools: T[] | undefined,
  limit: number,
  priorityOf: (name: string) => number = () => 0,
): { tools: T[] | undefined; demoted: string[] } {
  if (!tools) return { tools, demoted: [] };
  const strictIdx = tools.flatMap((t, i) => (t.strict ? [i] : []));
  if (strictIdx.length <= limit) return { tools, demoted: [] };

  const keep = new Set(
    [...strictIdx]
      .sort((a, b) => priorityOf(tools[b]!.name) - priorityOf(tools[a]!.name) || a - b)
      .slice(0, Math.max(0, limit)),
  );
  const demoted: string[] = [];
  const out = tools.map((t, i) => {
    if (!t.strict || keep.has(i)) return t;
    demoted.push(t.name);
    const { strict: _drop, ...rest } = t;
    return rest as T;
  });
  return { tools: out, demoted };
}

/**
 * 请求失败后的一步：是 strict 容量错误就按端点学上限、返回降级后的工具；否则返回 null
 * （调用方原样抛出）。把「识别 → 学习 → 降级」收在一处，流式与非流式两条路径共用，
 * 免得一边修了另一边没修。
 */
export function degradeStrictToolsOnCapacityError<T extends StrictBudgetTool>(
  err: unknown,
  tools: T[] | undefined,
  endpointKey: string,
  priorityOf?: (name: string) => number,
): { tools: T[] | undefined; error: StrictCapacityError; from: number; to: number } | null {
  const error = parseStrictCapacityError(err);
  if (!error) return null;
  const from = countStrictTools(tools);
  const to = nextStrictToolLimit(error, from);
  if (to === null) return null;
  learnStrictToolLimit(endpointKey, to);
  return { tools: applyStrictToolBudget(tools, to, priorityOf).tools, error, from, to };
}
