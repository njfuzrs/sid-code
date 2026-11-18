#!/usr/bin/env bun
/**
 * context-estimate-baseline —— 上下文估算误差基线（M1 / M2 / M3 / M4）
 *
 * 口径来源：`docs-research/.../20261117-context面板取数不准与信息缺失-修复与验收方案.md`
 * §8.3「指标与判定」。方案把「估算准不准」定义成四个可复算的量，本脚本是它们的
 * **唯一实现**——E0（修复前基线）与 E1（修复后复测）都用它，避免两次各写一份脚本、
 * 口径悄悄漂移（漂移那天两边都会「通过」）。
 *
 * ## 四个指标与源字段
 *
 * | 指标 | 定义 | 源字段 |
 * | --- | --- | --- |
 * | M1 | `|pred − actual| / actual` 的 **p95** | BeforeModel.ctx_estimated_tokens / ctx_freed_tokens；AfterModel.usage |
 * | M2 | 同一比值的 **p5**（低估尾部，带符号） | 同上 |
 * | M3 | 越界事故数；blocking 强制截断次数 | errors.jsonl / TurnError 文本；messages.json `_meta.compact_boundary.summary` |
 * | M4 | 压缩次数 | messages.json 中 `_meta.compact_boundary` 的出现次数 |
 *
 * `pred = ctx_estimated_tokens − ctx_freed_tokens`，`actual` 走
 * `normalizeCacheUsage(AfterModel.usage, provider).promptTotal` —— 与
 * `stockPromptTokens` 同一个归一化函数（口径同源，不另算一份）。
 *
 * ## 三条分母铁律（改之前先读）
 *
 * 1. **只统计 `ctx_calibrated === true` 的调用**。未校准调用（会话首个请求）的估算
 *    必然偏低 15–20%，把它算进去会让「修好之后」的 p95 被首请求掩盖。
 * 2. **作废重试不计**。`BilledRequest` 同 index 多条时只有最后一条有效；`reason:"aborted"`
 *    是会话收尾补记，不带真实 prompt，同样排除。注意 `AfterModel.usage` 是跨 attempt
 *    **累加**的（stream-processor 的行为），所以一次重试过的调用 actual 会略偏大——
 *    这是已知口径限制，脚本在 `retried` 计数里显式暴露，不静默吞掉。
 * 3. **子代理单独成组**。子代理的 BeforeModel 故意不发，能进分组的只有主会话；
 *    若将来发了，按 `agent_id` 分组而不是混进主会话分母。
 *
 * 用法：
 *   bun scripts/context-estimate-baseline.ts --run S1-run1=20261118-104518-25d7a11b
 *   bun scripts/context-estimate-baseline.ts --run S1-run1=/abs/path/to/session
 *   bun scripts/context-estimate-baseline.ts --run ... --json
 *   bun scripts/context-estimate-baseline.ts --root /tmp/ctx-e0/config-s3/trajectories/sessions --run S3-run1=<id>
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { normalizeCacheUsage, type Usage } from "@sid-code/core/llm/types.ts";
import { inferProviderByModelName } from "@sid-code/core/llm/provider-infer.ts";
import { resolvePaths } from "@sid-code/core/trace/digest.ts";

/** events.jsonl 的一行（只声明本脚本消费的字段，其余忽略） */
export interface TraceEvent {
  event: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface CallPair {
  /** BeforeModel / AfterModel / BilledRequest 共用的全局 index */
  index: number;
  /** 归属分组：主会话为 "main"，子代理为其 agent_id */
  group: string;
  model: string;
  /** ctx_estimated_tokens */
  estimated: number;
  /** ctx_freed_tokens */
  freed: number;
  /** ctx_anchor_tokens（仅用于展示，不参与 pred） */
  anchor: number;
  /** ctx_calibrated */
  calibrated: boolean;
  /** actual：normalizeCacheUsage 的 promptTotal */
  actual: number;
  /** 该 index 有过作废重试（BilledRequest 多条 / aborted） */
  retried: boolean;
  /** reason:"aborted" 的收尾补记，不计入分母 */
  aborted: boolean;
}

export interface SessionMetrics {
  label: string;
  sessionId: string;
  model: string | null;
  /** 配对成功的调用总数（含未校准、含作废） */
  paired: number;
  /**
   * 进 M1/M2 分母的调用数（已校准 + 未作废 + **未重试**）。
   *
   * 重试必须排除：`AfterModel.usage` 是跨 attempt 累加的（`accumulateUsage`；
   * `stream_restart` 刻意不回退 usage，因为作废尝试真实计费）。拿累加值去比
   * `estimated − freed`，actual 被抬高，M1 的 |err| 与 M2 的 p5 同时失真 ——
   * 这正是「分母口径一变曲线整体平移」的典型。
   */
  denominator: number;
  /** 未校准被排除的条数 */
  excludedUncalibrated: number;
  /** 同一 index 出现多次 BilledRequest（重试）被排除的条数 */
  excludedRetried: number;
  /** `reason:"aborted"` 的收尾补记被排除的条数 */
  excludedAborted: number;
  /** 保留字段：重试调用已不进分母，恒为 0（仅为兼容既有输出格式） */
  retriedInDenominator: number;
  /** |err| 的 p95，百分数（0.1234 表示 12.34%） */
  m1P95: number | null;
  /** 带符号 err 的 p5，百分数 */
  m2P5: number | null;
  /** 带符号 err 的 p95，百分数（看高估尾部用） */
  errP95: number | null;
  /** 越界事故数（上下文长度超限类错误） */
  overflowErrors: number;
  /** blocking 强制截断次数 */
  blockingTruncations: number;
  /** 压缩次数（compact_boundary 数） */
  compactions: number;
  /** 未能配对的 BeforeModel / AfterModel 条数 */
  unpairedBefore: number;
  unpairedAfter: number;
  /** 缺少 PR0 四字段的老轨迹调用数（E0 前置条件核查用） */
  missingEstimateFields: number;
  /**
   * `ctx_estimated_tokens < ctx_freed_tokens` 的调用数 —— **物理上不可能**的组合，
   * 只可能意味着字段语义漂移。
   *
   * 历史（2026-11-18 E1 端到端验收）：PR2 把 loop 里 `ctx_estimated_tokens` 的取值
   * 从 `estimateTokens()`（全量历史）换成了 `getSendTokens()`（发送量，已扣 freed），
   * 于是本脚本的 `estimated − freed` 变成双重扣减，M1 在 S2 上从 5.5% 虚高到 117.7%。
   * 这类漂移只在「freed > 0」时显形：E0 全会话 freed 恒 0，减法恒等，完全看不出来。
   * 所以把这条不可能关系做成机械检测——它红就是口径又漂了，不是数据噪声。
   */
  implausibleEstimates: number;
}

const CONTEXT_OVERFLOW_RE =
  /context_length_exceeded|context length|maximum context|too many tokens|prompt is too long|上下文长度|上下文过长/i;

/** 线性插值百分位（与 pandas/numpy 默认一致）。空数组返回 null 由调用方处理。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/** events.jsonl 的 snake_case usage → Usage（camelCase）。归一化函数只认后者。 */
export function toUsage(raw: Record<string, unknown> | undefined): Usage {
  const n = (k: string): number | undefined => {
    const v = raw?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  // inputTokens / outputTokens 在 Usage 里是必填：缺失时兜底 0
  // （normalizeCacheUsage 内部本来也用 `?? 0`，这里兜底不改变口径，只是对齐类型）
  return {
    inputTokens: n("input_tokens") ?? 0,
    outputTokens: n("output_tokens") ?? 0,
    cacheReadInputTokens: n("cache_read_input_tokens"),
    cacheCreationInputTokens: n("cache_creation_input_tokens"),
    reasoningTokens: n("reasoning_tokens"),
  };
}

interface BeforeData {
  index: number;
  group: string;
  model: string;
  estimated?: number;
  freed?: number;
  anchor?: number;
  calibrated?: boolean;
}

interface AfterData {
  index: number;
  model?: string;
  usage?: Record<string, unknown>;
}

interface BilledData {
  index: number;
  provider?: string;
  reason?: string;
  accounted?: boolean;
}

/** 把事件流拆成「配对所需的三个索引」。index 缺失的事件按不可配对处理。 */
export function indexEvents(events: TraceEvent[]): {
  befores: Map<number, BeforeData>;
  afters: Map<number, AfterData>;
  billeds: Map<number, BilledData[]>;
} {
  const befores = new Map<number, BeforeData>();
  const afters = new Map<number, AfterData>();
  const billeds = new Map<number, BilledData[]>();

  for (const e of events) {
    const d = e.data ?? {};
    // S14：主循环的 BilledRequest 用 pair_index 指向同一个全局 index；旁路调用没有 pair_index
    const idxRaw = e.event === "BilledRequest" ? (d.pair_index ?? d.index) : d.index;
    if (typeof idxRaw !== "number") continue;
    const index = idxRaw;

    if (e.event === "BeforeModel") {
      befores.set(index, {
        index,
        group: typeof d.agent_id === "string" && d.agent_id ? d.agent_id : "main",
        model: typeof d.model === "string" ? d.model : "",
        estimated: typeof d.ctx_estimated_tokens === "number" ? d.ctx_estimated_tokens : undefined,
        freed: typeof d.ctx_freed_tokens === "number" ? d.ctx_freed_tokens : undefined,
        anchor: typeof d.ctx_anchor_tokens === "number" ? d.ctx_anchor_tokens : undefined,
        calibrated: typeof d.ctx_calibrated === "boolean" ? d.ctx_calibrated : undefined,
      });
    } else if (e.event === "AfterModel") {
      afters.set(index, {
        index,
        model: typeof d.model === "string" ? d.model : undefined,
        usage: (d.usage as Record<string, unknown> | undefined) ?? undefined,
      });
    } else if (e.event === "BilledRequest") {
      const list = billeds.get(index) ?? [];
      list.push({
        index,
        provider: typeof d.provider === "string" ? d.provider : undefined,
        reason: typeof d.reason === "string" ? d.reason : undefined,
        accounted: typeof d.accounted === "boolean" ? d.accounted : undefined,
      });
      billeds.set(index, list);
    }
  }
  return { befores, afters, billeds };
}

/**
 * 配对并算出每个调用的 pred/actual。
 *
 * provider 解析顺序：BilledRequest.data.provider（同 index 最后一条）→ 按模型名推断。
 * 推断是兜底：E0 实测所有主循环调用都有 BilledRequest，走不到这一步。
 */
export function pairCalls(events: TraceEvent[]): {
  calls: CallPair[];
  unpairedBefore: number;
  unpairedAfter: number;
  missingEstimateFields: number;
} {
  const { befores, afters, billeds } = indexEvents(events);
  const calls: CallPair[] = [];
  let missingEstimateFields = 0;

  for (const [index, before] of befores) {
    const after = afters.get(index);
    if (!after) continue;

    const billed = billeds.get(index) ?? [];
    // 同 index 多条 BilledRequest = 前几条是作废重试（最后一条才对应真实响应）
    const retried = billed.length > 1;
    const last = billed[billed.length - 1];
    const aborted = last?.reason === "aborted";
    const provider = last?.provider ?? inferProviderByModelName(before.model || after.model || "");

    if (before.estimated === undefined) {
      // 老轨迹（PR0 之前）没有这个字段：单独计数，不参与任何指标
      missingEstimateFields += 1;
      continue;
    }
    if (!after.usage) continue;

    const actual = normalizeCacheUsage(toUsage(after.usage), provider).promptTotal;
    if (!(actual > 0)) continue;

    calls.push({
      index,
      group: before.group,
      model: after.model ?? before.model,
      estimated: before.estimated,
      freed: before.freed ?? 0,
      anchor: before.anchor ?? 0,
      calibrated: before.calibrated === true,
      actual,
      retried,
      aborted,
    });
  }

  return {
    calls,
    unpairedBefore: befores.size - calls.length - missingEstimateFields,
    unpairedAfter: afters.size - calls.length,
    missingEstimateFields,
  };
}

/**
 * 从一个调用的已配对结果汇总指标。
 *
 * 分组只在 `pairCalls` 里保留 group 字段；本函数一次性算全部分组（E0 只有 main），
 * 调用方按 group 过滤后复用同一套口径。
 */
export function computeMetrics(params: {
  label: string;
  sessionId: string;
  model: string | null;
  calls: CallPair[];
  unpairedBefore: number;
  unpairedAfter: number;
  missingEstimateFields: number;
  overflowErrors: number;
  blockingTruncations: number;
  compactions: number;
}): SessionMetrics {
  const { calls } = params;
  // 分母 = 已校准 + 未作废 + 未重试。重试必须排除的理由见 SessionMetrics.denominator。
  const inDenominator = calls.filter((c) => c.calibrated && !c.aborted && !c.retried);

  const errs = inDenominator.map((c) => (c.estimated - c.freed - c.actual) / c.actual);
  const absSorted = errs.map(Math.abs).sort((a, b) => a - b);
  const signedSorted = [...errs].sort((a, b) => a - b);

  return {
    label: params.label,
    sessionId: params.sessionId,
    model: params.model,
    paired: calls.length,
    denominator: inDenominator.length,
    excludedUncalibrated: calls.filter((c) => !c.calibrated).length,
    excludedRetried: calls.filter((c) => c.retried).length,
    excludedAborted: calls.filter((c) => c.aborted).length,
    retriedInDenominator: inDenominator.filter((c) => c.retried).length,
    m1P95: absSorted.length ? percentile(absSorted, 0.95) * 100 : null,
    m2P5: signedSorted.length ? percentile(signedSorted, 0.05) * 100 : null,
    errP95: signedSorted.length ? percentile(signedSorted, 0.95) * 100 : null,
    overflowErrors: params.overflowErrors,
    blockingTruncations: params.blockingTruncations,
    compactions: params.compactions,
    unpairedBefore: params.unpairedBefore,
    unpairedAfter: params.unpairedAfter,
    missingEstimateFields: params.missingEstimateFields,
    // `estimated < freed` 物理上不可能（全量历史减去释放量不会小于释放量本身）：
    // 出现即说明 ctx_estimated_tokens 又被写成了「已扣 freed 的发送量」，
    // 此时 `estimated − freed` 是双重扣减，M1/M2 全部失真。必须显式报出来，
    // 不能让它伪装成「模型估算退步」。
    implausibleEstimates: inDenominator.filter((c) => c.estimated < c.freed).length,
  };
}

/** 从 messages.json 统计压缩次数与 blocking 强制截断次数。 */
export function countCompactionsFromMessages(messagesFile: string): {
  compactions: number;
  blockingTruncations: number;
} {
  if (!existsSync(messagesFile)) return { compactions: 0, blockingTruncations: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(messagesFile, "utf8"));
  } catch {
    return { compactions: 0, blockingTruncations: 0 };
  }
  const msgs = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : (((parsed as Record<string, unknown>).messages as Array<Record<string, unknown>>) ?? []);

  let compactions = 0;
  let blockingTruncations = 0;
  for (const m of msgs) {
    const meta = m._meta as Record<string, unknown> | undefined;
    const boundary = meta?.compact_boundary as Record<string, unknown> | undefined;
    if (!boundary) continue;
    compactions += 1;
    // blocking 档的横幅文案在 loop.ts 里是「阻塞级压缩：剩余 N tokens」，
    // boundaryMeta 自身不带 trigger（只有 summary/messageCountBefore/timestamp/source），
    // 所以这里只能按 summary 前缀识别。文案在 loop.ts:1630 定义，改文案要同步改这里。
    const summary = typeof boundary.summary === "string" ? boundary.summary : "";
    if (summary.startsWith("阻塞级压缩")) blockingTruncations += 1;
  }
  return { compactions, blockingTruncations };
}

/** 从 errors.jsonl + TurnError 事件统计「上下文长度超限」类事故。 */
export function countOverflowErrors(sessionDir: string, events: TraceEvent[]): number {
  let count = 0;
  for (const e of events) {
    if (e.event !== "TurnError" && e.event !== "Error") continue;
    const text = JSON.stringify(e.data ?? {});
    if (CONTEXT_OVERFLOW_RE.test(text)) count += 1;
  }
  const errFile = join(sessionDir, "errors.jsonl");
  if (existsSync(errFile)) {
    for (const line of readFileSync(errFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (CONTEXT_OVERFLOW_RE.test(JSON.stringify(rec))) count += 1;
      } catch {
        if (CONTEXT_OVERFLOW_RE.test(line)) count += 1;
      }
    }
  }
  return count;
}

function readEvents(sessionDir: string): TraceEvent[] {
  const p = join(sessionDir, "events.jsonl");
  if (!existsSync(p)) return [];
  const out: TraceEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TraceEvent);
    } catch {
      // 半行（进程被杀）忽略：缺一条事件不影响其余配对
    }
  }
  return out;
}

