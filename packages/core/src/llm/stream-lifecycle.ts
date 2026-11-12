/**
 * 流式生命周期统一抽象层 — stream-lifecycle.ts（T7）
 *
 * § 定位
 * 这是 `stream-guard.ts` 的架构升级版：把分散在三处的流超时保护（stream-guard 仅
 * Anthropic 用 / openai.ts parseSSE 自建 / fallback.ts 独立整体超时）收敛为**一套**
 * 三层超时机制，供所有 provider（anthropic/openai/ollama + 未来）+ 子代理 + side-call
 * 共用。新增 provider 只需实现协议适配 + 声明 `isContentProgress` 回调即可白嫖全套保护。
 *
 * § 三层超时（借鉴 Vercel AI SDK 的超时分级 + 本项目的事故淬炼）
 *   Layer 1  idle timeout          —— N 秒无**任何事件** → 中断（TCP 连接彻底断开）
 *   Layer 2  content progress      —— N 秒无**有效业务内容** → 中断（防 keep-alive/ping 续命）
 *   Layer 3  overall timeout       —— 单次尝试从开始超过硬上限 → 中断（对齐官方 SDK request timeout）
 *   retry    漏斗控制事件          —— retry_backoff 期间三层停表；新尝试三层重新起表（见 classifyRetryBoundary）
 *   signal   abort 穿透            —— 用户 ESC / 上层超时 → 立即退出
 *   telemetry stream_stall/idle/content/overall/completed —— 统一诊断事件
 *   TTFT     first-content 回调     —— 首个真实内容事件到达时回调一次（T14.6），
 *                                     provider 据此统一 emit first_content StreamPhase，
 *                                     新 provider 白嫖 TTFT 追踪，无需各自手写检测
 *
 * § 关键设计决策：provider 提供"进展判定"，通用层管定时器
 * openai 的 keep-alive 判定发生在 SSE 原始字节层，anthropic 的事件已结构化——两者对
 * "什么算业务进展"定义不同。解法：通用层管定时器和 signal，provider 通过 `isContentProgress`
 * 回调告诉通用层"这个事件算不算进展"。
 *
 * § 行为等价铁律
 * idle / content timer 用 setTimeout（与 stream-guard.ts 完全一致的语义与精度），
 * **不**改成 setInterval 轮询——既有单测依赖细粒度定时（idle=100ms 在 500ms 间隔上触发）。
 * overall timer 作为**新增**的第三层，是纯粹的叠加，不改变原有两层的任何行为。
 * finally 统一清理全部定时器 + removeEventListener（承袭 fdb47f30 的"不 unref"教训）。
 */

import { getLogger } from "../debug/logger.ts";
import type { StreamTelemetrySignal } from "./types.ts";
import { DEFAULTS as NETWORK_DEFAULTS } from "../config/network-profile.ts";
import { recordStreamProgress } from "../trace/stream-observer.ts";
// F1 ①：可中断迭代原语（消费方 break/throw 时保证 return() 一路传到底）。
// L1：createAbortRaceInterrupt 统一 add/remove signal listener。
import { raceIterate, createAbortRaceInterrupt, type AbortRaceInterrupt } from "./race-iterate.ts";
// F1 ②③：具名超时错误 + per-request 取消的 abort reason。
// P3-3：abortReasonOf / isAbortError 用于区分「用户取消」与「lifecycle 超时」。
import {
  StreamLifecycleTimeoutError,
  STREAM_LIFECYCLE_ABORT_REASON,
  abortReasonOf,
  isAbortError,
} from "./errors.ts";
// PR9：休眠扣减下沉到流式路径（三层判据统一 `now - start - sleepPause`）。
import {
  createSleepAwareDeadline,
  startSleepObserver,
  getSleepLedger,
} from "@sid-code/shared/utils/sleep-detect.ts";

/**
 * 超时层枚举（onTimeout 回调用于区分是哪一层触发）。
 *
 * 从 `StreamLifecycleTimeoutError.layer` **派生**而不是各写一份 union：
 * 新增一层时只改错误类一处，编译期就能发现漏改（手写清单必漂移）。
 */
export type StreamTimeoutLayer = StreamLifecycleTimeoutError["layer"];

/**
 * 进程内活跃的 stream lifecycle 计数（F1 ⑤）。
 *
 * 进 `streamLifecycleImpl` +1、`finally` -1。会话空闲时应为 0 —— 不为 0 就是有
 * 生成器被丢弃且 `finally` 没跑（本会话 10 个泄漏流的形态）。
 *
 * 为什么要这个计数器：改造前同类问题**只能靠 warn.log 刷屏（4265 行里 4084 行 stall）
 * 才被发现**，而刷屏程度取决于会话活了多久，短会话里泄漏完全隐身。
 * 计数进 `heartbeat.txt` 后，一次心跳就能判死。
 */
let activeLifecycleCount = 0;

/** 当前进程内活跃的 lifecycle 生成器数（供 heartbeat.txt 落盘）。 */
export function getActiveStreamLifecycleCount(): number {
  return activeLifecycleCount;
}

/**
 * L3（2026-11-04）：**仅测试用** —— 把活跃计数归零。
 *
 * 为什么需要它：计数器是模块级、进程内的。要写「真泄漏」测试（故意丢弃生成器，
 * 让 `finally` 不执行）时，+1 不会配对 -1，会**永久抬高** baseline，污染同进程内
 * 后续所有断言（bun test 默认多文件同进程）。生产代码不应调用本函数。
 */
export function __resetActiveStreamLifecycleCountForTest(): void {
  activeLifecycleCount = 0;
}

