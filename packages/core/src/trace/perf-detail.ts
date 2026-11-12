/**
 * /perf PR-B：面板需要、但 `aggregateSessionMetrics` 不产出的明细 —— 时间构成、按工具聚合、
 * 最慢调用、慢响应 / 停滞计数、后台辅助调用单列。
 *
 * 为什么放在 digest 里算而不是在 `/perf` 命令里再读一遍 events.jsonl：digest 已经把事件读进
 * 内存了，命令层再读一次就是两份解析、两个口径（方案 4.2「取数」一条）。
 *
 * 口径：
 * - 调用来源判据只用 `call-scope.ts` 的 `callScopeOf`，不在这里另写号段 / agent_id 判断。
 * - **时间构成四项之和 === 活跃墙钟**（验收断言 T-B1）。前三项是事件累加，第四项「其他」是差值，
 *   差值为负（埋点不全的老轨迹 / 进行中的轮）时把活跃墙钟抬到三项之和，而不是让「其他」变负。
 * - 工具只算主循环：子代理内部的工具耗时已包含在 `sub_agent` / `workflow` 工具自身的 duration 里，
 *   再加一次就是重复计算（与 collector `total_tool_duration_ms` 同口径，PR-A A5）。
 */
import { callScopeOf, isTruncatedStream } from "./call-scope.ts";

/**
 * 样本少于它时，面板不渲染分位数、直接列出样本（D5）。n<5 时 P95 就是最大值，写成「P95」会被读成慢尾巴。
 * 与 `perf-report.ts` 的 `MIN_TREND_SAMPLES` 同值（那边 re-export 这一个常量，不另写字面量）。
 */
export const MIN_PERCENTILE_SAMPLES = 5;

type Ev = { event?: string; timestamp?: string; data?: Record<string, unknown> };

export interface PerfTimeSplit {
  /** 主循环每次请求「发出 → 响应头」之和（`headers_received.ttfb_ms`） */
  ttfbMs: number;
  /** 主循环每次请求「响应头 → 流结束」之和（`stream_completed.elapsedMs`，含被打断的流：时间确实花掉了） */
  genMs: number;
  /** 主循环工具墙钟之和（`PostToolUse.duration_ms`，无 agent_id） */
  toolMs: number;
  /** 活跃墙钟 − 前三项：轮间开销、权限确认等待、本地处理 */
  otherMs: number;
  /** 活跃墙钟 = Σ 每轮「回车 → 收尾」（含中断轮；进行中的轮算到最后一条事件） */
  activeMs: number;
}

export interface PerfToolRow {
  name: string;
  n: number;
  totalMs: number;
  maxMs: number;
  /** `PostToolUse.is_error === true` 的次数 */
  failed: number;
}

export interface PerfSlowCall {
  index: number;
  elapsedMs: number;
  outputTokens?: number;
  ttftMs?: number;
  /** 这次调用触发过 `ModelCallUnpaired`（「慢响应」提示） */
  unpaired: boolean;
  /** 触发「慢响应」提示时这次调用已经跑了多久（`ModelCallUnpaired.elapsed_ms`） */
  unpairedAtMs?: number;
  /** `ModelCallUnpaired.stream_snapshot.still_progressing` —— 触发时流仍在推进 */
  stillProgressing?: boolean;
}

export interface PerfSideGroup {
  /** 分组键：fork 用 agent_id（`fork:*`），其余用 caller（如 `title_generation`） */
  key: string;
  /** 请求次数（`BilledRequest` 与 `fetch_sent` 取大者：非流式辅助调用不发 StreamPhase） */
  n: number;
  /** 首字延迟样本（只有流式的才有） */
  ttfts: number[];
  /**
   * 发出后没等到 `StreamPhase(completed)` 就结束的流（被中止 / 超时）。
   * 判据只看「没走到 completed」，不按墙钟上限的字面量判：上限各调用方不同（记忆 fork 60s、dream 120s）。
   */
  aborted: number;
  /** 被中止的那些从 fetch_sent 到 stream_completed 的最长墙钟（ms），用来让人一眼看出是不是撞了上限 */
  abortedMaxMs?: number;
}

