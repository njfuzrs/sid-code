/**
 * 流式请求可观测性观测器（全局单例）
 *
 * 解决 hang 场景诊断盲区：
 * - 缺口 1/6：StreamPhase 事件（定位 hang 在哪个阶段 + HTTP 连接状态）
 * - 缺口 2：TimeoutFired 事件（记录超时防线触发/未触发）
 * - 缺口 3：ModelCallUnpaired 增强（流状态快照）
 * - 缺口 4：TimeoutRetry 事件（记录重试是否发生）
 *
 * 设计原则：
 * - 所有写入 try-catch 静默失败（可观测性不影响正常流程）
 * - openai.ts / fallback.ts / loop.ts 通过顶层函数调用（无需持有 collector 引用）
 * - 快照数据用于 heartbeat 增强和 ModelCallUnpaired 增强
 */

// ─── 流阶段枚举 ───

export type StreamPhase =
  | "fetch_sent"
  | "headers_received"
  | "sse_consuming"
  | "first_content"
  | "completed"
  | "aborted"
  | "error";

/**
 * P2-3：把"本次请求是否命中缓存"编码成 StreamPhase 的附加维度。
 *
 * 为什么是"维度"而不是事后 join：TTFT 是 per-fetch、usage 是 per-turn，两者共享的
 * `index` 是 1:N（实测同会话 index=3 有 6 条 first_content 却只有 1 条 AfterModelRaw、
 * 另一会话 index=4 有 18 条）——按 index 关联会把一次命中的 usage 摊给同轮所有 fetch，
 * 得出的"命中组 TTFT"是假的。所以维度必须在 emit 时就随事件写下。
 *
 * `cache_hit` 是布尔分桶键（消费侧按它分 hit/miss 两桶）；`cache_read` 是原始命中
 * token 数，留给"命中量与 TTFT 是否相关"这类后续分析。两者都只在**已知**命中数时才写：
 * 不知道（OpenAI 族在首内容时刻拿不到 usage）与知道且为 0 是两件事，
 * 落一个假的 `cache_hit: false` 会把"未知"算进 miss 桶，直接污染对照结论。
 */
export function cacheDimsFor(cacheReadTokens: number | undefined): {
  cache_hit?: boolean;
  cache_read?: number;
} {
  if (cacheReadTokens === undefined) return {};
  return { cache_hit: cacheReadTokens > 0, cache_read: cacheReadTokens };
}

// ─── 字段归一：chunk 计数的唯一规范名（PR11 / §4.3）───

/**
 * PR11：「这次流收到了多少个 chunk」的**规范字段名**。
 *
 * ## 缺陷形态
 *
 * 同一个语义此前有四个名字，散在四类事件里：
 * `RetryTelemetry.totalEvents` / `StreamPhase.chunks` / `WatchdogKill.total_chunks` /
 * `ModelCallUnpaired.stream_snapshot.chunks_received`。三轮排查里相当一部分工作量
 * 花在"按时间戳手工交叉比对"上，因为没有一个字段能跨事件类型 group by。
 *
 * ## 为什么是"新增规范名"而不是"重命名四处"
 *
 * 重命名会让**全部历史轨迹**（本机 50 个会话）在新读取方眼里变成零值 ——
 * 而零值同时满足所有健康检查，是本仓记过教训的失效形态
 * （memory `instrument-only-records-hit-not-write`：仪器少记一字段 →
 * 两故障塌缩成一观测）。所以做法是**加一个各事件都带的 `chunk_count`**，
 * 老字段原样保留：
 *
 * - 新读取方（时间线脚本）一律读 `chunk_count`，一个名字覆盖四类事件；
 * - 老读取方（`digest.ts` 的 detail 文案等）继续读老字段，逐字节不变；
 * - 老轨迹缺 `chunk_count` 时读取方回退老字段，**不会静默变 0**。
 *
 * ⚠️ 三套计数口径**没有**被统一（那是另一件事，且不该由"改字段名"顺手做）：
 * `totalEvents` 是解析后事件数、`total_chunks`/`chunks_received` 是快照里的
 * chunk 数、`StreamPhase.chunks` 是 parseSSE 本地计数。所以 `chunk_count`
 * 必须与 `chunk_count_kind` 成对出现，否则会把三个不同口径的数字混着算 ——
 * 那比四个名字更糟：四个名字至少一眼能看出"这是不同的东西"。
 */
export const CHUNK_COUNT_FIELD = "chunk_count" as const;

/** `chunk_count` 的口径标注（与它必须成对出现，见 {@link CHUNK_COUNT_FIELD}）。 */
export type ChunkCountKind =
  /** 解析后 yield 出的事件数（lifecycle `snapshot.totalEvents`） */
  | "events"
  /** SSE chunk 数（parseSSE 本地计数 / 快照 `chunksReceived`） */
  | "chunks";

/**
 * 构造归一后的 chunk 计数字段对。各 emit 点展开进 data 即可：
 * `{ ...chunkCountFields(n, "chunks") }`。
 *
 * 返回**新对象**而非改传入对象：emit 点的 data 常含调用方自带的 `...extra`，
 * 原地改会让"谁覆盖谁"依赖展开顺序。
 */
export function chunkCountFields(
  count: number | undefined,
  kind: ChunkCountKind,
): Record<string, unknown> {
  if (typeof count !== "number" || !Number.isFinite(count)) return {};
  return { [CHUNK_COUNT_FIELD]: count, chunk_count_kind: kind };
}

/**
 * 读取一条事件里的 chunk 计数，优先规范名、回退四个历史名。
 *
 * 回退顺序按"口径可靠性"排：规范名 > 快照类（`total_chunks` / `chunks_received`，
 * 同一个 `snapshot.chunksReceived`）> parseSSE 本地计数（`chunks`）>
 * 事件数（`totalEvents`，口径不同，最后才用）。
 *
 * 返回 `undefined` 而非 0 表示"这条事件没有这个语义" —— 0 会被读成
 * "收到 0 个 chunk"，那是个结论，不是缺数据。
 */
export function readChunkCount(
  data: Record<string, unknown> | undefined,
): { count: number; kind: ChunkCountKind; field: string } | undefined {
  if (!data) return undefined;
  const canonical = data[CHUNK_COUNT_FIELD];
  if (typeof canonical === "number") {
    const k = data.chunk_count_kind;
    return {
      count: canonical,
      kind: k === "events" ? "events" : "chunks",
      field: CHUNK_COUNT_FIELD,
    };
  }
  const legacy: [string, ChunkCountKind][] = [
    ["total_chunks", "chunks"],
    ["chunks_received", "chunks"],
    ["chunks", "chunks"],
    ["totalEvents", "events"],
  ];
  for (const [field, kind] of legacy) {
    const v = data[field];
    if (typeof v === "number") return { count: v, kind, field };
  }
  return undefined;
}

