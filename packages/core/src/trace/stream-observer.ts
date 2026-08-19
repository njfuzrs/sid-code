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

// ─── 超时层枚举 ───

export type TimeoutLayer =
  | "header_timeout"
  | "idle_timeout"
  | "content_progress_timeout"
  | "fallback_stream_timeout"
  | "turn_hard_timeout"
  | "agent_heartbeat_timeout"
  | "agent_overall_timeout";

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
  timeoutsFired: TimeoutLayer[];
  abortSignalAborted: boolean;
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

// ─── Snapshot Key 管理（Fix 1：namespace 隔离）───

import { currentSseDumpContext } from "../llm/sse-chunk-dumper.ts";

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
}

/**
 * 会话结束时清理。
 */
export function resetStreamObserver(): void {
  _sessionId = "";
  _eventWriter = null;
  _snapshots.clear();
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
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "StreamPhase",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: agentId ? { index, phase, agent_id: agentId, ...extra } : { index, phase, ...extra },
      });
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
    if (snapshot) {
      // 复用 turn_hard_timeout 层标记，便于 digest 统一按超时层聚合
      snapshot.timeoutsFired.push("turn_hard_timeout");
    }
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "WatchdogKill",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, ...data },
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
  },
): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "StreamStall",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, ...data },
      });
    }
  } catch {
    /* 可观测性不影响正常流程 */
  }
}
