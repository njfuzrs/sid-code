#!/usr/bin/env bun
/**
 * 上下文预算方案（`20261112-上下文占用虚高与窗口自学习-排查与根治方案.md`）的验收取数脚本。
 *
 * ## 为什么需要它
 *
 * 方案 §7 的 6 项验收（V1-2 / V2-2 / V2-3 / V4-1 / V4-3 / V4-4）一直挂着「等上线后跑真实任务」。
 * 但「等」有两个问题：① 判据里没写清怎么从本机轨迹算出这些数（附录 `dup.py` 没入库）；
 * ② 有些场景（输入越过 664,576、同文件重复 read）不一定每天发生，空等可能永远等不到样本。
 *
 * 本脚本把六项判据落成**同一条可复现命令**，并且**按行为分段**而不是按日期分段：
 * 同一个会话里请求的 `max_tokens` 全部 ≤ 默认预算 → 修复后；全部 ≥ 300,000 → 修复前。
 * 这样无论用户什么时候升级二进制，分段都不会错。
 *
 * ## 口径（每条都指到源字段）
 *
 * | 项 | 源字段 |
 * |---|---|
 * | V1-2 | `raw.jsonl` 的 `request_sent.max_tokens` / response 的 `stop_reason`、`usage.output_tokens` |
 * | V2-2 | response 的 `usage.input_tokens` 峰值 ÷ 注册表窗口（修复后 1,048,576） |
 * | V2-3 | `usage.input_tokens` ≥ 664,576 的请求数 + 同会话 `warn.log` 的 context-limit 报错 |
 * | V4-1 | `messages.json` 的工具结果字符占比（原文 / 套用 `planStaleToolOutputClear` 之后） |
 * | V4-3 | `messages.json` 的同 file_path 重复 read 字符占全部工具结果的比例 |
 * | V4-4 | `session-summary.json` 的 `turns` 分位数 |
 *
 * ## 用法
 *
 * ```bash
 * bun run scripts/verify-context-budget-acceptance.ts              # 人读报告
 * bun run scripts/verify-context-budget-acceptance.ts --json       # 结构化输出
 * bun run scripts/verify-context-budget-acceptance.ts --days 30    # 只看近 30 天
 * bun run scripts/verify-context-budget-acceptance.ts --dir <路径>  # 指定轨迹根目录（测试用）
 * ```
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { planStaleToolOutputClear } from "@sid-code/core/context/stale-tool-output.ts";
import { resolveRequestOutputBudget } from "@sid-code/core/llm/output-budget.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 修复后的注册表窗口（DeepSeek 族）；V2-2 的分母 */
export const POST_FIX_WINDOW = 1_048_576;
/** 修复前的分母（S6 学到的 664,576 与 393,216 请求预算共同导致的显示基线） */
export const PRE_FIX_WINDOW = 664_576;
/** 修复前的请求预算（每次请求都发 max_tokens=384000） */
export const PRE_FIX_REQUEST_BUDGET = 384_000;
/** 修复后的默认请求预算 */
export const POST_FIX_REQUEST_BUDGET = 32_768;
/** V2-3 的判据门槛：修复前 6 次溢出都发生在输入 654k–664k */
export const PRE_FIX_OVERFLOW_INPUT = 664_576;

export type Era = "pre-fix" | "post-fix" | "mixed" | "unknown";

export interface RawRequest {
  index: number;
  maxTokens?: number;
  estimatedInputTokens?: number;
  model?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningEffort?: string;
}

export interface SessionData {
  id: string;
  era: Era;
  requests: RawRequest[];
  warnsContextLimit: boolean;
  turns?: number;
  messages?: Message[];
}

/** 线性插值分位数（与 numpy 的 method="linear" 同定义）。空数组返回 undefined。 */
export function quantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 按请求预算分代。
 *
 * 判据刻意用「行为」而不是日期：用户可能长期用旧二进制，也可能提前用 dev 构建。
 * - 全部 ≤ 默认预算 × 1.05（容忍思考预算下限把个别请求抬高）→ 修复后
 * - 全部 ≥ 300,000（接近旧的 384,000）→ 修复前
 * - 两者都有 → mixed（会话横跨升级时刻，统计时两边都不计，避免污染）
 * - **有请求但一个 `max_tokens` 都没有 → 修复前**：这个字段本身是 F1 加进 `raw.jsonl` 的，
 *   老轨迹不可能有（2026-11-15 实测 11-05 的 324 次请求、11-11 的 143 次请求均为 0 个）。
 *   第一版把这类会话判成 unknown，导致修复前样本只剩 8 个，V4-4 的对比根本没意义。
 */