// ─── 超时层枚举 ───

/**
 * 超时防线的层标识（闭集）。
 *
 * ⚠️ **PR11 的硬要求：任何能掐断流的防线都必须在这里有一格，并真的 emit 一条
 * `TimeoutFired`。** 这不是命名整洁问题 —— 上一轮排查方向被带偏整整一轮，
 * 成因就是两层防线开枪不留痕：`Counter({'fallback_stream_timeout': 24})`
 * 看似铁证"100% 是这一层触发"，实则**结构性地只能看到三个闸门中的一个**。
 *
 * 新增 layer 时必须同步 `scripts/telemetry-trigger-rate.ts` 的 `TIMEOUT_LAYERS`
 * 清单（那是手写数组，会漂移；有哨兵测试机械核对两处一致）。
 */
export type TimeoutLayer =
  | "header_timeout"
  | "idle_timeout"
  | "content_progress_timeout"
  | "fallback_stream_timeout"
  | "turn_hard_timeout"
  | "agent_heartbeat_timeout"
  | "agent_overall_timeout"
  /**
   * PR11（§4.5）：loop 层 watchdog 强杀。
   *
   * 此前它只发 `WatchdogKill`、并往快照里 push `turn_hard_timeout` 冒充档③。
   * 那个复用有害：`turn_hard_timeout` 是**整轮**硬顶（`maxTurnDurationMs`，
   * 谓词是"不感知进展的绝对计时"），而 watchdog 的谓词是"快照里的无进展时长"
   * —— 两者是不同的失效模式。混成一个名字后，"档③开枪了几次"这个问题
   * 永远算不对，而它正是判断"新阶梯有没有被架空"的关键数。
   */
  | "watchdog_kill"
  /**
   * PR11（§4.5）：`fetchAbsoluteTimeoutMs` 那个默认关闭的第四层。
   *
   * 它把 deadline 委托给 runtime（`AbortSignal.timeout`），runtime 的 abort
   * 不带可归因 reason、也不经本模块 —— 于是它是唯一**完全隐身**的一层。
   * 用户显式开启后它仍会掐断健康流，那时至少要能查出是谁开的枪。
   */
  | "fetch_absolute_timeout";

// ─── 流状态快照（per-index） ───

export interface StreamSnapshot {
  index: number;
  /**
   * B4：发起方 agent 标识。主循环 / provider 侧无 agentId 时为 undefined。
   *
   * 快照落在 Map 的 value 里而不只在 key 里，是为了让 heartbeat 的
   * `getActiveStreamSnapshots()` 能回答"这条活快照属于谁"——否则并行子代理场景下
   * 6 条快照在心跳里长得一模一样，隔离做了也看不出来。
   */
  agentId?: string;
  model: string;
  phase: StreamPhase;
  startedAt: number;
  httpStatusReceived: boolean;
  httpStatus?: number;
  ttfbMs?: number;
  chunksReceived: number;
  emptyChunks: number;
  lastContentProgressAt: number;
  /**
   * PR11（§4.2）：**这份快照自身最后被写入的时刻**，与业务语义无关。
   *
   * ## 为什么必须与 `lastContentProgressAt` 分开
   *
   * 这两个数在健康流上几乎相等，所以很容易被当成一个 —— 但它们在**故障时**
   * 恰好分道扬镳，而故障时才是要读它们的时候：
   *
   * | 场景 | lastContentProgressAt | statsUpdatedAt |
   * | --- | --- | --- |
   * | 流真卡死（写入方还在 tick） | 停在最后一次内容 | 持续前进 |
   * | **写入方自己没在写**（本仓真实缺陷） | 停在建快照时刻 | 同样停住 |
   *
   * 第二行是上一轮排查绕大圈的成因：`chunksReceived: 0` 看起来是权威实时状态，
   * 实际是一份几分钟没人更新的陈旧快照，而**没有任何字段能区分这两种情况**。
   * 有了本字段，`Date.now() - statsUpdatedAt` 就是快照年龄 —— 它大于 tick 周期
   * 即说明「读到的数字不可信」，而不是「流没有进展」。
   *
   * 刻意**不叫** `updatedAt`：`phase` / `httpStatus` 等字段由 `emitStreamPhase` 写，
   * 与计数字段不是同一条写入路径；这个名字限定它只描述**计数**（chunks/empty/progress）
   * 的新鲜度，避免读的人以为整份快照都是这个时刻的。
   */
  statsUpdatedAt: number;
  timeoutsFired: TimeoutLayer[];
  abortSignalAborted: boolean;
}

/**
 * PR11（§4.2）：判定快照计数是否已陈旧的默认阈值。
 *
 * 取 90s = 字节级写入方 tick 周期（`openai.ts` 的 `STALL_LOG_MS` 30s）的 3 倍。
 * 与 `TIMER_DRIFT_RATIO` 同一个取值理由：正常调度抖动落在 1~2 倍内，3 倍才算真异常，
 * 既能稳定抓住"写入方彻底没在写"，又不会因一次 GC 抖动就把健康快照标成陈旧。
 */
export const SNAPSHOT_STALE_MS = 90_000;

/**
 * 计算快照计数的年龄（毫秒）与是否陈旧。供 `ModelCallUnpaired` / heartbeat /
 * WatchdogKill 三个消费面共用一套口径 —— 各自算会漂移成三个数。
 *
 * `now` 可注入，仅为测试可确定性；生产一律不传。
 */
export function snapshotStaleness(
  snapshot: Pick<StreamSnapshot, "statsUpdatedAt">,
  now: number = Date.now(),
): { ageMs: number; stale: boolean } {
  const ageMs = Math.max(0, now - snapshot.statsUpdatedAt);
  return { ageMs, stale: ageMs >= SNAPSHOT_STALE_MS };
}

// ─── 事件写入回调类型 ───

type EventWriter = (event: {
  event: string;
  session_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}) => void;

// ─── 全局单例状态 ───

let _sessionId: string = "";
let _eventWriter: EventWriter | null = null;
const _snapshots = new Map<string, StreamSnapshot>();