export interface PerfDetail {
  timeSplit: PerfTimeSplit;
  /** 按 totalMs 降序，全部工具（渲染层决定截前几个） */
  tools: PerfToolRow[];
  /** 主循环模型调用次数（`AfterModelRaw` 条数，子代理不发该事件） */
  mainCalls: number;
  /** 主循环最慢的 3 次调用（`AfterModelRaw.elapsed_ms` 降序） */
  slowest: PerfSlowCall[];
  events: {
    /** `ModelCallUnpaired`：调用超过阈值仍未配对（慢响应或挂起） */
    unpaired: number;
    /** `StallEscalation`：停滞检测提升 */
    stalls: number;
    /** 主循环 `TimeoutFired` */
    timeouts: number;
    /** 主循环 `RetryTelemetry(type=retry)` */
    retries: number;
  };
  side: PerfSideGroup[];
  subagent: { fetches: number; ttfts: number[]; genMs: number };
  /**
   * 主循环各延迟指标的原始样本，**只在样本数 < MIN_PERCENTILE_SAMPLES 时给**（否则空数组）。
   * 谓词与 `aggregateSessionMetrics` 逐条相同，n 必须与 sessionMetrics 里的 n 对得上。
   * 不全量保留是因为 digest 会整体进 `/trace --json`，几百个数没人需要。
   */
  smallSamples: { ttft: number[]; gen: number[]; e2e: number[] };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function tsMs(e: Ev): number | undefined {
  if (!e.timestamp) return undefined;
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) ? t : undefined;
}

/** 后台辅助调用的分组键：fork 看 agent_id，其余看 caller */
function sideKey(d: Record<string, unknown>): string {
  const aid = d.agent_id ?? d.agentId;
  if (typeof aid === "string" && aid) return aid;
  if (typeof d.caller === "string" && d.caller) return d.caller;
  return "other";
}

function small(xs: number[]): number[] {
  return xs.length < MIN_PERCENTILE_SAMPLES ? [...xs].sort((a, b) => b - a) : [];
}