function readModel(sessionDir: string): string | null {
  const events = readEvents(sessionDir);
  const start = events.find((e) => e.event === "SessionStart");
  const m = start?.data?.model;
  return typeof m === "string" ? m : null;
}

export function analyzeSession(label: string, sessionDir: string): SessionMetrics {
  const events = readEvents(sessionDir);
  const { calls, unpairedBefore, unpairedAfter, missingEstimateFields } = pairCalls(events);
  const { compactions, blockingTruncations } = countCompactionsFromMessages(
    join(sessionDir, "messages.json"),
  );
  return computeMetrics({
    label,
    sessionId: basename(sessionDir),
    model: readModel(sessionDir),
    calls,
    unpairedBefore,
    unpairedAfter,
    missingEstimateFields,
    overflowErrors: countOverflowErrors(sessionDir, events),
    blockingTruncations,
    compactions,
  });
}

/** 解析 `--run label=id|path`；不给 label 时用会话目录名。 */
export function parseRunSpec(spec: string): { label: string; idOrPath: string } {
  const eq = spec.indexOf("=");
  if (eq < 0) return { label: basename(spec), idOrPath: spec };
  return { label: spec.slice(0, eq), idOrPath: spec.slice(eq + 1) };
}

export function resolveSessionDir(idOrPath: string, root: string): string {
  return isAbsolute(idOrPath) ? idOrPath : join(root, idOrPath);
}

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