export interface StreamLifecycleOptions<T = unknown> {
  /** Layer 1：无任何事件超时（毫秒）。超时后触发 onTimeout("idle") 中断流。必填。 */
  idleTimeoutMs: number;
  /**
   * Layer 2：业务内容进展超时（毫秒）。只在 `isContentProgress(event)` 返回 true 时重置。
   * 与 idleTimeoutMs 的关键区别：idle timer 对**任何事件**（含 ping keep-alive）都 reset，
   * 高频 ping 会永远续命 idle timer；content progress timer 只对有真内容的事件 reset，
   * 因此能识破"只有 ping、无真内容"的僵死流。不传则不启用此层（向后兼容）。
   */
  contentProgressTimeoutMs?: number;
  /**
   * Layer 1b：**首字节**超时（毫秒）——从流开始到收到第一个事件之间的专用上限。
   *
   * 为什么需要与 idleTimeoutMs 分开（2026-08-05 事故根因，主循环侧同型缺陷）：
   * idle timer 在 `resetIdle()` 首次调用时就已启动，因此「等首个事件」这段等待
   * 也被 idleTimeoutMs 管着。但这段等待的性质与「已建流后中途静默」完全不同——
   * 经网关转发时它要经历鉴权 + 排队 + 模型冷启动，实测可达 50-60s；而 idle 阈值
   * 是按「流已建立后还多久没动静才算卡死」校准的（子代理档默认仅 60s）。
   * 用同一个阈值卡两种等待，必然把「网关还在正常排队」误杀成「流已卡死」。
   *
   * 不传则退化为 idleTimeoutMs（**向后兼容**：已接入的 provider 行为完全不变）。
   */
  firstByteTimeoutMs?: number;
  /**
   * Layer 3：**单次尝试**的整体上限（毫秒）。从尝试开始计时，**不因内容事件重置**（绝对上限）。
   * 对齐官方 SDK 的 request-level timeout，覆盖"持续吐 keep-alive 或缓慢有效内容但永不结束"
   * 的盲区。不传则不启用此层。
   *
   * 「单次尝试」的边界由漏斗的控制事件给出（见 {@link classifyRetryBoundary}）：
   * `retry_backoff start` 暂停三层计时，`retry_backoff end` / `stream_restart` 起一个新尝试、
   * 三层全部重新起表。provider 内部的流不经漏斗、没有这些事件，于是本层仍是整条流的
   * 绝对上限，行为与改造前逐字节一致。
   */
  overallTimeoutMs?: number;
  /**
   * 判断一个事件是否算"业务内容进展"。仅在传了 contentProgressTimeoutMs 时使用。
   * 不传则所有事件都算进展（退化为纯 idle 保护，兼容旧行为）。
   */
  isContentProgress?: (event: T) => boolean;
  /**
   * T14.6：判定一个事件是否为"首个真实内容"（TTFT 判据）。与 isContentProgress 解耦——
   * content progress 用于 keep-alive 检测（可较宽，如含 content_block_start），
   * 而 first content 专指首个真实内容 token（各 provider 通常收敛为 content_block_delta），
   * 语义更窄以保证 TTFT 口径与迁移前一致。不传则回退到 isContentProgress。
   */
  isFirstContent?: (event: T) => boolean;
  /**
   * T14.6：TTFT 基准时间戳（ms）。首个 first-content 事件到达时，
   * 以 `Date.now() - requestStartTimeMs` 计算 ttft_ms。不传则退回 lifecycle 内部 startedAt
   * （注意：startedAt 是 createStreamLifecycle 调用时刻，通常在 headers 之后，会低估真实 TTFT；
   * 需要包含连接/首字节时延的真 TTFT 时，provider 应传入 fetch 之前的 requestStartTime）。
   */
  requestStartTimeMs?: number;
  /**
   * T14.6：首个 first-content 事件到达时回调一次（幂等，只触发一次）。
   * 入参 ttftMs = 到达时刻 - TTFT 基准时间。provider 接到此回调后 emitStreamPhase("first_content")，
   * 从而把 TTFT 追踪统一收敛到 lifecycle 层——所有接入 lifecycle 的 provider 自动获得 first_content emit。
   */
  onFirstContentProgress?: (ttftMs: number) => void;
  /**
   * P0-1：把「事件级业务进展」写进 `trace/stream-observer` 的 per-index 快照。
   *
   * 为什么必须在这一层写（不是逐 provider 补调用）：`query/loop.ts` 的 watchdog 把
   * `snapshot.lastContentProgressAt` 当作**全 provider 通用**的权威无进展判据，而
   * `updateStreamStats` 全仓原先只有 2 个调用点、都在 `openai.ts` 的 `parseSSE` 内。
   * anthropic / Responses / ollama 三条路径的快照由 `emitStreamPhase("headers_received")`
   * **建出来了**、但 `lastContentProgressAt` 恒为建快照时刻 —— 而 watchdog 只对
   * **快照缺失**有兜底（退化用 headerTimeoutMs + grace），对「快照存在却字段不刷新」
   * 没有任何兜底，于是把它当成「已收首字节、确实 N 秒无进展」直接强杀。
   * 这不是诊断能力弱，是三条路径各自带一个隐形硬顶（能力的伪装比能力的缺失更危险）。
   *
   * 修法落在 lifecycle 是因为四条路径都已包在 `createStreamLifecycle` 里，且本层
   * 本就在逐事件判 `isContentProgress` —— 在这个唯一咽喉写一次，四条路径一次全好，
   * 新增 provider 默认继承，不再是「手写清单式」修法（那种必然漏项）。
   *
   * 传值 = 该请求的 observer index（provider 侧一律取
   * `currentSseDumpContext().turnIndex`，与同路径 `emitStreamPhase` 用的是同一个）。
   * 不传则完全不写快照（side-call / 子代理流处理器等不参与 watchdog 判定的路径）。
   *
   * ⚠️ **刻意不接受 agentId**：`makeSnapshotKey` 的 agentId 是第三个维度，
   * 主循环侧与 watchdog 都是「无 agentId」调用，多传一个 id 就会拼出另一把 key，
   * 写进去也读不到（写了还不如不写：假装刷新过）。
   */
  progressObsIndex?: number;
  /** stall 告警阈值（毫秒）。超过此间隔记录 warning 但不中断。默认 30_000 */
  stallWarnMs?: number;
  /** provider / 消费点标签（日志/遥测用），如 "ANTHROPIC" | "OPENAI" | "SUB-AGENT" | "SIDE-CALL" */
  label: string;
  /**
   * 中断回调（超时触发时执行，如 abort 上游流 / reader.cancel()）。
   * 入参 layer 区分是哪一层超时触发，便于调用方按层记录不同的可观测性事件。
   */
  onTimeout?: (layer: StreamTimeoutLayer) => void;
  /** 遥测回调（流内诊断事件） */
  onTelemetry?: (event: StreamTelemetrySignal) => void;
  /** 外部 abort signal，流消费中检查以支持用户中断穿透 */
  signal?: AbortSignal;
  /**
   * F1 ③：取消**本次请求**的底层 I/O（abort per-request controller / reader 取消等）。
   *
   * 为什么 lifecycle 必须自己持有一个取消句柄：Responses / anthropic 两条路径刻意
   * **不把外部 signal 交给 lifecycle**（T7：交给它早退会破坏既有 abort 契约，见
   * anthropic.ts 同名注释），于是三层超时只能「报告」不能「执行」—— 本会话 10 次
   * `TimeoutFired` 全部开在已经被放弃的尝试上，真正的收尾全靠漏斗层。
   *
   * 与 T7 不冲突：外部 signal 仍由消费循环自己处理，本回调只取消「lifecycle 判定
   * 超时 / 消费方放弃」的那一次请求，用独立的 per-request controller。
   *
   * 调用时机：超时触发时一次、被消费方 `return()`/`throw()` 放弃时一次（幂等由本层保证）。
   */
  cancelSource?: (reason: string) => void;
}

