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
 *
 * 两类错误学习策略不同（遗留清单 R3）：
 *   - 数量错误稳定复现（6/6），一次就学，永久有效（进程内）。
 *   - 语法体积错误是偶发（20 strict 时 1/6）。一次就学会让一次抖动把整个进程锁在一半，
 *     所以只降**本次请求**；同一端点**连续** {@link GRAMMAR_LEARN_STREAK} 次才学，
 *     且学到的值 {@link GRAMMAR_LEARN_TTL_MS} 后过期、回到原上限重新试探。
 *     中间任意一次成功都清零连击。
 */

import { extractHTTPStatus } from "../api/error-utils.ts";

/** 文档与实测一致的数量上限。 */
export const DEFAULT_STRICT_TOOL_LIMIT = 20;

/** 单请求最多因容量错误重发几次。数量错误一次就够；语法体积错误要逐级减半。 */
export const MAX_STRICT_CAPACITY_RETRIES = 3;

/** 语法体积错误连续几次才学进端点上限（R3）。 */
export const GRAMMAR_LEARN_STREAK = 2;

/** 语法体积学到的上限多久后过期（R3 的回升路径）。数量错误学到的不过期。 */
export const GRAMMAR_LEARN_TTL_MS = 30 * 60_000;

interface LearnedLimit {
  limit: number;
  /** 语法体积学来的条目有过期时刻；数量错误学来的为 undefined（不过期） */
  expiresAt?: number;
}

/** 端点 → 已学到的 strict 上限。key 由调用方给出（真名模型 + 归一化 baseURL）。 */
const learnedLimits = new Map<string, LearnedLimit>();
/** 端点 → 当前语法体积错误连击数（成功一次清零） */
const grammarStreaks = new Map<string, number>();

/** 测试注入时钟（过期判定用）。 */
let now: () => number = () => Date.now();

export function getStrictToolLimit(endpointKey: string): number {
  const e = learnedLimits.get(endpointKey);
  if (!e) return DEFAULT_STRICT_TOOL_LIMIT;
  if (e.expiresAt !== undefined && now() >= e.expiresAt) {
    learnedLimits.delete(endpointKey);
    return DEFAULT_STRICT_TOOL_LIMIT;
  }
  return e.limit;
}

/**
 * 只收紧不放宽：两条不同错误先后到达时，取更小的那个。
 *
 * @param ttlMs 给定时条目到期后失效（语法体积学习）；缺省永久（数量错误）。
 *   永久条目不会被带 TTL 的更大值覆盖；更小的值总会覆盖并沿用新值的有效期。
 */
export function learnStrictToolLimit(endpointKey: string, limit: number, ttlMs?: number): void {
  const next = Math.max(0, Math.floor(limit));
  const prevLimit = learnedLimits.has(endpointKey) ? getStrictToolLimit(endpointKey) : undefined;
  if (prevLimit === undefined || next < prevLimit) {
    learnedLimits.set(endpointKey, {
      limit: next,
      ...(ttlMs !== undefined && { expiresAt: now() + ttlMs }),
    });
  }
}

/** 一次请求成功：清零该端点的语法体积连击（「连续」的定义）。 */
export function noteStrictRequestSucceeded(endpointKey: string): void {
  grammarStreaks.delete(endpointKey);
}

/** 仅测试用：清空学习状态，避免用例之间互相污染。 */
export function resetStrictToolLimitsForTest(): void {
  learnedLimits.clear();
  grammarStreaks.clear();
  now = () => Date.now();
}