function printTable(rows: SessionMetrics[]): void {
  const head = [
    "运行",
    "会话",
    "分母",
    "排除(未校准/重试/作废)",
    "M1 |err|p95",
    "M2 err p5",
    "高估 p95",
    "M3 越界/blocking",
    "M4 压缩",
  ];
  const body = rows.map((r) => [
    r.label,
    r.sessionId,
    String(r.denominator),
    `${r.excludedUncalibrated}/${r.excludedRetried}/${r.excludedAborted}`,
    fmtPct(r.m1P95),
    fmtPct(r.m2P5),
    fmtPct(r.errP95),
    `${r.overflowErrors}/${r.blockingTruncations}`,
    String(r.compactions),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) console.log(line(b));
  const extra = rows.filter(
    (r) => r.unpairedBefore > 0 || r.unpairedAfter > 0 || r.missingEstimateFields > 0,
  );
  if (extra.length) {
    console.log("\n配对/字段异常：");
    for (const r of extra) {
      console.log(
        `  ${r.label}: 未配对 before=${r.unpairedBefore} after=${r.unpairedAfter}，缺 PR0 字段=${r.missingEstimateFields}`,
      );
    }
  }
  // 口径漂移是**读法错了**，不是模型估算退步。单独、醒目地报，因为它的现象（M1 突然
  // 翻几倍）看起来完全像「估算质量变差」，最容易被人当成产品退步去优化错误的对象。
  const implausible = rows.filter((r) => r.implausibleEstimates > 0);
  if (implausible.length) {
    console.log("\n⚠️ 口径异常（estimated < freed，物理上不可能）：");
    for (const r of implausible) {
      console.log(
        `  ${r.label}: ${r.implausibleEstimates} 条调用的 ctx_estimated_tokens 小于 ctx_freed_tokens。` +
          `这表示该轨迹的 ctx_estimated_tokens 已是「已扣释放量的发送量」（PR2 起 loop 的取值），` +
          `本脚本的 estimated−freed 口径对其不成立，M1/M2 不可用。`,
      );
    }
  }
}

export function main(argv: string[]): void {
  const runs: string[] = [];
  let root = resolvePaths().sessionsDir;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--run") runs.push(argv[++i] ?? "");
    else if (a === "--root") root = argv[++i] ?? root;
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: bun scripts/context-estimate-baseline.ts --run <label>=<session-id|路径> [--run ...] [--root <sessions 根>] [--json]",
      );
      return;
    } else {
      console.error(`未知参数: ${a}`);
      process.exitCode = 2;
      return;
    }
  }

  if (runs.length === 0) {
    console.error("至少给一个 --run <label>=<session-id|路径>（--help 看用法）");
    process.exitCode = 2;
    return;
  }

  const rows: SessionMetrics[] = [];
  for (const spec of runs) {
    const { label, idOrPath } = parseRunSpec(spec);
    const dir = resolveSessionDir(idOrPath, root);
    if (!existsSync(join(dir, "events.jsonl"))) {
      console.error(`跳过 ${label}：${dir} 下没有 events.jsonl`);
      process.exitCode = 1;
      continue;
    }
    rows.push(analyzeSession(label, dir));
  }

  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
}

if (import.meta.main) main(process.argv.slice(2));