/**
 * 流状态快照——供外层 watchdog（loop.ts:797 setInterval）只读查询，
 * 与 trace/stream-observer.ts 的 StreamSnapshot 概念对齐但更轻量（无 session 耦合）。
 */
export interface StreamLifecycleSnapshot {
  /** 标签 */
  label: string;
  /** 流开始时间戳（ms） */
  startedAt: number;
  /** 累计事件数 */
  totalEvents: number;
  /** 首个事件时间戳（ms），null 表示尚未收到 */
  firstEventAt: number | null;
  /** 最近一次任何事件时间戳（ms）——idle 判据 */
  lastEventAt: number;
  /** 最近一次业务进展事件时间戳（ms）——content progress 判据 */
  lastProgressAt: number;
  /** 是否已因超时中断 */
  timedOut: boolean;
  /** 触发过的超时层 */
  timeoutLayer: StreamTimeoutLayer | null;
}

/**
 * 超时预设配置（按场景分级：主循环宽松 / side-call 激进）。子代理不再有专属档（见下方）。
 *
 * ## 主循环档从 network BASE 派生，子代理/side-call 档**不派生**（P0-4 的连带修正）
 *
 * 配置-2 原来三档全从 `DEFAULTS.watchdogNoProgressMs` 按倍率派生，理由是"把保活优先的
 * 基准锚点收敛到单一真相源"。这个理由对**主循环档**成立（它和 watchdog 守的是同一条
 * 主链路的同一批慢流），但对另外两档是**错的耦合**：
 *
 * BASE 从 300s 抬到 720s（P0-4 的档②放宽）时，原倍率会把
 * `sideCall.overall` 60s → 144s（当时还有 `subAgent.overall` 180s → 432s）一起放大 ——
 * **方向与设计意图相反**：side-call（压缩 / 分类 / 召回）是"锦上添花、失败即静默降级"
 * 的旁路，它本就该比主链路**更激进**地放弃；让一次工具分类调用卡 144s，
 * 是把"主循环要容忍慢思考"这条理由错误地传导给了根本不该容忍的一层。
 *
 * 所以现在的形态是：
 *   - `mainLoop`：仍从 BASE 派生（与 watchdog 同源，改基准两处同步跟随，这是想要的）。
 *   - `sideCall`：**显式绝对值**，与 BASE 解耦。它们的取值依据是
 *     "这类调用多久没产出就该放弃"，与网关排队/长思考的容忍度无关。
 *     数值沿用解耦前 BASE=300s 时的实测档位（即行为不变），
 *     此后 BASE 再动也不会连带漂移。
 *
 * 派生/取值关系：
 *   mainLoop : idle 0.3×BASE / content 1.0×BASE / overall 2.0×BASE  （跟随 BASE）
 *   sideCall : idle 30s  / content 60s  / overall 60s                （固定）
 *
 * ⚠️ 哨兵 `tests/config/timeout-ladder-sentinel.test.ts` 断言 sideCall 档**不随 BASE 放大**。
 * 它红了要补清单/改这里的显式值，不是删断言。
 */