export function classifyEra(requests: readonly RawRequest[]): Era {
  if (requests.length === 0) return "unknown";
  const vals = requests
    .map((r) => r.maxTokens)
    .filter((v): v is number => typeof v === "number" && v > 0);
  if (vals.length === 0) return "pre-fix";
  const post = vals.filter((v) => v <= POST_FIX_REQUEST_BUDGET * 1.05);
  const pre = vals.filter((v) => v >= PRE_FIX_REQUEST_BUDGET * 0.78);
  if (post.length === vals.length) return "post-fix";
  if (pre.length === vals.length) return "pre-fix";
  return "mixed";
}

export interface ToolResultShare {
  /** V4-1 方案口径：工具结果占**峰值 input** 的份额（原文） */
  before: number;
  /** 套用过期清理之后的同一份额 */
  after: number;
  /** 被清理的 tool_result 条数 */
  cleared: number;
  /** 全部 tool_result 条数 */
  toolResults: number;
}

/**
 * V4-1：工具结果占峰值 input 的份额。
 *
 * 口径照方案 §7.4 附录（不能拿「字符占全部消息的比例」直接对标 43.6%）：
 *
 * ```text
 * growth      = peak_input − 首个请求的 input          // 会话增长出来的那部分
 * 成分 token  ≈ growth × 该成分字符 / 全部成分字符
 * 占比        = 成分 token ÷ peak_input
 * ```
 *
 * 直觉：固定开销（system + 首轮）不算在分子里，只看「后来增长的部分」里工具结果占多少，
 * 再摊回峰值。这样 43.6% 与 ≤25% 才是同一个尺子。
 */
export function computeToolResultShare(
  messages: readonly Message[],
  peakInputTokens: number,
  firstInputTokens: number,
): ToolResultShare {
  let allChars = 0;
  let toolChars = 0;
  let toolResults = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") {
        allChars += b.text.length;
      } else if (b.type === "tool_use") {
        allChars += JSON.stringify(b.input ?? {}).length;
      } else if (b.type === "tool_result") {
        const len = typeof b.content === "string" ? b.content.length : 0;
        toolChars += len;
        allChars += len;
        toolResults++;
      }
      // 附录口径里 _meta.reasoning_content 也计入全部成分字符
      const reasoning = (b as any)._meta?.reasoning_content;
      if (typeof reasoning === "string") allChars += reasoning.length;
    }
  }

  const plan = planStaleToolOutputClear(messages as Message[]);
  const byId = new Map(plan.entries.map((e) => [e.toolUseId, e.replacement]));
  let afterToolChars = 0;
  let afterAllChars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") {
        afterAllChars += b.text.length;
      } else if (b.type === "tool_use") {
        afterAllChars += JSON.stringify(b.input ?? {}).length;
      } else if (b.type === "tool_result") {
        const original = typeof b.content === "string" ? b.content : "";
        const replaced = byId.get(b.tool_use_id);
        const len = replaced !== undefined ? replaced.length : original.length;
        afterToolChars += len;
        afterAllChars += len;
      }
      const reasoning = (b as any)._meta?.reasoning_content;
      if (typeof reasoning === "string") afterAllChars += reasoning.length;
    }
  }

  const growth = Math.max(0, peakInputTokens - firstInputTokens);
  const share = (chars: number, total: number) =>
    peakInputTokens > 0 && total > 0 ? (growth * (chars / total)) / peakInputTokens : 0;
  return {
    before: share(toolChars, allChars),
    after: share(afterToolChars, afterAllChars),
    cleared: byId.size,
    toolResults,
  };
}

export interface RereadShare {
  /** 同一 file_path 第二次及以后 read 的结果字符 */
  rereadChars: number;
  /** 全部 read 结果字符 */
  readChars: number;
  /** 全部工具结果字符（方案基线口径的分母） */
  allToolChars: number;
  /** 占全部工具结果字符的比例（方案基线口径） */
  ratio: number;
  rereadCalls: number;
  readCalls: number;
}