export function aggregatePerfDetail(events: Ev[]): PerfDetail {
  let ttfbMs = 0;
  let genMs = 0;
  let toolMs = 0;
  const tools = new Map<string, PerfToolRow>();
  const calls: PerfSlowCall[] = [];
  const unpairedByIndex = new Map<number, { at?: number; progressing?: boolean }>();
  const ev = { unpaired: 0, stalls: 0, timeouts: 0, retries: 0 };

  // 后台辅助：按 key 聚合；fetch 级用 (key, index, attempt) 追踪是否走到 completed
  const side = new Map<string, PerfSideGroup & { billed: number; fetches: number }>();
  const sideFetch = new Map<string, { group: string; sentAt?: number; completed: boolean }>();
  const sideEndAt = new Map<string, number>(); // key|index → stream_completed 时刻
  const sub = { fetches: 0, ttfts: [] as number[], genMs: 0 };

  // 活跃墙钟：Σ TurnComplete.elapsed_ms_since_prompt；最后一条 prompt 之后若没有收尾，算到最后一条事件
  const ttftS: number[] = [];
  const genS: number[] = [];
  const e2eS: number[] = [];
  let turnSum = 0;
  let openPromptAt: number | undefined;
  let lastTs: number | undefined;

  const ensureSide = (key: string) => {
    let g = side.get(key);
    if (!g) {
      g = { key, n: 0, ttfts: [], aborted: 0, billed: 0, fetches: 0 };
      side.set(key, g);
    }
    return g;
  };

  for (const e of events) {
    const t = tsMs(e);
    if (t !== undefined) lastTs = lastTs === undefined ? t : Math.max(lastTs, t);
    const d = e.data;
    if (!d) continue;

    switch (e.event) {
      case "UserPromptSubmit":
        if (t !== undefined) openPromptAt = t;
        break;
      case "TurnComplete": {
        const ms = num(d.elapsed_ms_since_prompt);
        if (ms && ms > 0) {
          turnSum += ms;
          // 与 aggregateSessionMetrics 同谓词：中断轮不进端到端样本（但仍计入活跃墙钟）
          if (d.stop_reason !== "abort") e2eS.push(ms);
        }
        openPromptAt = undefined;
        break;
      }
      case "StreamPhase": {
        const scope = callScopeOf(d);
        if (scope === "main") {
          if (d.phase === "headers_received") {
            const v = num(d.ttfb_ms);
            if (v !== undefined && v >= 0) ttfbMs += v;
          } else if (d.phase === "first_content") {
            const v = num(d.ttft_ms);
            if (v && v > 0) ttftS.push(v);
          }
        } else if (scope === "subagent") {
          if (d.phase === "fetch_sent") sub.fetches++;
          if (d.phase === "first_content") {
            const v = num(d.ttft_ms);
            if (v && v > 0) sub.ttfts.push(v);
          }
        } else {
          const key = sideKey(d);
          const g = ensureSide(key);
          const fk = `${key}|${String(d.index)}|${String(d.attempt ?? 1)}`;
          if (d.phase === "fetch_sent") {
            g.fetches++;
            sideFetch.set(fk, { group: key, sentAt: t, completed: false });
          } else if (d.phase === "first_content") {
            const v = num(d.ttft_ms);
            if (v && v > 0) g.ttfts.push(v);
          } else if (d.phase === "completed") {
            const f = sideFetch.get(fk);
            if (f) f.completed = true;
          }
        }
        break;
      }
      case "RetryTelemetry": {
        const scope = callScopeOf(d);
        if (d.type === "retry" && scope === "main") ev.retries++;
        if (d.type !== "stream_completed") break;
        const v = num(d.elapsedMs);
        if (scope === "main") {
          if (v && v > 0) {
            genMs += v;
            if (!isTruncatedStream(d)) genS.push(v);
          }
        } else if (scope === "subagent") {
          if (v && v > 0) sub.genMs += v;
        } else if (t !== undefined) {
          sideEndAt.set(`${sideKey(d)}|${String(d.turnIndex ?? d.index)}`, t);
        }
        break;
      }
      case "BilledRequest":
        if (callScopeOf(d) === "side") ensureSide(sideKey(d)).billed++;
        break;
      case "PostToolUse": {
        if (d.agent_id || d.agentId) break; // 子代理内部的工具：已含在 sub_agent 工具自身耗时里
        const name = typeof d.tool_name === "string" ? d.tool_name : "?";
        const ms = num(d.duration_ms) ?? 0;
        const row = tools.get(name) ?? { name, n: 0, totalMs: 0, maxMs: 0, failed: 0 };
        row.n++;
        row.totalMs += ms;
        row.maxMs = Math.max(row.maxMs, ms);
        if (d.is_error === true) row.failed++;
        tools.set(name, row);
        toolMs += ms;
        break;
      }
      case "AfterModelRaw": {
        const idx = num(d.index);
        const ms = num(d.elapsed_ms);
        if (idx === undefined || ms === undefined) break;
        const usage = d.usage as Record<string, unknown> | undefined;
        calls.push({
          index: idx,
          elapsedMs: ms,
          outputTokens: num(usage?.output_tokens),
          ttftMs: num(d.ttft_ms),
          unpaired: false,
        });
        break;
      }
      case "ModelCallUnpaired": {
        ev.unpaired++;
        const idx = num(d.index);
        const snap = d.stream_snapshot as Record<string, unknown> | undefined;
        if (idx !== undefined)
          unpairedByIndex.set(idx, {
            at: num(d.elapsed_ms),
            progressing:
              typeof snap?.still_progressing === "boolean" ? snap.still_progressing : undefined,
          });
        break;
      }
      case "StallEscalation":
        ev.stalls++;
        break;
      case "TimeoutFired":
        if (callScopeOf(d) === "main") ev.timeouts++;
        break;
    }
  }

  // 后台辅助：没走到 completed 的 fetch 记中止，并取 fetch_sent → stream_completed 的墙钟
  for (const [fk, f] of sideFetch) {
    if (f.completed) continue;
    const g = side.get(f.group)!;
    g.aborted++;
    const [key, index] = fk.split("|");
    const end = sideEndAt.get(`${key}|${index}`);
    if (end !== undefined && f.sentAt !== undefined && end >= f.sentAt) {
      g.abortedMaxMs = Math.max(g.abortedMaxMs ?? 0, end - f.sentAt);
    }
  }

  for (const c of calls) {
    const u = unpairedByIndex.get(c.index);
    if (u) {
      c.unpaired = true;
      if (u.at !== undefined) c.unpairedAtMs = u.at;
      if (u.progressing !== undefined) c.stillProgressing = u.progressing;
    }
  }

  let activeMs = turnSum;
  if (openPromptAt !== undefined && lastTs !== undefined && lastTs > openPromptAt) {
    activeMs += lastTs - openPromptAt;
  }
  const known = ttfbMs + genMs + toolMs;
  // 「其他」是差值。为负说明活跃墙钟少记了（老轨迹无 TurnComplete 等），抬平而不是出负数
  if (activeMs < known) activeMs = known;

  return {
    timeSplit: { ttfbMs, genMs, toolMs, otherMs: activeMs - known, activeMs },
    tools: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs || b.n - a.n),
    mainCalls: calls.length,
    slowest: [...calls].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3),
    events: ev,
    side: [...side.values()]
      .map(({ billed, fetches, ...g }) => ({ ...g, n: Math.max(billed, fetches) }))
      .filter((g) => g.n > 0)
      .sort((a, b) => b.n - a.n),
    subagent: sub,
    smallSamples: { ttft: small(ttftS), gen: small(genS), e2e: small(e2eS) },
  };
}