const BASE = NETWORK_DEFAULTS.watchdogNoProgressMs; // 保活优先基准（唯一真相源，仅主循环档用）
export const LIFECYCLE_PRESETS = {
  /** 主循环：大上下文/慢模型处理慢，最宽松。idle 0.3× / content 1.0× / overall 2.0× */
  mainLoop: {
    idleTimeoutMs: BASE * 0.3,
    contentProgressTimeoutMs: BASE * 1.0,
    overallTimeoutMs: BASE * 2.0,
  },
  // subAgent 档已删除（2026-10-17 PR-B 收尾）：子代理的流超时与主循环同源
  // （漏斗 fallbackStreamTimeoutMs + 单轮兜底 maxTurnDurationMs），不再有子代理专属档。
  // 它最后一个生产读者是 resilient-stream 的 side-call 缺省值，已改成那边的自有常量。
  // ⛔ 别加回来：名字叫「子代理」、实际只服务 side-call 的档位，正是 L6 那类误读的温床。
  /** side-call（recall/compact 等轻量调用）：最激进。与 BASE 解耦的显式绝对值。 */
  sideCall: {
    idleTimeoutMs: 30_000,
    contentProgressTimeoutMs: 60_000,
    overallTimeoutMs: 60_000,
  },
} as const;

/**
 * 创建流生命周期管理器。返回 `guard`（包装 AsyncIterable，注入三层超时）+
 * `getSnapshot`（供外层 watchdog 只读查询流状态）。
 *
 * 用法：
 * ```ts
 * const lc = createStreamLifecycle({ ...LIFECYCLE_PRESETS.mainLoop, label: "OPENAI",
 *   isContentProgress: (e) => e.type === "content_block_delta", signal, onTimeout, onTelemetry });
 * for await (const ev of lc.guard(rawStream)) { ... }
 * ```
 */
export function createStreamLifecycle<T>(opts: StreamLifecycleOptions<T>): {
  guard: (source: AsyncIterable<T>) => AsyncGenerator<T>;
  getSnapshot: () => StreamLifecycleSnapshot;
} {
  const now = Date.now();
  const snapshot: StreamLifecycleSnapshot = {
    label: opts.label,
    startedAt: now,
    totalEvents: 0,
    firstEventAt: null,
    lastEventAt: now,
    lastProgressAt: now,
    timedOut: false,
    timeoutLayer: null,
  };

  const guard = (source: AsyncIterable<T>) => streamLifecycleImpl(source, opts, snapshot);
  return { guard, getSnapshot: () => ({ ...snapshot }) };
}

/**
 * 漏斗控制事件 → 本层的计时动作。
 *
 * ## 为什么本层必须认这三种事件（2026-10-15，事故 20261015-114502-c596be23）
 *
 * 子代理与 compact 类 side-call 的 lifecycle 包的是**整个漏斗**（`streamWithResilience`），
 * 不是单个 HTTP 请求。改造前三层计时器把漏斗内的重试退避也算进去：
 *   - overall：上游 429 饱和时退避 6s→11s→24s→43s→86s，累计到 180.0s 子代理直接报
 *     `sub-agent stream overall timeout`，第 6 次重试还在睡就被砍 —— `maxRetries=10`
 *     又一次被时间架空（与 2026-10-12 主循环、2026-10-14 B1 同型，只是换了一个杀手）；
 *   - idle：`retry_backoff` 是首个事件，于是新尝试的「等首字节」改用 idle 档（60s）判，
 *     排队稍慢的网关在退避之后必被误杀成「流卡死」（2026-08-05 事故的同型复发路径）。
 *
 * 动作语义（三者各管一件事，与主循环 `query/stream-processor.ts` 同口径）：
 *   - `backoff_start`：漏斗主动等待，不是请求在卡 → 三层全部停表。
 *   - `attempt_start`：一次**全新请求**开始（`retry_backoff end` 或 `stream_restart`；
 *     S2 入口冷却之后没有 `stream_restart`，所以 end 也必须算） → 三层全部重新起表，
 *     idle 层回到首字节档。
 *   - `ignore`：退避期的进度提示（`system_api_error`），不算活动也不算进展。
 *
 * 判据只认 `type` 字段：provider 内部的流不会出现这三种类型，因此对它们零影响。
 */
type RetryBoundary = "backoff_start" | "attempt_start" | "ignore";

export function classifyRetryBoundary(event: unknown): RetryBoundary | null {
  if (event === null || typeof event !== "object") return null;
  const { type, phase } = event as { type?: unknown; phase?: unknown };
  if (type === "retry_backoff") return phase === "start" ? "backoff_start" : "attempt_start";
  if (type === "stream_restart") return "attempt_start";
  if (type === "system_api_error") return "ignore";
  return null;
}

/**
 * 便捷函数：直接包装一个 AsyncIterable（不需要 getSnapshot 时用）。
 * 语义与 stream-guard.ts 的 guardedStream 完全一致（idle + content + stall），
 * 额外支持 overallTimeoutMs 第三层。stream-guard.ts 将 delegate 到此实现。
 */
export async function* streamLifecycle<T>(
  source: AsyncIterable<T>,
  opts: StreamLifecycleOptions<T>,
): AsyncGenerator<T> {
  const now = Date.now();
  const snapshot: StreamLifecycleSnapshot = {
    label: opts.label,
    startedAt: now,
    totalEvents: 0,
    firstEventAt: null,
    lastEventAt: now,
    lastProgressAt: now,
    timedOut: false,
    timeoutLayer: null,
  };
  yield* streamLifecycleImpl(source, opts, snapshot);
}

/**
 * 内部实现——三层超时 + stall 告警 + signal 穿透 + 快照维护。
 * snapshot 由调用方持有引用，实现边消费边更新（供 getSnapshot 读取）。
 */