/** V4-3：同文件重复 read 占比。只统计 `read` / `read_many`，按 tool_use_id 关联入参。 */
export function computeRereadShare(messages: readonly Message[]): RereadShare {
  const inputByUseId = new Map<string, Record<string, unknown>>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use" && (b.name === "read" || b.name === "read_many")) {
        inputByUseId.set(b.id, (b.input ?? {}) as Record<string, unknown>);
      }
    }
  }
  const seen = new Set<string>();
  let rereadChars = 0;
  let readChars = 0;
  let allToolChars = 0;
  let rereadCalls = 0;
  let readCalls = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const len = typeof b.content === "string" ? b.content.length : 0;
      allToolChars += len;
      const input = inputByUseId.get(b.tool_use_id);
      if (!input) continue;
      readChars += len;
      readCalls++;
      const paths = extractPaths(input);
      if (paths.length === 0) continue;
      const dup = paths.some((p) => seen.has(p));
      for (const p of paths) seen.add(p);
      if (dup) {
        rereadChars += len;
        rereadCalls++;
      }
    }
  }
  return {
    rereadChars,
    readChars,
    allToolChars,
    ratio: allToolChars > 0 ? rereadChars / allToolChars : 0,
    rereadCalls,
    readCalls,
  };
}

function extractPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const fp = input.file_path ?? input.path;
  if (typeof fp === "string" && fp) out.push(fp);
  const files = input.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      if (typeof f === "string") out.push(f);
      else if (f && typeof f === "object" && typeof (f as any).path === "string") {
        out.push((f as any).path);
      }
    }
  }
  return out;
}