/**
 * 每个 (loopId, index, agentId) 的重试序号状态（P2 · `(session,index)` 非唯一键）。
 *
 * ## 为什么必须与 `_snapshots` 分开存
 *
 * 这是本实现唯一的要害。快照在**每次重试前**被 `clearStreamSnapshot` 主动清掉
 * （`query/loop.ts:2588`、`agent/agentic-loop.ts:504` 等，理由见那里：防止看门狗读到
 * 上一次失败的脏 `lastContentProgressAt` 立即误杀）。若把 attempt 计数放进快照，
 * 它会**跟着一起归零**——于是 fallback 内部重试记到 1、2、3，主循环重试一发生就
 * 又从 1 开始。同一个 (session,index) 下出现两个 `attempt=1`，
 * **键仍然不唯一，但它现在看起来像唯一的**，比没有这个字段更糟。
 *
 * 所以这张表**刻意不被 `clearStreamSnapshot` 清理**，只在 loop / agent 整体收尾时清
 * （`clearAllSnapshots` / `cleanupAgentSnapshots` / `resetStreamObserver`）——
 * 与"一个 index 的生命周期"对齐，而不是与"一次 fetch 的生命周期"对齐。
 *
 * `sawHeaders` 用于 anthropic 路径：它**不发 `fetch_sent`**（全仓仅
 * `headers_received` 与 `first_content` 两个 emit 点），没有这个标志就无法识别
 * "又一次 fetch 开始了"，attempt 会永远停在 1。
 */
interface AttemptState {
  /** 当前 attempt 序号，**1-based**（0 表示尚未观测到任何开场 phase） */
  attempt: number;
  /** 当前 attempt 内是否已见过 headers_received（anthropic 无 fetch_sent 时的换代依据） */
  sawHeaders: boolean;
}
const _attempts = new Map<string, AttemptState>();

/**
 * 推进并返回本次事件所属的 attempt 序号。
 *
 * 换代规则（对两族 provider 都成立，且**只依赖已有的 phase 序列**，不需要 provider
 * 透传任何东西——`fallback.ts` 的重试循环根本没把 attempt 传给 provider，
 * `openStream()` 的签名里没有这个参数）：
 *
 * - `fetch_sent` —— 必然是一次新 fetch，直接进位（openai 两条路径）。
 * - `headers_received` —— 本代已经见过 headers 时进位（anthropic 路径的换代信号）；
 *   否则沿用当前代（openai 的 fetch_sent → headers 属同一代）。
 * - 其余 phase（sse_consuming / first_content / completed / aborted / error）
 *   **只读不进位**，它们描述的是当前这次 fetch 的后续阶段。
 *
 * 首个事件若不是开场 phase（老轨迹、emit 失败漏了开场），归入 attempt=1 而不是 0：
 * 0 会被读成"第 0 次尝试"，而事实是"至少发生过一次尝试，只是没观测到开场"。
 */
function nextAttempt(key: string, phase: StreamPhase): number {
  let st = _attempts.get(key);
  if (!st) {
    st = { attempt: 0, sawHeaders: false };
    _attempts.set(key, st);
  }
  if (phase === "fetch_sent") {
    st.attempt++;
    st.sawHeaders = false;
  } else if (phase === "headers_received") {
    if (st.sawHeaders || st.attempt === 0) st.attempt++;
    st.sawHeaders = true;
  } else if (st.attempt === 0) {
    st.attempt = 1;
  }
  return st.attempt;
}

// ─── Snapshot Key 管理（Fix 1：namespace 隔离）───

import { currentSseDumpContext } from "../llm/sse-chunk-dumper.ts";
import { recordTtftHistogram } from "../telemetry/metrics/latency-histograms.ts";

/**
 * 构造复合 key：`${loopId}:${index}`，带 agentId 时为 `${loopId}:${agentId}:${index}`。
 * 跨 queryLoop 的孤儿 generator 使用旧 loopId，新 queryLoop 用新 loopId 查询时永远读不到脏数据。
 *
 * B4（per-agent 状态隔离）：agentId 是**第三个维度**，对标 CC
 * `promptCacheBreakDetection.ts:151` 的 `getTrackingKey(querySource, agentId)`。
 *
 * 为什么必须有它：`agentStreamIndex = 10000 + turns` 只含轮次不含身份，而
 * `setSseDumpContext` 只由主循环（`query/loop.ts:1738`）调用——子代理沿用父 loopId，
 * 于是 6 个并行子代理的第 1 轮全部落在同一个 `${loopId}:10001` 上（实测：活跃快照数
 * = 1 而非 6；其中任一路重试调 `clearStreamSnapshot` 会把其余 5 路还在跑的活快照
 * 一并删掉，看门狗随即读不到快照）。
 *
 * 为什么不传 agentId 时不能加占位段：主循环 / provider 侧（`openai.ts` 的 obsIndex 等）
 * 都是无 agentId 调用，两侧必须拼出**同一个** key 才能读到同一份快照。因此无 agentId
 * 时保持旧格式逐字节不变——这也是「主循环行为完全不变」的保证。
 */
function makeSnapshotKey(loopId: string, index: number, agentId?: string): string {
  return agentId ? `${loopId}:${agentId}:${index}` : `${loopId}:${index}`;
}

// ─── 初始化 / 重置 ───

/**
 * 会话启动时由 collector 调用，注入写入能力。
 */
export function initStreamObserver(
  sessionId: string,
  _sessionDir: string,
  eventWriter: EventWriter,
): void {
  _sessionId = sessionId;
  _eventWriter = eventWriter;
  _snapshots.clear();
  _attempts.clear();
}

/**
 * 会话结束时清理。
 */
export function resetStreamObserver(): void {
  _sessionId = "";
  _eventWriter = null;
  _snapshots.clear();
  _attempts.clear();
}

// ─── StreamPhase 事件（缺口 1+6） ───

/**
 * 记录流阶段转换事件到 events.jsonl。
 * 调用点：openai.ts 的关键阶段转换。
 */
