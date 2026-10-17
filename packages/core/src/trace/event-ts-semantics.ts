/**
 * 轨迹时间戳语义（S14 单一事实源）。
 *
 * ## 为什么要有这张表
 *
 * events.jsonl / raw.jsonl 里每条记录都有一个 `timestamp`，但它们**不是同一种时刻**：
 * 有的是「这件事开始」的时刻（请求发出、工具开始执行），有的是「这件事发生/结束」的时刻
 * （收到响应头、首个内容、响应完成）。离线拿两条事件的 timestamp 相减算耗时，
 * 必须先知道它们各自是哪一种，否则 TTFT / 工具耗时会差出一整个阶段。
 *
 * 本次**不改**任何现有 timestamp 的语义（改了等于让所有历史轨迹口径断档），
 * 只把语义写死在这里，并在每个会话的 SessionStart 事件里落一份 `ts_semantics`
 * （只写一次，不逐行加——逐行加是把一张静态表复制 N 遍）。
 *
 * ## 几条容易踩的口径
 *
 * - **start**：BeforeModel、raw.jsonl 的 `request_sent` 行与完整行（完整行的 timestamp
 *   沿用 BeforeModel 的请求时刻，结束时刻另见同行 `ended_at` / `elapsed_ms`）、PreToolUse。
 * - **occurred**：AfterModel / AfterModelRaw、HttpConnected、StreamPhase 的
 *   first_content / completed、BilledRequest、PostToolUse / PostToolUseFailure。
 * - `StreamPhase.completed.duration_ms` 从**收到响应头之后**起算，不含 TTFB。
 * - `RetryTelemetry.ttftMs` 是第三种 TTFT（重试层视角），**不要**用它画 TTFT 曲线；
 *   曲线口径以 `StreamPhase("first_content").ttft_ms` 为准。
 * - usage-ledger 的 `ts` 是 **epoch 秒**，不是 ISO 字符串，也不是毫秒。
 *
 * ## index 口径（pair_index vs index）
 *
 * - `pair_index`：与 BeforeModel / AfterModel / raw.jsonl 的 `index` **同一个全局 pair index**
 *   （resume 后在历史轮次之上接续）。由 collector 在事件落盘时给主循环的
 *   StreamPhase / HttpConnected / BilledRequest 补上。
 * - 这些事件 data 里原有的 `index` 是 provider 侧的**循环内轮次**（BilledRequest.index 同理），
 *   跨 queryLoop / resume 会重号，**不能**拿它和 raw.jsonl 的 index join。
 */

export type EventTsSemantic = "start" | "occurred";

export const EVENT_TS_SEMANTIC = {
  BeforeModel: "start",
  "raw.request_sent": "start",
  "raw.entry": "start",
  PreToolUse: "start",
  AfterModel: "occurred",
  AfterModelRaw: "occurred",
  HttpConnected: "occurred",
  "StreamPhase.first_content": "occurred",
  "StreamPhase.completed": "occurred",
  BilledRequest: "occurred",
  PostToolUse: "occurred",
  PostToolUseFailure: "occurred",
} as const satisfies Record<string, EventTsSemantic>;

/** 落进 SessionStart.data.ts_semantics 的版本号：表的口径变了就 +1，消费方据此判断 */
export const TS_SEMANTICS_VERSION = 1;

/** 需要 collector 补 `pair_index` 的主循环事件（data.index 是循环内轮次，见上） */
export const PAIR_INDEXED_EVENTS: ReadonlySet<string> = new Set([
  "StreamPhase",
  "HttpConnected",
  "BilledRequest",
]);