/** 仅测试用：注入时钟。 */
export function setStrictBudgetClockForTest(fn: () => number): void {
  now = fn;
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
 * R13：先看状态码必须是 400（归因约定「状态码 > 数字边界 > 裸子串」）。网关在 5xx / 429
 * 的错误页里原样转述上游文案时，那是另一类故障，不该触发降 strict。
 *
 * SDK 的 APIError 把 body 解析在 `err.error`，`err.message` 里是拼好的整串，两处都看。
 *
 * 边界：只在 `create()` 抛错阶段识别。网关若先回 200、再用 SSE `event: error` 带回同一文案，
 * 这里识别不到（2026-10 实测均为 400，暂未见该形态；见到再接，别预先猜格式）。
 */
export function parseStrictCapacityError(err: unknown): StrictCapacityError | null {
  if (extractHTTPStatus(err) !== 400) return null;
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

/** 一次降级的完整记录，供调用方落事件（R11）。 */
export interface StrictDegradation {
  kind: StrictCapacityError["kind"];
  from: number;
  to: number;
  /** 本次是否写进了端点上限（数量错误恒 true；语法体积要连击够数） */
  learned: boolean;
  /** 第几次重发（从 0 起） */
  attempt: number;
}

/**
 * 请求失败后的一步：是 strict 容量错误就降级、按策略学上限，返回降级后的工具；否则返回 null
 * （调用方原样抛出）。学习策略见文件头：数量错误立即学；语法体积连续 N 次才学，带 TTL。
 */
export function degradeStrictToolsOnCapacityError<T extends StrictBudgetTool>(
  err: unknown,
  tools: T[] | undefined,
  endpointKey: string,
  priorityOf?: (name: string) => number,
): {
  tools: T[] | undefined;
  error: StrictCapacityError;
  from: number;
  to: number;
  learned: boolean;
} | null {
  const error = parseStrictCapacityError(err);
  if (!error) return null;
  const from = countStrictTools(tools);
  const to = nextStrictToolLimit(error, from);
  if (to === null) return null;
  let learned = false;
  if (error.kind === "count") {
    learnStrictToolLimit(endpointKey, to);
    learned = true;
  } else {
    const streak = (grammarStreaks.get(endpointKey) ?? 0) + 1;
    grammarStreaks.set(endpointKey, streak);
    if (streak >= GRAMMAR_LEARN_STREAK) {
      learnStrictToolLimit(endpointKey, to, GRAMMAR_LEARN_TTL_MS);
      learned = true;
    }
  }
  return { tools: applyStrictToolBudget(tools, to, priorityOf).tools, error, from, to, learned };
}

/**
 * R12：「带 strict 降级的创建重试」唯一实现，流式与非流式共用（原先两处各写一遍）。
 *
 * strict 容量 400 在拿到响应头之前就抛出（还没有任何流内容），此时降 strict 重发是安全的
 * —— 不会重放已经 yield 出去的增量。非容量错误、重试用完、已 abort 一律原样抛出。
 * 成功时清零该端点的语法体积连击。
 *
 * @param create 用给定工具发起一次请求（调用方负责把 tools 写进请求体）
 * @param onDegrade 每次降级回调（落日志 / 事件），失败不影响重发
 */
export async function createWithStrictBudget<T extends StrictBudgetTool, R>(opts: {
  tools: T[] | undefined;
  endpointKey: string;
  priorityOf?: (name: string) => number;
  signal?: AbortSignal;
  create: (tools: T[] | undefined) => Promise<R>;
  onDegrade?: (d: StrictDegradation) => void;
}): Promise<{ result: R; tools: T[] | undefined }> {
  let tools = opts.tools;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await opts.create(tools);
      noteStrictRequestSucceeded(opts.endpointKey);
      return { result, tools };
    } catch (err) {
      const degraded =
        attempt < MAX_STRICT_CAPACITY_RETRIES && !opts.signal?.aborted
          ? degradeStrictToolsOnCapacityError(err, tools, opts.endpointKey, opts.priorityOf)
          : null;
      if (!degraded) throw err;
      try {
        opts.onDegrade?.({
          kind: degraded.error.kind,
          from: degraded.from,
          to: degraded.to,
          learned: degraded.learned,
          attempt,
        });
      } catch {
        /* 观测失败不影响重发 */
      }
      tools = degraded.tools;
    }
  }
}