async function* streamLifecycleImpl<T>(
  source: AsyncIterable<T>,
  opts: StreamLifecycleOptions<T>,
  snapshot: StreamLifecycleSnapshot,
): AsyncGenerator<T> {
  const {
    idleTimeoutMs,
    firstByteTimeoutMs,
    contentProgressTimeoutMs,
    overallTimeoutMs,
    isContentProgress,
    isFirstContent,
    requestStartTimeMs,
    onFirstContentProgress,
    progressObsIndex,
    stallWarnMs = 30_000,
    label,
    onTimeout,
    onTelemetry,
    signal,
    cancelSource,
  } = opts;
  const log = getLogger();
  const providerTag = label.toLowerCase();

  // 只有同时传了阈值 + 判定函数才启用 content progress 层（与 stream-guard.ts 一致）。
  const contentProgressEnabled =
    typeof contentProgressTimeoutMs === "number" &&
    contentProgressTimeoutMs > 0 &&
    typeof isContentProgress === "function";
  const overallEnabled = typeof overallTimeoutMs === "number" && overallTimeoutMs > 0;

  const streamStartTime = snapshot.startedAt;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  let overallTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (contentTimer) {
      clearTimeout(contentTimer);
      contentTimer = null;
    }
    if (overallTimer) {
      clearTimeout(overallTimer);
      overallTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
  };

  /**
   * F1 ③：取消本次请求的底层 I/O（幂等）。
   *
   * 两个调用点：超时（`fireTimeout`，语义是「立即取消」）与「消费方放弃」
   *（`finally` 里源还没结束）。真正让挂起的 `reader.read()` 变成 reject 的是
   * `cancelSource`，不是 `iterator.return()` —— 后者在源头卡死时自己也不会 resolve
   *（已实测，见 race-iterate.ts 文件头），所以两件事必须都做。
   */
  let sourceCancelled = false;
  const cancelSourceOnce = (reason: string = STREAM_LIFECYCLE_ABORT_REASON): void => {
    if (sourceCancelled) return;
    sourceCancelled = true;
    try {
      cancelSource?.(reason);
    } catch {
      /* 取消底层 I/O 失败不影响退出路径 */
    }
  };

  /**
   * F1 ②：超时中断源。
   *
   * 改造前 `fireTimeout` 只置 `snapshot.timedOut = true`，而这个标志只在**两次迭代之间**
   * 被检查（原来的循环开头与 yield 之后各一次）—— 源头 `reader.read()` 不 settle 时
   * 循环根本出不来，三层超时对 Responses / anthropic 两条路径**只能报告不能执行**。
   * 这里给迭代 race 提供一个只 reject 的中断源，定时器一开火就打断 `await`。
   */
  let rejectTimeoutInterrupt: ((err: unknown) => void) | null = null;
  const timeoutInterrupt = new Promise<never>((_, reject) => {
    rejectTimeoutInterrupt = reject;
  });
  // 超时可能落在「没有 race 正在等」的时刻（消费方正在处理上一个事件、或已 yield 出去）：
  // 那时这个 reject 没有任何订阅者 → unhandledRejection → 进程可能被带走。
  // 挂一个空 catch 只是把它标记为「已处理」，`Promise.race` 对原 promise 的订阅不受影响。
  void timeoutInterrupt.catch(() => {});
  /** 已触发的超时错误（供「迭代间隙」的检查点原样抛出，阈值取自真实触发的那一层）。 */
  let timeoutError: StreamLifecycleTimeoutError | null = null;

  const fireTimeout = (layer: StreamTimeoutLayer, thresholdMs: number): boolean => {
    if (snapshot.timedOut) return false; // 只触发一次：任何一层先触发后，其余层不再回调
    snapshot.timedOut = true;
    snapshot.timeoutLayer = layer;
    // F1 ④：已被判超时的流不再报「事件间隔 Ns」—— 一个死流的心跳间隔没有任何信息量，
    // 而它会让 warn.log 被永久刷屏（本会话 4265 行里 4084 行是这种，最大间隔 43933s）。
    // 这不是用来兜底泄漏的：①②③ 修好后 finally 一定会跑；这是纯粹的语义修正。
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
    // F1 ②：打断 await 中的 reader.read()。
    timeoutError = new StreamLifecycleTimeoutError(layer, thresholdMs);
    rejectTimeoutInterrupt?.(timeoutError);
    // F1 ③：超时的语义是「立即取消」，不等 finally —— 源头卡死时 return() 也传不下去。
    cancelSourceOnce();
    return true;
  };

  // 首字节阈值：未显式指定时退化为 idleTimeoutMs（向后兼容，已接入 provider 行为不变）。
  const effectiveFirstByteMs =
    typeof firstByteTimeoutMs === "number" && firstByteTimeoutMs > 0
      ? firstByteTimeoutMs
      : idleTimeoutMs;

  // ─── PR9：三层判据统一扣除休眠（`now - start - sleepPause`）───
  //
  // 三层用的都是一次性 `setTimeout`，而 `setTimeout` 在系统休眠后是**唤醒即补发** ——
  // "定时器 fire 了"不等于"真的过了那么久"。轨迹实证一次 281s 的休眠让 fallback 层
  // 杀掉了真实无进展仅 3.4s 的健康流；本层三个定时器同型（改造前 `sleepPause` 在
  // fallback / lifecycle / parseSSE 三处 grep 命中均为 0，那就是这条缺陷的判据）。
  //
  // 修法：每层各自持有一个休眠感知 deadline，回调里先问 `remainingMs()`——
  // >0 说明是休眠补发的一枪，**重排而非开枪**。定时器形态刻意不动
  // （不改成 setInterval 轮询）：本文件顶部"行为等价铁律"要求 idle/content timer
  // 保持 setTimeout 的语义与精度，既有单测依赖细粒度定时（idle=100ms 在 500ms 间隔上触发）。
  // idle 层不建 deadline 对象：它的窗口长度在"等首字节"与"已建流"两档之间切换
  // （effectiveFirstByteMs vs idleTimeoutMs），而 deadline 是按固定 timeoutMs 建的。
  // 该层在 resetIdle 内就地记窗口起点 + 读账本增量，见那里的注释。
  const contentDeadline = contentProgressEnabled
    ? createSleepAwareDeadline(contentProgressTimeoutMs!)
    : null;
  const overallDeadline = overallEnabled ? createSleepAwareDeadline(overallTimeoutMs!) : null;
  const releaseSleepObserver = startSleepObserver();

  // 本次**尝试**是否还在等首个事件。不复用 snapshot.firstEventAt：那个字段是整条流的
  // TTFT 口径（finally 里报 ttftMs），而首字节档要按尝试重新武装 —— 退避之后的新请求
  // 同样要经历网关鉴权 + 排队，用 idle 档卡它就是 2026-08-05 的误杀复发。
  let attemptAwaitingFirstEvent = true;
  // 漏斗退避中：三层停表，stall 告警也不报（主动等待不是 stall）。
  let inBackoff = false;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    snapshot.lastEventAt = Date.now();
    // 本次尝试的首个事件尚未到达 → 用（通常更宽的）首字节阈值；到达后各次 reset 用 idle 阈值。
    const awaitingFirst = attemptAwaitingFirstEvent;
    const limit = awaitingFirst ? effectiveFirstByteMs : idleTimeoutMs;
    // PR9：本层 deadline 的窗口长度是 `limit`（首字节档与 idle 档不同值），
    // 而 createSleepAwareDeadline 是按固定 timeoutMs 建的 —— 所以这里自己记窗口起点，
    // 用账本的增量做扣减，不复用 idleDeadline 的 timeoutMs。
    const armedAt = Date.now();
    const sleptAtArm = getSleepLedger().getTotalMs();
    const arm = (delayMs: number) => {
      idleTimer = setTimeout(() => {
        const slept = Math.max(0, getSleepLedger().getTotalMs() - sleptAtArm);
        const remaining = limit - (Date.now() - armedAt - slept);
        if (remaining > 0) {
          log.warn(
            `LLM:${label}`,
            `idle 定时器被休眠补发（已剔除 ${(slept / 1000).toFixed(0)}s），` +
              `距真正到期还有 ${(remaining / 1000).toFixed(0)}s，重排而非中断`,
          );
          arm(remaining);
          return;
        }
        if (!fireTimeout("idle", limit)) return;
        log.warn(
          `LLM:${label}`,
          `流式${awaitingFirst ? "首字节" : "空闲"}超时 ${limit / 1000}s，中断`,
          { totalEvents: snapshot.totalEvents },
        );
        onTelemetry?.({
          type: "stream_idle_timeout",
          provider: providerTag,
          timeoutMs: limit,
          totalEvents: snapshot.totalEvents,
        });
        onTimeout?.("idle");
      }, delayMs);
    };
    arm(limit);
  };

  /**
   * P0-1：把本层的进展事实同步给 `trace/stream-observer` 的 per-index 快照。
   *
   * 只在传了 `progressObsIndex` 时才写（不传即完全不碰快照），因此 side-call /
   * 子代理流处理器这些不参与主循环 watchdog 判定的路径行为逐字节不变。
   * 写入本身在 recordStreamProgress 内 try-catch 静默，可观测性绝不影响流。
   */
  const publishProgressToObserver = () => {
    if (progressObsIndex === undefined) return;
    recordStreamProgress(progressObsIndex, {
      at: Date.now(),
      eventCount: snapshot.totalEvents,
    });
  };

  // content progress timer——独立于 idle timer，只在业务内容到达时重置。
  // ping / message_start 等 keep-alive 事件不会重置它。
  const resetContentProgress = () => {
    if (!contentProgressEnabled) return;
    if (contentTimer) clearTimeout(contentTimer);
    snapshot.lastProgressAt = Date.now();
    // PR9：休眠补发的一枪要重排（理由见上方三层判据的总注释）。
    contentDeadline!.restart();
    const armContent = (delayMs: number) => {
      contentTimer = setTimeout(() => {
        const remaining = contentDeadline!.remainingMs();
        if (remaining > 0) {
          log.warn(
            `LLM:${label}`,
            `content-progress 定时器被休眠补发（已剔除 ${(contentDeadline!.sleepMs() / 1000).toFixed(0)}s），` +
              `距真正到期还有 ${(remaining / 1000).toFixed(0)}s，重排而非中断`,
          );
          armContent(remaining);
          return;
        }
        if (!fireTimeout("content_progress", contentProgressTimeoutMs!)) return;
        log.warn(
          `LLM:${label}`,
          `业务内容进展超时 ${contentProgressTimeoutMs! / 1000}s（可能只有 keep-alive/ping，无实际内容），中断`,
          { totalEvents: snapshot.totalEvents },
        );
        onTelemetry?.({
          type: "stream_content_progress_timeout",
          provider: providerTag,
          timeoutMs: contentProgressTimeoutMs!,
          totalEvents: snapshot.totalEvents,
        });
        onTimeout?.("content_progress");
      }, delayMs);
    };
    armContent(contentProgressTimeoutMs!);
  };

  // overall timer——单次尝试的整体上限，从尝试开始计时，**不因内容事件重置**。
  // 注意"不因事件重置"≠"不扣休眠"：绝对上限说的是"业务时间的绝对上限"，
  // 而机器睡觉的那段不是业务时间（同 loop.ts 的 turn_hard 从 businessElapsedMs 里
  // 扣 sleepPause 的口径）。休眠 939s 的历史记录足以击穿任何固定绝对值。
  // 只在尝试边界（见 classifyRetryBoundary）重新起表；退避期间不计。
  const startOverall = () => {
    if (!overallEnabled) return;
    if (overallTimer) clearTimeout(overallTimer);
    overallDeadline!.restart();
    const armOverall = (delayMs: number) => {
      overallTimer = setTimeout(() => {
        const remaining = overallDeadline!.remainingMs();
        if (remaining > 0) {
          log.warn(
            `LLM:${label}`,
            `overall 定时器被休眠补发（已剔除 ${(overallDeadline!.sleepMs() / 1000).toFixed(0)}s），` +
              `距真正到期还有 ${(remaining / 1000).toFixed(0)}s，重排而非中断`,
          );
          armOverall(remaining);
          return;
        }
        if (!fireTimeout("overall", overallTimeoutMs!)) return;
        log.warn(
          `LLM:${label}`,
          `流式整体超时 ${overallTimeoutMs! / 1000}s（请求级硬上限），中断`,
          {
            totalEvents: snapshot.totalEvents,
          },
        );
        onTelemetry?.({
          type: "stream_overall_timeout",
          provider: providerTag,
          timeoutMs: overallTimeoutMs!,
          totalEvents: snapshot.totalEvents,
        });
        onTimeout?.("overall");
      }, delayMs);
    };
    armOverall(overallTimeoutMs!);
  };

  // stall 心跳：每 stallWarnMs 检查一次，如果期间无事件则告警（只记不杀）。
  stallTimer = setInterval(() => {
    if (inBackoff) return;
    const gap = Date.now() - snapshot.lastEventAt;
    if (gap >= stallWarnMs) {
      log.warn(`LLM:${label}`, `事件间隔 ${(gap / 1000).toFixed(0)}s（stall）`, {
        totalEvents: snapshot.totalEvents,
      });
      onTelemetry?.({
        type: "stream_stall",
        provider: providerTag,
        gapMs: gap,
        totalEvents: snapshot.totalEvents,
      });
    }
  }, stallWarnMs);

  // T14.6：first-content 只触发一次的幂等标记
  let firstContentFired = false;

  // F1 ③：源是否**正常结束**。消费方 break/throw 导致离开时为 false，
  // finally 据此决定是否取消底层 I/O（正常收尾不需要取消）。
  let sourceExhausted = false;

  resetIdle();
  resetContentProgress(); // 启动 content progress 计时（未启用时空转）
  startOverall(); // 启动 overall 计时（未启用时空转）
  // F1 ⑤ / P3-2：活跃 lifecycle 计数（进入 +1，finally -1）。会话空闲时应为 0。
  //
  // ++ 放在 try **之前**，与 finally 的 -- 严格配对。改造前用
  // `Math.max(0, activeLifecycleCount - 1)` 兜底，这会把「多减一次」静默吞掉 ——
  // 而这是一个泄漏哨兵，掩盖不配对等于让它失去意义。
  activeLifecycleCount++;
  /** L1：signal 中断源（含 listener 释放）。try 外声明，finally 统一 dispose。 */
  let abortInterrupt: AbortRaceInterrupt | null = null;
  try {
    // P0-2 §7.3：signal 早退仍由中断源提供（与改造前同一语义）。
    // L1：用 createAbortRaceInterrupt 统一 add/remove —— 正常结束也必须移除 listener
    //（AbortSignal 是 EventTarget 不是 EventEmitter，没有 MaxListeners 警告，
    // 长会话线性累积且完全静默，只能靠 heap snapshot 看出来）。
    abortInterrupt = createAbortRaceInterrupt(
      signal,
      () => new Error("Stream aborted (lifecycle abort race)"),
    );

    // F1 ①②：两个中断源 —— 超时（本轮新增）与外部 signal（既有语义）。
    // 消费方丢弃本生成器时，raceIterate 的 finally 会 `return()` 源头，
    // 源头的 finally 也就能执行（改造前这条链一断到底，所有 finally 都不跑）。
    const interrupts: Promise<never>[] = [timeoutInterrupt];
    if (abortInterrupt.interrupt) interrupts.push(abortInterrupt.interrupt);

    for await (const event of raceIterate(source, { interrupts })) {
      // 超时若在「事件已取到、尚未处理」之间触发：以带类型的错误结束。
      // 不 break —— break 对下游表现为「流正常结束」，有内容时漏斗会把它当成功
      //（`markHealthy` + return），超时被伪装成最不该的一种状态。
      if (timeoutError) throw timeoutError;
      // signal 纵深防御：流消费中检查 signal，支持用户中断穿透。
      // 用 return 而不是 break：break 之后会执行到循环外的 `sourceExhausted = true`，
      // 把一次主动放弃误记成「源已正常结束」。
      if (signal?.aborted) return;
      // 漏斗控制事件：只改计时，不算活动、不算进展、不计入 TTFT（见 classifyRetryBoundary）。
      const boundary = classifyRetryBoundary(event);
      if (boundary !== null) {
        if (boundary === "backoff_start") {
          inBackoff = true;
          // 停表而不是标记：定时器若还挂着，退避睡到一半它照样开枪。
          // stall interval 留着，靠 inBackoff 静音（它还要管退避结束后的告警）。
          if (idleTimer) clearTimeout(idleTimer);
          if (contentTimer) clearTimeout(contentTimer);
          if (overallTimer) clearTimeout(overallTimer);
          idleTimer = contentTimer = overallTimer = null;
        } else if (boundary === "attempt_start") {
          inBackoff = false;
          attemptAwaitingFirstEvent = true;
          resetIdle();
          resetContentProgress();
          startOverall();
        }
        yield event;
        continue;
      }
      snapshot.totalEvents++;
      if (snapshot.firstEventAt === null) snapshot.firstEventAt = Date.now();
      attemptAwaitingFirstEvent = false;
      // idle timer 对任何事件都 reset（保护"TCP 连接彻底断开"场景，含 ping）
      resetIdle();
      // 「这个事件算不算业务进展」——本层的判据只有一份，两个消费方共用：
      // ① content progress timer 重排（仅在该层启用时）；
      // ② P0-1 写 observer 快照（**与该层是否启用无关**）。
      //
      // ⚠️ 两者必须解耦，这正是原缺陷的形状：openai Chat Completions 路径**没传**
      // contentProgressTimeoutMs（它依赖 parseSSE 的字节级 content 超时，见
      // `openai.ts:1066-1071` 的注释），于是 contentProgressEnabled 恒 false。
      // 若把快照写入挂在 `contentProgressEnabled &&` 后面，主循环最常用的那条路径
      // 一个字节都不会写 —— 修了三条路径、漏掉出问题的那条。
      //
      // 不传 isContentProgress 时退化为「所有事件都算进展」，与
      // `isContentProgress` 选项自身的文档语义一致（见其注释）。
      const isProgressEvent = isContentProgress ? isContentProgress(event) : true;
      // content progress timer 只对"业务进展"事件 reset（ping 不续命）
      if (contentProgressEnabled && isProgressEvent) {
        resetContentProgress();
      }
      if (isProgressEvent) publishProgressToObserver();
      // T14.6：首个 first-content 事件到达时回调一次（幂等）。
      // isFirstContent 不传则回退 isContentProgress；两者都不传则首个事件即触发。
      if (onFirstContentProgress && !firstContentFired) {
        const predicate = isFirstContent ?? isContentProgress ?? (() => true);
        if (predicate(event)) {
          firstContentFired = true;
          const baseTime = requestStartTimeMs ?? snapshot.startedAt;
          const ttftMs = Date.now() - baseTime;
          try {
            onFirstContentProgress(ttftMs);
          } catch {
            /* 回调异常不影响流 */
          }
        }
      }
      yield event;
    }
    // 只有源正常结束（for-await 自然退出）才会执行到这一行。
    // signal abort / 超时 / 消费方 throw 都会跳过它（前两者 return/throw，后者穿到 catch）。
    sourceExhausted = true;
  } catch (e) {
    // 保持改造前的 catch 边界：只有「abort race 主动 reject 且 signal 已 abort」才静默退出；
    // source 抛出的真实错误（parseSSE 字节级超时、网络错误）与 lifecycle 自己的超时错误
    // 必须原样抛出，否则会把超时/错误吞成「流正常结束」。
    if (e instanceof StreamLifecycleTimeoutError) throw e;
    if (signal?.aborted) return;
    throw e;
  } finally {
    // L1：正常结束 / 异常退出都要移除 signal 上的 abort listener。
    // `{ once: true }` 只在 abort 真的发生时自动移除，正常完成的请求（绝大多数）
    // 原先会永久留下一个 listener —— EventTarget 没有 MaxListeners 警告，完全静默。
    abortInterrupt?.dispose();
    clearTimers();
    // PR9：释放休眠观测器引用（引用计数归零才真的停 interval）。
    releaseSleepObserver();
    // F1 ⑤ / P3-2：与 try 前的 +1 严格配对（不再用 Math.max 兜底掩盖不配对）。
    // 生成器被丢弃且 finally 没跑时这里不会执行 —— 那正是「活跃计数不为 0」要
    // 暴露的泄漏形态。
    activeLifecycleCount--;
    // F1 ③：消费方 break/throw 放弃、而源还没结束时，取消底层 I/O。
    // 正常结束（sourceExhausted）不取消：请求已经完成，再 abort 只是给一个
    // 不存在的问题制造噪音。
    //
    // P3-3：外部 signal 已 abort 时用它的真实 reason（仅白名单内才采信，否则回落
    // "user-cancel"），避免把「用户 ESC」标成 "stream-lifecycle-timeout" ——
    // 后者会让只看 abort reason 的归因把用户取消读成 lifecycle 超时。
    if (!sourceExhausted) {
      const externalReason = signal?.aborted ? abortReasonOf(signal.reason) : undefined;
      cancelSourceOnce(
        externalReason && isAbortError(externalReason)
          ? externalReason
          : signal?.aborted
            ? "user-cancel"
            : STREAM_LIFECYCLE_ABORT_REASON,
      );
    }
    const elapsedMs = Date.now() - streamStartTime;
    const ttftMs = snapshot.firstEventAt ? snapshot.firstEventAt - streamStartTime : undefined;
    log.debug(`LLM:${label}`, `流结束`, { totalEvents: snapshot.totalEvents, elapsedMs, ttftMs });
    onTelemetry?.({
      type: "stream_completed",
      provider: providerTag,
      totalEvents: snapshot.totalEvents,
      elapsedMs,
      ttftMs,
      // P3-1：超时已触发但消费方在「事件处理中」主动 break 时，超时错误没有机会抛给
      // 消费方（生成器在 yield 处收到 return completion，直接走 finally，不经过循环体
      // 开头的 `if (timeoutError) throw`）。此时 onTimeout 已回调、TimeoutFired 已发出，
      // 但流以「正常结束」呈现 —— 这个字段让下游能把「超时结束」与「真正常结束」分开，
      // 不必靠时间窗倒推。
      ...(snapshot.timedOut ? { timedOut: true } : {}),
      // /perf PR-A（A3）：源没有正常耗尽、也不是超时 —— 被消费方放弃（用户 ESC 后消费循环 throw、
      // fork 墙钟 abort、源报错后上层弃流）。此前事件上分不出「源耗尽」与「被打断」
      // （sourceExhausted 是局部变量），被打断那条的 elapsedMs 进了生成耗时分位数与 tok/s 分母。
      // ⚠️ 判据不能用 `signal?.aborted`：三个 provider 都刻意不把外部 signal 交给 lifecycle
      // （T7，见 anthropic.ts 同名注释），那样写在生产里恒为假、字段永远落不下来。
      // 只在未正常结束时落字段，正常结束不落 —— 与 timedOut 同风格；超时由 timedOut 表达，不重复。
      ...(!sourceExhausted && !snapshot.timedOut ? { aborted: true } : {}),
    });
  }
}