/** 读一个会话目录；缺文件的部分留空，不猜。 */
export function readSession(dir: string, id: string): SessionData | undefined {
  const rawPath = join(dir, "raw.jsonl");
  if (!existsSync(rawPath)) return undefined;
  const byIndex = new Map<number, RawRequest>();
  for (const line of readFileSync(rawPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const idx = typeof obj.index === "number" ? obj.index : undefined;
    if (idx === undefined) continue;
    const cur: RawRequest = byIndex.get(idx) ?? { index: idx };
    // ⚠️ 只有 request_sent 行带 `type`；response 行**没有** type 字段（只有 index / usage /
    // stop_reason / request）。第一版按 `type === "response"` 判定，结果 V1-2/V2-2/V2-3 全报
    // 「样本不足」——因为一条 response 都没被读到。这里改成按 `usage` 判定。
    if (obj.type === "request_sent") {
      cur.maxTokens = obj.max_tokens;
      cur.estimatedInputTokens = obj.estimated_input_tokens;
      cur.model = obj.model;
      const req = obj.request;
      if (req && typeof req === "object") {
        if (typeof req.reasoning_effort === "string") cur.reasoningEffort = req.reasoning_effort;
        if (typeof cur.maxTokens !== "number" && typeof req.max_tokens === "number") {
          cur.maxTokens = req.max_tokens;
        }
      }
    } else if (obj.usage && typeof obj.usage === "object") {
      cur.stopReason = typeof obj.stop_reason === "string" ? obj.stop_reason : undefined;
      cur.inputTokens = obj.usage.input_tokens;
      cur.outputTokens = obj.usage.output_tokens;
      const req = obj.request;
      if (req && typeof req === "object") {
        if (typeof req.reasoning_effort === "string") cur.reasoningEffort = req.reasoning_effort;
        if (typeof cur.maxTokens !== "number" && typeof req.max_tokens === "number") {
          cur.maxTokens = req.max_tokens;
        }
      }
    }
    byIndex.set(idx, cur);
  }
  const requests = [...byIndex.values()].sort((a, b) => a.index - b.index);

  const warnPath = join(dir, "warn.log");
  const warnsContextLimit =
    existsSync(warnPath) &&
    readFileSync(warnPath, "utf8").includes("exceed the model context limit");

  const summaryPath = join(dir, "session-summary.json");
  let turns: number | undefined;
  if (existsSync(summaryPath)) {
    try {
      const s = JSON.parse(readFileSync(summaryPath, "utf8"));
      if (typeof s?.turns === "number") turns = s.turns;
    } catch {
      /* 损坏的摘要不参与统计 */
    }
  }

  const messagesPath = join(dir, "messages.json");
  let messages: Message[] | undefined;
  if (existsSync(messagesPath)) {
    try {
      const m = JSON.parse(readFileSync(messagesPath, "utf8"));
      if (Array.isArray(m?.messages)) messages = m.messages as Message[];
    } catch {
      /* 损坏的消息历史不参与统计 */
    }
  }

  return {
    id,
    era: classifyEra(requests),
    requests,
    warnsContextLimit,
    turns,
    messages,
  };
}

export function scanSessions(root: string, days?: number): SessionData[] {
  if (!existsSync(root)) return [];
  const cutoff = days === undefined ? undefined : Date.now() - days * 86_400_000;
  const out: SessionData[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (cutoff !== undefined && st.mtimeMs < cutoff) continue;
    const s = readSession(dir, name);
    if (s) out.push(s);
  }
  return out;
}

export interface AcceptanceReport {
  sessions: number;
  byEra: Record<Era, number>;
  v12: {
    postRequests: number;
    lengthStops: number;
    lengthRatio: number;
    outputP99?: number;
    outputP999?: number;
    escalateEvents?: number;
  };
  v22: {
    /** 修复后：每个会话自己的「峰值 input ÷ 1,048,576」，取中位数 / p90 / 最大值 */
    postP50?: number;
    postP90?: number;
    postMax?: number;
    postPeakInput?: number;
    /** 修复前同口径（分母 664,576） */
    preP50?: number;
    preP90?: number;
    preMax?: number;
    prePeakInput?: number;
    /** 参与统计的会话数 */
    postSessions: number;
    preSessions: number;
  };
  v23: {
    postOverflowRequests: number;
    postOverflowWarns: number;
    preOverflowWarns: number;
    /**
     * 没有真实超阈样本时的机制验证：合成输入 700,000 + 1,048,576 窗口，
     * 预算判定是否允许发送。undefined = 未计算（有真实样本时不需要）。
     */
    syntheticOverflowOk?: boolean;
  };
  v41: { sessions: number; before: number; after: number; cleared: number; toolResults: number };
  v43: { sessions: number; ratio: number; rereadCalls: number; readCalls: number };
  v44: { postP95?: number; preP95?: number; postCount: number; preCount: number };
}

export function buildReport(sessions: readonly SessionData[]): AcceptanceReport {
  const byEra: Record<Era, number> = { "pre-fix": 0, "post-fix": 0, mixed: 0, unknown: 0 };
  for (const s of sessions) byEra[s.era]++;

  const post = sessions.filter((s) => s.era === "post-fix");
  const pre = sessions.filter((s) => s.era === "pre-fix");
  const allReqs = (list: readonly SessionData[]) => list.flatMap((s) => s.requests);

  // V1-2
  const postReqs = allReqs(post).filter((r) => r.stopReason !== undefined);
  const lengthStops = postReqs.filter(
    (r) => r.stopReason === "length" || r.stopReason === "max_tokens",
  );
  const outputs = postReqs
    .map((r) => r.outputTokens)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);

  // V2-2：每个会话自己的峰值占比，再看分布。
  // 方案判据是「同类任务 7 个会话降到 21%–28%」，用全库 max 会被单个超长会话拉爆，
  // 那既不是「同类任务」也不是「区间」，所以这里同时给中位数与 p90，并保留最大值作参考。
  const nums = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const peakOf = (s: SessionData) => {
    const inputs = s.requests.map((r) => r.inputTokens).filter(nums);
    if (inputs.length === 0) return undefined;
    return { peak: Math.max(...inputs), first: inputs[0] };
  };
  const sessionPeakRatios = (list: readonly SessionData[], window: number) =>
    list
      .map((s) => {
        const p = peakOf(s);
        return p ? p.peak / window : undefined;
      })
      .filter(nums)
      .sort((a, b) => a - b);
  const postRatios = sessionPeakRatios(post, POST_FIX_WINDOW);
  const preRatios = sessionPeakRatios(pre, PRE_FIX_WINDOW);
  const maxPeak = (list: readonly SessionData[]) => {
    const v = list.map((s) => peakOf(s)?.peak).filter(nums);
    return v.length > 0 ? Math.max(...v) : undefined;
  };

  // V2-3
  const postOverflow = allReqs(post).filter(
    (r) => typeof r.inputTokens === "number" && r.inputTokens >= PRE_FIX_OVERFLOW_INPUT,
  );

  // V4-1 / V4-3：只在**修复后**会话上统计。
  //
  // F4 的过期清理只在修复后的二进制里生效；把修复前会话混进来，会得到两个错误结论：
  // ① 「清理后」占比里混进一批「清理根本没跑过」的会话，把效果稀释成看起来没达标；
  // ② 重复 read 占比里混进旧版本的读法，与「F4 的占位是否诱导了更多重读」这个问题无关 ——
  //    而后者恰恰是 V4-3 要盯的风险（占位文案写着「按需精准重读」）。
  const withMessages = post.filter((s) => s.messages && s.messages.length > 0);
  let beforeSum = 0;
  let afterSum = 0;
  let clearedSum = 0;
  let trSum = 0;
  let v41Sessions = 0;
  for (const s of withMessages) {
    const p = peakOf(s);
    if (!p) continue;
    const sh = computeToolResultShare(s.messages!, p.peak, p.first);
    beforeSum += sh.before;
    afterSum += sh.after;
    clearedSum += sh.cleared;
    trSum += sh.toolResults;
    v41Sessions++;
  }
  let rereadChars = 0;
  let readChars = 0;
  let allToolChars = 0;
  let rereadCalls = 0;
  let readCalls = 0;
  for (const s of withMessages) {
    const r = computeRereadShare(s.messages!);
    rereadChars += r.rereadChars;
    readChars += r.readChars;
    allToolChars += r.allToolChars;
    rereadCalls += r.rereadCalls;
    readCalls += r.readCalls;
  }

  // V4-4
  const turnsOf = (list: readonly SessionData[]) =>
    list
      .map((s) => s.turns)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
  const postTurns = turnsOf(post);
  const preTurns = turnsOf(pre);

  return {
    sessions: sessions.length,
    byEra,
    v12: {
      postRequests: postReqs.length,
      lengthStops: lengthStops.length,
      lengthRatio: postReqs.length > 0 ? lengthStops.length / postReqs.length : 0,
      outputP99: quantile(outputs, 0.99),
      outputP999: quantile(outputs, 0.999),
    },
    v22: {
      postP50: quantile(postRatios, 0.5),
      postP90: quantile(postRatios, 0.9),
      postMax: postRatios.length > 0 ? postRatios[postRatios.length - 1] : undefined,
      postPeakInput: maxPeak(post),
      preP50: quantile(preRatios, 0.5),
      preP90: quantile(preRatios, 0.9),
      preMax: preRatios.length > 0 ? preRatios[preRatios.length - 1] : undefined,
      prePeakInput: maxPeak(pre),
      postSessions: postRatios.length,
      preSessions: preRatios.length,
    },
    v23: {
      postOverflowRequests: postOverflow.length,
      postOverflowWarns: post.filter((s) => s.warnsContextLimit).length,
      preOverflowWarns: pre.filter((s) => s.warnsContextLimit).length,
      // 真实场景不一定每天都能把输入堆到 664,576 以上（用户明说「可能永远等不到数据」），
      // 所以没有真实超阈样本时用合成输入验证同一判据的**机制**前提：预算层不会因为
      // 旧的 384k 预留而把这条请求判死。
      //
      // ⚠️ 必须同时要求「有修复后会话」：否则空输入 / 全是修复前会话时会凭空得到一个
      // pass=true，把「没有数据」判成「通过」（测试已钉住这条）。
      ...(post.length > 0 && postOverflow.length === 0
        ? {
            syntheticOverflowOk: resolveRequestOutputBudget({
              requestBudget: POST_FIX_REQUEST_BUDGET,
              contextWindow: POST_FIX_WINDOW,
              estimatedInputTokens: PRE_FIX_OVERFLOW_INPUT + 35_000,
            }).ok,
          }
        : {}),
    },
    v41: {
      sessions: withMessages.length,
      before: withMessages.length > 0 ? beforeSum / withMessages.length : 0,
      after: withMessages.length > 0 ? afterSum / withMessages.length : 0,
      cleared: clearedSum,
      toolResults: trSum,
    },
    v43: {
      sessions: withMessages.length,
      // 方案附录口径的分母是**全部工具结果**，不是 read 结果。
      // 第一版写成 rereadChars / readChars，把 30.26% 算成了「read 内部重复率」，
      // 与基线的 9.8% 不是同一个尺子（基线 9.8% 的分母同样是全部工具结果）。
      ratio: allToolChars > 0 ? rereadChars / allToolChars : 0,
      rereadCalls,
      readCalls,
    },
    v44: {
      postP95: quantile(postTurns, 0.95),
      preP95: quantile(preTurns, 0.95),
      postCount: postTurns.length,
      preCount: preTurns.length,
    },
  };
}

