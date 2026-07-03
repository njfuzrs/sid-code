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
const _snapshots = new Map<number, StreamSnapshot>();

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
): void {
  try {
    // 更新快照
    let snapshot = _snapshots.get(index);
    if (!snapshot) {
      snapshot = {
        index,
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
      _snapshots.set(index, snapshot);
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
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "StreamPhase",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, phase, ...extra },
      });
    }
  } catch { /* 可观测性不影响正常流程 */ }
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
): void {
  try {
    const snapshot = _snapshots.get(index);
    if (snapshot) {
      snapshot.timeoutsFired.push(layer);
    }

    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimeoutFired",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, layer, ...extra },
      });
    }
  } catch { /* 可观测性不影响正常流程 */ }
}

/**
 * 记录超时触发后未生效（Promise.race 未 settle）。
 * 调用点：超时触发 5s 后检查是否已 settle。
 */
export function emitTimeoutIneffective(
  index: number,
  layer: TimeoutLayer,
  reason: string,
): void {
  try {
    if (_eventWriter && _sessionId) {
      _eventWriter({
        event: "TimeoutIneffective",
        session_id: _sessionId,
        timestamp: new Date().toISOString(),
        data: { index, layer, reason },
      });
    }
  } catch { /* 可观测性不影响正常流程 */ }
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
  } catch { /* 探针创建失败静默 */ }
  return () => {
    if (disarmed) return;
    disarmed = true;
    if (timer !== null) {
      try { clearTimeout(timer); } catch { /* 静默 */ }
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
  } catch { /* 可观测性不影响正常流程 */ }
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
  } catch { /* 可观测性不影响正常流程 */ }
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
  } catch { /* 可观测性不影响正常流程 */ }
}

// ─── 快照更新（供 openai.ts 内部调用） ───

/**
 * 更新流状态快照的 chunk 统计。
 * 调用点：openai.ts parseSSE 循环中。
 */
export function updateStreamStats(
  index: number,
  update: Partial<Pick<StreamSnapshot, "chunksReceived" | "emptyChunks" | "lastContentProgressAt" | "abortSignalAborted">>,
): void {
  try {
    const snapshot = _snapshots.get(index);
    if (snapshot) {
      if (update.chunksReceived !== undefined) snapshot.chunksReceived = update.chunksReceived;
      if (update.emptyChunks !== undefined) snapshot.emptyChunks = update.emptyChunks;
      if (update.lastContentProgressAt !== undefined) snapshot.lastContentProgressAt = update.lastContentProgressAt;
      if (update.abortSignalAborted !== undefined) snapshot.abortSignalAborted = update.abortSignalAborted;
    }
  } catch { /* 静默 */ }
}

// ─── 快照读取（供 collector heartbeat / ModelCallUnpaired 使用） ───

/**
 * 获取指定 index 的流状态快照。
 */
export function getStreamSnapshot(index: number): StreamSnapshot | undefined {
  return _snapshots.get(index);
}

/**
 * 获取当前所有活跃请求的快照（heartbeat 用）。
 */
export function getActiveStreamSnapshots(): StreamSnapshot[] {
  return Array.from(_snapshots.values());
}

/**
 * 清除指定 index 的快照（AfterModel 正常完成后）。
 */
export function clearStreamSnapshot(index: number): void {
  _snapshots.delete(index);
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
  },
): void {
  try {
    const snapshot = _snapshots.get(index);
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
  } catch { /* 可观测性不影响正常流程 */ }
}

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
  } catch { /* 可观测性不影响正常流程 */ }
}