export function emitStreamPhase(
  index: number,
  phase: StreamPhase,
  extra?: Record<string, unknown>,
  agentId?: string,
): void {
  try {
    // Fix 1：使用复合 key（loopId:index）隔离跨 queryLoop 的快照
    // B4：带 agentId 时再加一层身份维度，隔离并行子代理（见 makeSnapshotKey 注释）
    const { loopId } = currentSseDumpContext();
    const key = makeSnapshotKey(loopId, index, agentId);
    let snapshot = _snapshots.get(key);
    if (!snapshot) {
      snapshot = {
        index,
        agentId,
        model: "",
        phase: "fetch_sent",
        startedAt: Date.now(),
        httpStatusReceived: false,
        chunksReceived: 0,
        emptyChunks: 0,
        lastContentProgressAt: Date.now(),
        // 建快照时刻即第一次"写入"：此刻计数确实是最新的（就是 0）。
        // 置 0 会让刚建的快照立刻显示为陈旧 —— 那是假阳性。
        statsUpdatedAt: Date.now(),
        timeoutsFired: [],
        abortSignalAborted: false,
      };
      _snapshots.set(key, snapshot);
    }
    snapshot.phase = phase;

    if (extra?.http_status !== undefined) {
      snapshot.httpStatusReceived = true;
      snapshot.httpStatus = extra.http_status as number;
    }
    if (extra?.ttfb_ms !== undefined) {
      snapshot.ttfbMs = extra.ttfb_ms as number;
    }
    if (extra?.model !== undefined) {
      snapshot.model = extra.model as string;
    }

    // 写入 events.jsonl
    // B4：agentId 一并落轨迹（仅在有值时加字段，主循环事件形状逐字节不变），
    // 让离线分析能把 StreamPhase 归到具体子代理，而不是只看到一堆同 index 的事件。
    //
    // P2（attempt）：重试序号由本模块按 phase 序列自行推导后注入。
    // `...extra` 放在 attempt **之后**，是为了让调用方显式传入的 attempt 覆盖推导值——
    // `agent/agentic-loop.ts` 的 5 个 emit 点已经在传 attempt（取自 `onRetry` 回调，
    // 其源头是 `fallback.ts:1428` 的 `attempt + 1`，与本模块推导的是同一个计数），
    // 那边拿得到权威值，这边只是兜底。两者语义一致，不是两套口径。
    if (_eventWriter && _sessionId) {
      const attempt = nextAttempt(key, phase);
      _eventWriter({
        event: "StreamPhase",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: agentId
          ? { index, phase, agent_id: agentId, attempt, ...extra }
          : { index, phase, attempt, ...extra },
      });
    }

    // P1（TTFT Histogram）：first_content 是三条 provider 路径（anthropic /
    // Chat Completions / Responses）**唯一的汇聚点** —— T14.6 把 first_content 的
    // emit 收敛到 lifecycle 层，正是为了这种"一个插入点覆盖全部路径"。
    // 在各 provider 里分别记会变成三份互相漂移的口径。
    //
    // 放在事件写入之外、且不受 `_eventWriter` 约束：metric 与 events.jsonl 是两条
    // 独立通道，轨迹没开时 metric 仍应该有（反之亦然）。
    if (phase === "first_content") {
      const ttft = extra?.ttft_ms;
      const model = extra?.model;
      if (typeof ttft === "number" && typeof model === "string") {
        recordTtftHistogram(ttft, model, {
          cacheHit: typeof extra?.cache_hit === "boolean" ? extra.cache_hit : undefined,
        });
      }
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

// ─── TimeoutFired 事件（缺口 2） ───

/**
 * 记录超时防线触发事件。
 * 调用点：所有 setTimeout 回调中 abort/reject 前。
 */
export function emitTimeoutFired(
  index: number,
  layer: TimeoutLayer,
  extra?: Record<string, unknown>,
  agentId?: string,
): void {
  try {
    const { loopId } = currentSseDumpContext();
    // B4：与 emitStreamPhase 用同一套 key 规则——否则子代理的超时会被记到
    // 「无 agentId」那把 key 上，既污染主循环快照，又让自己的 timeoutsFired 恒空
    // （fallback.ts 的 reopenReason 正是读这个数组来判定重开成因）。
    const key = makeSnapshotKey(loopId, index, agentId);
    const snapshot = _snapshots.get(key);
    if (snapshot) {
      snapshot.timeoutsFired.push(layer);
    }

    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimeoutFired",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: agentId ? { index, layer, agent_id: agentId, ...extra } : { index, layer, ...extra },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/**
 * PR11（§4.5）：给 `fetchAbsoluteTimeoutMs` 那个默认关闭的第四层装上留痕。
 *
 * ## 问题
 *
 * 它用 `AbortSignal.timeout(ms)` 把 deadline 交给 runtime。runtime 到点直接
 * abort，**不经本模块任何 emit**，抛出的 `DOMException("TimeoutError")` 也不带
 * 可归因 reason。于是它是唯一**完全隐身**的一层：用户显式开启后它照样能掐断
 * 一条一直在产出的健康流，而轨迹里查不到是谁开的枪。
 *
 * ## 做法：不改计时机制，只挂一个监听器
 *
 * 仍然返回 `AbortSignal.timeout` 本体（计时精度、abort 语义、与 `AbortSignal.any`
 * 的组合行为逐字节不变），只在它 abort 时补发一条 `TimeoutFired`。
 *
 * 刻意**不**换成 `setTimeout` + 自建 `AbortController`：那会把这一层从
 * "runtime 计时"改成"事件循环计时"，而本仓已有教训 —— 事件循环被半开 TCP 的 IO
 * 占满时 `setTimeout` 可能延迟数分钟才 fire（`emitTimerDrift` 的文档记着实测
 * 300s 阈值迟到到 899s）。这一层的**唯一价值**恰恰是它不依赖事件循环，
 * 为了留痕把它换掉等于拆了它存在的理由。
 *
 * ## ⚠️ 必须 disarm，否则会记出**假超时**
 *
 * `AbortSignal.timeout(ms)` 到点**一定**会 abort，与 fetch 是否早已成功结束无关
 * （signal 不知道自己被谁用过）。所以只挂监听器不解除，会出现这种轨迹：
 * 一条 20s 就正常读完的流，在第 1800s 落一条 `fetch_absolute_timeout` ——
 * **一个从未发生过的超时**。那比"没有留痕"更糟：没留痕只是缺数据，
 * 假事件会让"这一层开了几枪"变成一个纯噪声的数，且噪声量正比于成功请求数。
 *
 * 因此返回 `{signal, disarm}`：调用方必须在流结束（正常/异常/取消都算）时
 * 调用 `disarm()`。disarm 幂等，多次调用无副作用。
 *
 * 返回 `undefined` 表示"未配置，不装" —— 调用方据此决定是否 push 进 signal 数组。
 */
export function makeFetchAbsoluteTimeoutSignal(
  timeoutMs: number | undefined,
  index: number,
  extra?: Record<string, unknown>,
): { signal: AbortSignal; disarm: () => void } | undefined {
  if (timeoutMs === undefined) return undefined;
  const signal = AbortSignal.timeout(timeoutMs);
  let armed = true;
  const disarm = () => {
    armed = false;
  };
  try {
    signal.addEventListener(
      "abort",
      () => {
        // 已 disarm = 流早就结束了，这次 abort 是 runtime 到点的空放，不是它杀的。
        if (!armed) return;
        armed = false;
        emitTimeoutFired(index, "fetch_absolute_timeout", {
          threshold_ms: timeoutMs,
          // 点破归因短板：这一层的 abort 由 runtime 发出，reason 是个 DOMException
          // 而非我们的白名单字符串。标注出来，免得读轨迹的人以为是用户取消
          // （那个误判本仓记过：memory `stream-timeout-misclassified-as-cancel-rootcause`）。
          runtime_abort: true,
          ...extra,
        });
      },
      { once: true },
    );
  } catch {
    /* 监听器挂不上时退化为原行为（无留痕），绝不能因此让 fetch 起不来 */
  }
  return { signal, disarm };
}

/**
 * 记录超时触发后未生效（Promise.race 未 settle）。
 * 调用点：超时触发 5s 后检查是否已 settle。
 */
export function emitTimeoutIneffective(index: number, layer: TimeoutLayer, reason: string): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimeoutIneffective",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, layer, reason },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/** 超时未生效检查的默认宽限期（缺口 2 进阶）。 */
export const INEFFECTIVE_CHECK_DELAY_MS = 5_000;

/**
 * 超时 fire 后武装一个「未生效」检查（缺口 2 进阶，本次事故的根因指纹）。
 *
 * 用法：在超时 setTimeout 回调里 abort/reject 后立即调用，拿到 `disarm`；
 * 在超时真正生效的位置（Promise.race 已 settle / reject 已传播 / 正常清理路径）
 * 调用 `disarm()`。若 `delayMs`（默认 5s）内未 disarm，说明超时 fire 了却没能
 * 让 race settle —— 发出 `TimeoutIneffective` 事件，把「触发了却没生效」直接写进轨迹。
 *
 * 返回的 disarm 幂等，多次调用无副作用。
 */
export function armIneffectiveCheck(
  index: number,
  layer: TimeoutLayer,
  reason: string,
  delayMs: number = INEFFECTIVE_CHECK_DELAY_MS,
): () => void {
  let disarmed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    timer = setTimeout(() => {
      if (disarmed) return;
      emitTimeoutIneffective(index, layer, reason);
    }, delayMs);
    // unref：这只是诊断探针，绝不能阻止进程退出。
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  } catch {
    /* 探针创建失败静默 */
  }
  return () => {
    if (disarmed) return;
    disarmed = true;
    if (timer !== null) {
      try {
        clearTimeout(timer);
      } catch {
        /* 静默 */
      }
      timer = null;
    }
  };
}

// ─── HttpConnected 事件（缺口 6） ───

/**
 * 记录 HTTP 连接建立（收到响应头）。
 * 与 StreamPhase("headers_received") 信息重叠，但作为独立事件保证按 `HttpConnected`
 * 检索一致性（文档缺口 6 的理想事件名）。调用点：openai.ts 收到响应头后。
 */
export function emitHttpConnected(
  index: number,
  data: {
    status: number;
    content_type?: string;
    ttfb_ms?: number;
    model?: string;
  },
): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "HttpConnected",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, ...data },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

// ─── TimeoutRetry 事件（缺口 4） ───

/**
 * 记录超时重试事件。
 * 调用点：loop.ts timeout catch → continue 分支。
 */
export function emitTimeoutRetry(data: {
  index: number;
  attempt: number;
  max: number;
  elapsed_ms: number;
  model: string;
}): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimeoutRetry",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: data as unknown as Record<string, unknown>,
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

// ─── StreamRestart 事件（PR4：内容丢弃的唯一度量口径） ───

/**
 * 记录一次流重开（`stream_restart`）作废掉多少已产出内容。
 *
 * ## 为什么必须是**结构化事件**，而不是继续用那条 `log.warn`
 *
 * 改造前唯一的留痕是 `stream-processor.ts` 的一行 `log.warn`，且**带条件**
 * （`discardedBlocks > 0 || discardedTextLength > 0`）。两个后果：
 *
 * 1. **没有分母**。零产出的重开一行不记，于是「一共重开了几次」「其中几次真丢了东西」
 *    都算不出来。本仓铁律：**分母比分子重要** —— 只有分子时，分子变小既可能是
 *    "丢得少了"，也可能是"重开得少了"，两者修法完全不同。
 * 2. **离线分析拿不到**。`warn.log` 是非结构化文本，`events.jsonl` 里一个字都没有，
 *    所以任何基于轨迹的复算（§6.3 的收尾验收）都只能靠 grep 日志行数，
 *    而那个数字**系统性偏小**（实测一次会话 23 次重开只留 2 行）。
 *
 * 本事件**无条件发**（含零丢弃的重开），分母由此成立。日志那行仍然保持有条件 ——
 * 零丢弃的重开不是"警告"，把它也打成 warn 只会淹掉真正有损失的那几条。
 *
 * ## 与 `TimeoutFired` 的分工
 *
 * `TimeoutFired` 回答"哪一层闸门开了枪"，本事件回答"那一枪打掉了多少内容"。
 * 两者按 `index` + 时间戳可以拼起来，正是 §6.3 要求的
 * 「用新口径确认内容丢弃真的减少」的取数源。
 */
export function emitStreamRestart(data: {
  reason: string;
  attempt?: number;
  /** 作废的内容块数 */
  discarded_blocks: number;
  /** 作废的字符总数（可见文本 + 思考文本，与旧 `discardedTextLength` 同口径） */
  discarded_chars: number;
  /** 其中属于**思考**的字符数（`discarded_chars` 的子集） */
  discarded_thinking_chars: number;
  /** 被截断的工具入参 JSON 字符数 —— 改造前完全不可观测 */
  discarded_tool_json_chars: number;
  /** 哪个消费者（主循环 / 子代理 / forked / 无头），四条路径各自累加、口径可能不同 */
  consumer: string;
}): void {
  try {
    if (_eventWriter && _sessionId) {
      const { turnIndex, loopId } = currentSseDumpContext();
      _eventWriter({
        event: "StreamRestart",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index: turnIndex, loop_id: loopId, ...data } as unknown as Record<string, unknown>,
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/**
 * 记录超时重试耗尽事件。
 */
export function emitTimeoutRetryExhausted(data: {
  index: number;
  attempts: number;
  model: string;
}): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimeoutRetryExhausted",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: data as unknown as Record<string, unknown>,
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

// ─── 快照更新（供 openai.ts 内部调用） ───

/**
 * 更新流状态快照的 chunk 统计（**字节级**）。
 * 调用点：openai.ts parseSSE 循环中。
 *
 * P0-1 起本函数与 {@link recordStreamProgress}（事件级）并存，两者写同一份快照。
 * `chunksReceived` / `lastContentProgressAt` 因此改为**单调取大**：两个写入方的
 * 计数口径不同（chunk 数 vs 事件数，一个 chunk 可产出多个事件），直接赋值会让
 * 这两个字段在两个数之间来回跳。一个诊断计数器时大时小，会被读成「快照错乱」，
 * 比数字略偏更难排查。取大后语义退化为「至少收到过这么多 / 最近一次进展不早于」，
 * 谁也不会让它倒退。
 *
 * 单调是安全的：快照按 index 建、每次重试前由 `clearStreamSnapshot` 清掉
 * （`query/loop.ts:2588` 等），所以一份快照的生命周期内计数本就只增不减。
 * `emptyChunks` / `abortSignalAborted` 保持直接赋值 —— 它们只有 parseSSE 一个写入方。
 */
export function updateStreamStats(
  index: number,
  update: Partial<
    Pick<
      StreamSnapshot,
      "chunksReceived" | "emptyChunks" | "lastContentProgressAt" | "abortSignalAborted"
    >
  >,
): void {
  try {
    const { loopId } = currentSseDumpContext();
    const key = makeSnapshotKey(loopId, index);
    const snapshot = _snapshots.get(key);
    if (snapshot) {
      if (update.chunksReceived !== undefined && update.chunksReceived > snapshot.chunksReceived)
        snapshot.chunksReceived = update.chunksReceived;
      if (update.emptyChunks !== undefined) snapshot.emptyChunks = update.emptyChunks;
      if (
        update.lastContentProgressAt !== undefined &&
        update.lastContentProgressAt > snapshot.lastContentProgressAt
      )
        snapshot.lastContentProgressAt = update.lastContentProgressAt;
      if (update.abortSignalAborted !== undefined)
        snapshot.abortSignalAborted = update.abortSignalAborted;
      // PR11：**无条件**刷新，即使上面每个字段都因单调取大而没变。
      // 这正是本字段的意义：它回答"写入方还在写吗"，不是"数字变了吗"。
      // 只在数字变化时刷新，就退回到"陈旧与无进展分不开"的老问题上。
      snapshot.statsUpdatedAt = Date.now();
    }
  } catch {
    /* 静默 */
  }
}

/**
 * P0-1：记录一次**事件级**业务进展（唯一咽喉 `llm/stream-lifecycle.ts` 调用）。
 *
 * 与 {@link updateStreamStats} 的分工 —— 两者都写同一份快照，但语义与写法都不同：
 *
 * | | `updateStreamStats` | 本函数 |
 * | --- | --- | --- |
 * | 调用方 | `openai.ts` parseSSE（**字节级**，仅 Chat Completions 一条路径） | lifecycle（**事件级**，四条 provider 路径） |
 * | 计数口径 | 收到的 SSE chunk 数 | 解析后 yield 出的事件数 |
 * | 写法 | 直接赋值（parseSSE 是那条路径的权威计数） | **单调取大**，见下 |
 *
 * 为什么必须单调取大：Chat Completions 路径上两个写入方并存，事件数 ≤ chunk 数
 * （空 chunk / usage-only chunk 不产事件），直接赋值会让 `chunksReceived` 在两个
 * 数之间来回跳 —— 一个诊断计数器时大时小，会被读成「快照错乱」，比数字略偏更难排查。
 * 取大后它退化为「至少收到过这么多」，两个写入方都不会让它倒退。
 *
 * `lastContentProgressAt` 则是直接推进（同样只前进不后退）：它是
 * `query/loop.ts` watchdog 唯一的无进展判据，两个写入方写的是同一个语义
 * （「最近一次真内容到达的时刻」），谁更晚谁对。
 */
export function recordStreamProgress(
  index: number,
  progress: { at: number; eventCount?: number },
): void {
  try {
    const { loopId } = currentSseDumpContext();
    const snapshot = _snapshots.get(makeSnapshotKey(loopId, index));
    if (!snapshot) return;
    if (progress.at > snapshot.lastContentProgressAt) {
      snapshot.lastContentProgressAt = progress.at;
    }
    if (progress.eventCount !== undefined && progress.eventCount > snapshot.chunksReceived) {
      snapshot.chunksReceived = progress.eventCount;
    }
    // PR11：事件级写入方同样刷新新鲜度（理由同 updateStreamStats）。
    // 两个写入方都刷，快照年龄才等于"最近一次有人写"，而不是"最近一次某一条路径写"。
    snapshot.statsUpdatedAt = Date.now();
  } catch {
    /* 静默 */
  }
}

// ─── 快照读取（供 collector heartbeat / ModelCallUnpaired 使用） ───

/**
 * 获取指定 index 的流状态快照。
 * loopId 可选——不传时使用当前 ambient context 的 loopId。
 */
export function getStreamSnapshot(
  index: number,
  loopId?: string,
  agentId?: string,
): StreamSnapshot | undefined {
  const effectiveLoopId = loopId ?? currentSseDumpContext().loopId;
  return _snapshots.get(makeSnapshotKey(effectiveLoopId, index, agentId));
}

/**
 * 获取当前所有活跃请求的快照（heartbeat 用）。
 */
export function getActiveStreamSnapshots(): StreamSnapshot[] {
  return Array.from(_snapshots.values());
}

/**
 * 清除指定 index 的快照（AfterModel 正常完成后 / 看门狗启动前 / 重试前）。
 * loopId 可选——不传时使用当前 ambient context 的 loopId。
 *
 * ⚠️ **刻意不清 `_attempts`**（这不是遗漏，改动前请读 `_attempts` 的注释）：
 * 本函数的主要调用时机之一就是"重试前"，而 attempt 的全部意义正是**跨重试**
 * 区分这几次 fetch。在这里一并清掉，等于每次重试后序号都重置回 1，
 * 同一个 (session,index) 下会出现多个 `attempt=1` —— 那比没有这个字段更糟，
 * 因为它看起来像个唯一键。attempt 表按 loop / agent 收尾清理，见
 * {@link clearAllSnapshots} 与 {@link cleanupAgentSnapshots}。
 */
export function clearStreamSnapshot(index: number, loopId?: string, agentId?: string): void {
  const effectiveLoopId = loopId ?? currentSseDumpContext().loopId;
  _snapshots.delete(makeSnapshotKey(effectiveLoopId, index, agentId));
}

/**
 * Fix 1：批量清理指定 loopId 下所有快照（queryLoop 结束时调用，防止内存泄漏）。
 *
 * B4 注意：key 形如 `${loopId}:${index}` 或 `${loopId}:${agentId}:${index}`，
 * 两种都以 `${loopId}:` 开头，故本函数天然覆盖子代理快照——queryLoop 收尾时
 * 即便某个子代理漏了 teardown，也不会跨 loop 泄漏。
 */
export function clearAllSnapshots(loopId: string): void {
  for (const key of _snapshots.keys()) {
    if (key.startsWith(`${loopId}:`)) {
      _snapshots.delete(key);
    }
  }
  // attempt 计数与快照分开存（见 `_attempts` 注释），但**生命周期在这里对齐**：
  // queryLoop 结束即整轮结束，留着会让下一个 loop 复用同 index 时从旧序号续起。
  for (const key of _attempts.keys()) {
    if (key.startsWith(`${loopId}:`)) {
      _attempts.delete(key);
    }
  }
}

/**
 * B4：清理某个 agent 的全部快照（子代理结束时调用）。
 *
 * 对标 CC `promptCacheBreakDetection.ts:700` 的 `cleanupAgentTracking(agentId)`。
 * **必须与 key 掺 agentId 同批落地**：只掺 id 不清理，等于把「key 碰撞」换成
 * 「`_snapshots` 无界增长」—— 碰撞时 6 路子代理共用 1 个 entry（错但有界），
 * 隔离后每个子代理每轮各占 1 个 entry，长会话里几百个子代理 × 几十轮的快照
 * 会一直留在 Map 里，直到 queryLoop 结束才被 `clearAllSnapshots` 兜掉。
 *
 * 跨所有 loopId 匹配（不限当前 ambient loopId）：子代理的 wall-clock 可能跨越
 * 主循环轮次，收尾时 ambient loopId 未必还是当初 emit 时那个，按 loopId 过滤
 * 反而会漏清。agentId 本身已足够唯一（含 parentSessionId + taskId）。
 */
export function cleanupAgentSnapshots(agentId: string): void {
  if (!agentId) return;
  const marker = `:${agentId}:`;
  for (const key of _snapshots.keys()) {
    if (key.includes(marker)) {
      _snapshots.delete(key);
    }
  }
  // 同 clearAllSnapshots：attempt 表随子代理一起收尾，否则同一 agentId 复用时
  // （子代理可跨多轮）序号会从上次的尾巴续起。
  for (const key of _attempts.keys()) {
    if (key.includes(marker)) {
      _attempts.delete(key);
    }
  }
}

// ─── WatchdogKill 事件（T1：setInterval 看门狗强杀） ───

/**
 * 记录 setInterval watchdog 触发强制中断。
 *
 * 与 TimeoutFired("turn_hard_timeout") 的区别：turn_hard 是 Promise.race 里的
 * setTimeout，在 Bun 事件循环被半开 TCP IO 占满时可能延迟数分钟才 fire；watchdog
 * 用 setInterval（Bun 中已被 heartbeat 证明可靠）每 5s 检查流快照，是 turn_hard 的
 * 补位防线。触发时把当轮流状态快照（phase / lastContentProgressAt / chunks / 已耗时）
 * 一并写进 events.jsonl，供事后分析"为什么 turn_hard 没先生效"。
 *
 * 调用点：loop.ts 的 watchdog setInterval 回调中 abort 前。
 */
export function emitWatchdogKill(
  index: number,
  data: {
    phase: StreamPhase | "unknown";
    last_content_progress_ms: number;
    total_chunks: number;
    empty_chunks: number;
    elapsed_ms: number;
    model: string;
    /**
     * 迟判归因三件套（可选，轨迹 20260730-142920-d98e7f16：阈值 300s 却 899s 才判）。
     * raw_no_progress_ms - human_input_pause_accum_ms = last_content_progress_ms（判据）。
     * pause≈0 而 raw 远超阈值 → 定时器没按时 tick（配 TimerDrift 确认）；
     * pause 很大 → 等待扣减吃掉了时长。两者修法不同，故必须能分辨。
     */
    human_input_pause_accum_ms?: number;
    raw_no_progress_ms?: number;
    effective_threshold_ms?: number;
    /**
     * 缺口7（轮次口径统一）：会话累计轮次（跨用户消息不归零）。
     * `index` 是消息内 turnCount、跨消息回绕，离线分析"强杀发生在会话哪一阶段"
     * 与 hypothesis 各事件不可比。absoluteTurn 补齐后可比。可选：不注入则不落。
     */
    absoluteTurn?: number;
    /** 缺口7：第几条用户消息，让 index 的回绕可还原。可选，同 absoluteTurn。 */
    promptSeq?: number;
  },
): void {
  try {
    const { loopId } = currentSseDumpContext();
    const key = makeSnapshotKey(loopId, index);
    const snapshot = _snapshots.get(key);
    // ⚠️ 这里**刻意不自己 push `timeoutsFired`**：下面的 `emitTimeoutFired` 已经在
    // 同一把 key 上 push 了。两处都写会让同一次强杀在数组里出现两次，
    // 而 `fallback.ts` 的 reopenReason 只读末元素、看不出重复 ——
    // 于是"这一层开了几枪"会被系统性翻倍，是那种全绿且看着合理的错数。
    //
    // PR11：层名改用 `watchdog_kill`，不再复用 `turn_hard_timeout` 冒充档③。
    // 理由见 TimeoutLayer 的 `watchdog_kill` 注释。
    //
    // PR11（§4.5）：watchdog 此前**只发 WatchdogKill、不写 TimeoutFired** ——
    // 于是 `digest.ts` 的超时防线汇总与 `telemetry-trigger-rate.ts` 的 layer 分布
    // 里它完全隐身（两者都只扫 TimeoutFired）。补一条同层事件，两个视图立即可见。
    // 刻意**不**把 WatchdogKill 换成 TimeoutFired：后者的 data 形状是通用的
    // `{index, layer, ...extra}`，装不下迟判归因三件套（raw_no_progress_ms /
    // human_input_pause_accum_ms / effective_threshold_ms），而那三个字段是
    // 分辨"定时器没 tick"与"扣减吃掉时长"的唯一依据。两条事件各有职责。
    emitTimeoutFired(index, "watchdog_kill", {
      threshold_ms: data.effective_threshold_ms,
      elapsed_ms: data.elapsed_ms,
      model: data.model,
      last_content_progress_ms: data.last_content_progress_ms,
      ...chunkCountFields(data.total_chunks, "chunks"),
    });
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "WatchdogKill",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        // PR11：补规范 chunk 字段（老 `total_chunks` 原样保留，见 CHUNK_COUNT_FIELD）
        // + 快照新鲜度：`total_chunks: 0` 到底是"真没收到"还是"快照没人写"，
        // 此前无法分辨，而这正是上一轮把 11183 个事件读成 0 的那个坑。
        data: {
          index,
          ...data,
          ...chunkCountFields(data.total_chunks, "chunks"),
          ...(snapshot ? { snapshot_age_ms: snapshotStaleness(snapshot).ageMs } : {}),
          ...(snapshot && snapshotStaleness(snapshot).stale ? { snapshot_stale: true } : {}),
        },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

// ─── TimerDrift 事件（定时器迟到实测） ───

/**
 * 记录周期定时器的**实际 tick 间隔**远超预期（定时器迟到）。
 *
 * 根因待定的现象（轨迹 20260730-142920-d98e7f16）：两个不同类型的定时器同时迟到几百秒——
 *   | 定时器 | 阈值 | 实际 | 迟到 |
 *   |---|---|---|---|
 *   | sessionTimer（setTimeout，app.ts） | 60min | 66.9min | 417s |
 *   | watchdog（setInterval，loop.ts） | 300s | 899s | ~600s |
 * 该窗口内 events.jsonl 完全静默（`first_content` 之后到 WatchdogKill 之间零事件，
 * 且 WatchdogKill 的 total_chunks=0）。
 *
 * 两个候选根因都无法从现有轨迹证实——这正是本埋点存在的理由：
 *   ① Bun 事件循环被底层 IO hang 占满，定时器回调排不上（loop.ts:1656 注释描述过这个
 *      失效模式，但当时只有推断，没有实测）；
 *   ② watchdog 的 humanInputPauseAccumMs 扣减（loop.ts）把无进展时长扣掉了。
 * heartbeat.txt 的 `event_loop_lag_ms` 只在特定时刻采样（该会话是 07:50，晚于故障窗口
 * 07:22-07:37），拿不到故障当时的事件循环延迟——所以现象确凿、根因不能定论。
 *
 * 本埋点直接测「上一次 tick 到这一次 tick 过了多久」：预期间隔已知（interval 参数），
 * 实测超过 `expected * TIMER_DRIFT_RATIO` 即落一条事件。这样下次复现时可以直接区分：
 *   - 有 TimerDrift 事件 → 根因①（定时器真的没按时 fire，事件循环被占满）；
 *   - 无 TimerDrift 但 watchdog 迟判 → 根因②（tick 正常，是扣减逻辑把时长吃掉了）。
 * 两者的修法完全不同（①要改超时机制本身，②要改扣减口径），所以必须先能分辨。
 */
export function emitTimerDrift(
  index: number,
  data: {
    /** 定时器名称（如 "watchdog" / "turn_hard"） */
    timer: string;
    /** 预期 tick 间隔 */
    expected_ms: number;
    /**
     * 本次迟到中被判定为「系统休眠」的时长（未达休眠阈值则不带此字段）。
     *
     * 有了它，离线分析可直接区分本模块文档里提的两类迟到：
     *   - 带 sleep_ms → 机器睡了（进程被冻结，非故障，时长已从超时判据剔除）；
     *   - 无 sleep_ms 但 drift 很大 → 事件循环真被占满（是需要修的性能问题）。
     * 事故 20260801-175042-699f69f8 属前者：actual_ms=926241 全部是 Idle Sleep。
     */
    sleep_ms?: number;
    /** 实测 tick 间隔 */
    actual_ms: number;
    /** 迟到量 = actual - expected */
    drift_ms: number;
    /**
     * 缺口7（轮次口径统一）：会话累计轮次（跨用户消息不归零）。
     * `index` 是消息内 turnCount、跨消息回绕，离线分析"迟到发生在会话哪一阶段"
     * 与 hypothesis 各事件不可比。absoluteTurn 补齐后可比。可选：不注入则不落。
     */
    absoluteTurn?: number;
    /** 缺口7：第几条用户消息，让 index 的回绕可还原。可选，同 absoluteTurn。 */
    promptSeq?: number;
  },
): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimerDrift",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, ...data },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}

/**
 * 判定「定时器迟到」的倍率阈值：实测间隔超过预期的这个倍数才记事件。
 *
 * 取 3 是为了只抓真异常：正常调度抖动（GC、单个长同步任务）通常在预期间隔的
 * 1-2 倍内，5s 间隔抖到 10s 属常态，不值得落事件；而本次事故是 300s 阈值迟到
 * 到 899s（3 倍）、60min 迟到 417s——量级远超抖动，3 倍能稳定抓住且几乎不误报。
 */
export const TIMER_DRIFT_RATIO = 3;

// ─── StreamStall 事件（大间隔无进展时主动发出） ───

/**
 * 记录流 stall（长时间无内容进展）。
 * 调用点：openai.ts stall 检查逻辑。
 */
export function emitStreamStall(
  index: number,
  data: {
    no_content_progress_ms: number;
    total_chunks: number;
    empty_chunks: number;
    /**
     * PR11（§4.7）：本条对应的档位阈值（30s / 120s / 300s）。
     * 有它才能回答"这条流卡到过哪几个量级"—— 按 `tier_ms` group by 即可，
     * 不必拿 `no_content_progress_ms` 去猜分桶（那会因 tick 抖动落在档位边界两侧）。
     */
    tier_ms?: number;
    /**
     * PR11（§4.7）：本条是流结束时的"最长无进展间隔"汇总，而非某一档的实时告警。
     * 与 `tier_ms` **互斥**：档位事件带 `tier_ms`、汇总带 `summary`。
     * 聚合时必须按这个字段排除汇总条，否则同一次 stall 会被数两次。
     */
    summary?: boolean;
  },
): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "StreamStall",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        // PR11：补规范 chunk 字段（老 `total_chunks` 原样保留）
        data: { index, ...data, ...chunkCountFields(data.total_chunks, "chunks") },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}