// ─── 输出 ─────────────────────────────────────────────────────

const pct = (v: number | undefined, digits = 2) =>
  v === undefined ? "n/a" : `${(v * 100).toFixed(digits)}%`;
const num = (v: number | undefined) =>
  v === undefined ? "n/a" : Math.round(v).toLocaleString("en-US");

/** 判据对照（与方案 §7 表逐条对应）。n/a 表示样本不足，不算通过也不算失败。 */
export function verdicts(r: AcceptanceReport): Array<{
  id: string;
  metric: string;
  actual: string;
  pass?: boolean;
  note?: string;
}> {
  const out: Array<{ id: string; metric: string; actual: string; pass?: boolean; note?: string }> =
    [];

  out.push({
    id: "V1-2",
    metric: "主循环 stop_reason=length 占比 ≤ 0.01%",
    actual: r.v12.postRequests > 0 ? pct(r.v12.lengthRatio, 4) : "样本不足",
    ...(r.v12.postRequests > 0 ? { pass: r.v12.lengthRatio <= 0.0001 } : {}),
    note: `${num(r.v12.lengthStops)} / ${num(r.v12.postRequests)} 次请求；output p99 ${num(r.v12.outputP99)}、p99.9 ${num(r.v12.outputP999)}`,
  });

  out.push({
    id: "V2-2",
    metric: "修复后峰值 input ÷ 1,048,576 落在 21%–28%",
    actual:
      r.v22.postP50 !== undefined
        ? `中位数 ${pct(r.v22.postP50)}、p90 ${pct(r.v22.postP90)}、最大 ${pct(r.v22.postMax)}`
        : "样本不足",
    // ⚠️ 方案原文判据是「同类任务」的区间（21%–28%）；本机轨迹没有「同类任务」标签，
    // 所以这里用「每会话峰值的**中位数**」作代理判据，并明确标注。
    // **下限不作失败条件**：低于 21% 说明占用更低，是好事；21% 只是方案对修复效果的
    // 预估下限，不是「不能更好」。用最大值判会永远不通过（单个超长会话就够）。
    ...(r.v22.postP50 !== undefined ? { pass: r.v22.postP50 <= 0.28 } : {}),
    note:
      `代理口径：${r.v22.postSessions} 个修复后会话各自的峰值占比取中位数（不是「同类任务」）。` +
      `全局峰值 input ${num(r.v22.postPeakInput)}；修复前同口径中位数 ${pct(r.v22.preP50)}（分母 664,576，${r.v22.preSessions} 个会话）`,
  });

  out.push({
    id: "V2-3",
    metric: "修复后输入越过 664,576 不报 context limit",
    actual:
      r.v23.postOverflowRequests > 0
        ? `${num(r.v23.postOverflowRequests)} 次超阈请求 / ${r.v23.postOverflowWarns} 个会话报错`
        : `本机无超阈真实请求；合成输入 700,000 下预算判定 = ${r.v23.syntheticOverflowOk ? "可发送" : "被拒"}`,
    ...(r.v23.postOverflowRequests > 0
      ? { pass: r.v23.postOverflowWarns === 0 }
      : r.v23.syntheticOverflowOk !== undefined
        ? { pass: r.v23.syntheticOverflowOk }
        : {}),
    note:
      `修复前报 context-limit 的会话 ${r.v23.preOverflowWarns} 个。` +
      (r.v23.postOverflowRequests === 0
        ? "没有真实样本时用 `resolveRequestOutputBudget(输入 700k, 窗口 1,048,576)` 做机制验证——" +
          "它只证明「预算不会因 384k 预留而拒绝」，真实 400 取决于服务端。"
        : ""),
  });

  out.push({
    id: "V4-1",
    metric: "工具结果占峰值 input ≤ 25%（清理后）",
    actual: r.v41.sessions > 0 ? `${pct(r.v41.after)}（原文 ${pct(r.v41.before)}）` : "样本不足",
    ...(r.v41.sessions > 0 ? { pass: r.v41.after <= 0.25 } : {}),
    note: `${num(r.v41.sessions)} 个会话、${num(r.v41.toolResults)} 条工具结果，过期清理命中 ${num(r.v41.cleared)} 条。口径：方案 §7.4 附录（growth × 成分字符占比 ÷ peak）`,
  });

  out.push({
    id: "V4-3",
    metric: "同文件重复 read 占比不高于基线 9.8%",
    actual: r.v43.sessions > 0 ? pct(r.v43.ratio) : "样本不足",
    ...(r.v43.sessions > 0 ? { pass: r.v43.ratio <= 0.098 } : {}),
    note: `${num(r.v43.rereadCalls)} / ${num(r.v43.readCalls)} 次 read 是重复读`,
  });

  out.push({
    id: "V4-4",
    metric: "turns p95 不高于修复前",
    actual:
      r.v44.postP95 !== undefined && r.v44.preP95 !== undefined
        ? `修复后 ${r.v44.postP95} vs 修复前 ${r.v44.preP95}`
        : `样本不足（post ${r.v44.postCount} / pre ${r.v44.preCount}）`,
    ...(r.v44.postP95 !== undefined && r.v44.preP95 !== undefined
      ? { pass: r.v44.postP95 <= r.v44.preP95 }
      : {}),
    // 这是六项里跨版本可比性最弱的一项：turns 由「任务本身多长」决定，
    // 而修复前后恰好横跨了工具集扩张（todo_write / sub_agent / plan 审批等），
    // 新工具本身就会增加轮数。要真正判定需要「同类任务配对」，本机轨迹做不到。
    note:
      `修复后 ${r.v44.postCount} 个会话、修复前 ${r.v44.preCount} 个。` +
      `⚠️ turns 受任务长度与工具集演进影响，不是 F1/F4 能单独控制的量 —— ` +
      `这一项的红绿只能当参考，不能当「修复失败」的证据。`,
  });

  return out;
}

function printHuman(r: AcceptanceReport): void {
  console.log("上下文预算方案验收（20261112）\n");
  console.log(
    `扫到会话 ${r.sessions} 个：修复后 ${r.byEra["post-fix"]}、修复前 ${r.byEra["pre-fix"]}、` +
      `横跨升级 ${r.byEra.mixed}、无法判定 ${r.byEra.unknown}\n`,
  );
  console.log(
    "分段判据：会话内请求 max_tokens 全部 ≤ 32,768×1.05 → 修复后；全部 ≥ 384,000×0.78 → 修复前\n",
  );
  for (const v of verdicts(r)) {
    const flag = v.pass === undefined ? "○ 样本不足" : v.pass ? "✅ 通过" : "❌ 未通过";
    console.log(`${v.id}  ${flag}`);
    console.log(`     判据：${v.metric}`);
    console.log(`     实测：${v.actual}`);
    if (v.note) console.log(`     明细：${v.note}`);
    console.log("");
  }
  const inconclusive = verdicts(r).filter((v) => v.pass === undefined).length;
  if (inconclusive > 0) {
    console.log(
      `⚠️ ${inconclusive} 项因样本不足无法判定。这不是「通过」也不是「失败」——` +
        `样本不够时可以延长 --days，或按方案允许的方式自造会话再跑。`,
    );
  }
}

function parseArgs(argv: readonly string[]): { json: boolean; days?: number; dir?: string } {
  const out: { json: boolean; days?: number; dir?: string } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--days") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) out.days = n;
    } else if (a === "--dir") {
      const d = argv[++i];
      if (d) out.dir = d;
    }
  }
  return out;
}

export function defaultTrajectoryRoot(): string {
  return join(
    process.env.SID_CONFIG_DIR ?? join(homedir(), ".sid-code"),
    "trajectories",
    "sessions",
  );
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.dir ?? defaultTrajectoryRoot();
  const sessions = scanSessions(root, args.days);
  const report = buildReport(sessions);
  if (args.json) {
    console.log(JSON.stringify({ root, report, verdicts: verdicts(report) }, null, 2));
  } else {
    console.log(`轨迹根目录：${root}\n`);
    printHuman(report);
  }
}
