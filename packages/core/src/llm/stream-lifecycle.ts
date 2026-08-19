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
 *   Layer 3  overall timeout       —— 整个请求从开始超过硬上限 → 中断（对齐官方 SDK request timeout）
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

/** 超时层枚举（onTimeout 回调用于区分是哪一层触发） */
export type StreamTimeoutLayer = "idle" | "content_progress" | "overall";

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
   * Layer 3：请求级整体超时（毫秒）。从流开始计时，**不因任何事件重置**（绝对上限）。
   * 对齐官方 SDK 的 request-level timeout，覆盖"持续吐 keep-alive 或缓慢有效内容但永不结束"
   * 的盲区。不传则不启用此层。
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
 * 三层超时预设配置（按场景分级：主循环宽松 / 子代理适中 / side-call 激进）。
 *
 * 配置-2：基准量级从 network-profile 的统一默认值 `DEFAULTS.watchdogNoProgressMs`（BASE=300s）
 * 派生，不再是独立硬编码字面量——把"保活优先"的基准锚点收敛到单一真相源，改基准只需改
 * network-profile 一处，三档同步跟随。**分级比例（tiering policy）**留在本层，因为"主循环 vs
 * 子代理 vs side-call 谁该更激进"是 lifecycle 的职责，与网络超时基准是两个正交维度。
 *
 * 派生关系（相对 BASE=watchdogNoProgressMs 的倍率，与迁移前既有实测值一一对应）：
 *   mainLoop : idle 0.3× (90s)  / content 1.0× (5min)  / overall 2.0× (10min)
 *   subAgent : idle 0.2× (60s)  / content 0.6× (3min)  / overall 0.6× (3min)
 *   sideCall : idle 0.1× (30s)  / content 0.2× (60s)   / overall 0.2× (60s)
 */
const BASE = NETWORK_DEFAULTS.watchdogNoProgressMs; // 300_000（保活优先基准，唯一真相源）
export const LIFECYCLE_PRESETS = {
  /** 主循环：大上下文/慢模型处理慢，最宽松。idle 0.3× / content 1.0× / overall 2.0× */
  mainLoop: {
    idleTimeoutMs: BASE * 0.3,
    contentProgressTimeoutMs: BASE * 1.0,
    overallTimeoutMs: BASE * 2.0,
  },
  /** 子代理：应比主循环短。idle 0.2× / content 0.6× / overall 0.6× */
  subAgent: {
    idleTimeoutMs: BASE * 0.2,
    contentProgressTimeoutMs: BASE * 0.6,
    overallTimeoutMs: BASE * 0.6,
  },
  /** side-call（recall/compact 等轻量调用）：最激进。idle 0.1× / content 0.2× / overall 0.2× */
  sideCall: {
    idleTimeoutMs: BASE * 0.1,
    contentProgressTimeoutMs: BASE * 0.2,
    overallTimeoutMs: BASE * 0.2,
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

  const fireTimeout = (layer: StreamTimeoutLayer): boolean => {
    if (snapshot.timedOut) return false; // 只触发一次：任何一层先触发后，其余层不再回调
    snapshot.timedOut = true;
    snapshot.timeoutLayer = layer;
    return true;
  };

  // 首字节阈值：未显式指定时退化为 idleTimeoutMs（向后兼容，已接入 provider 行为不变）。
  const effectiveFirstByteMs =
    typeof firstByteTimeoutMs === "number" && firstByteTimeoutMs > 0
      ? firstByteTimeoutMs
      : idleTimeoutMs;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    snapshot.lastEventAt = Date.now();
    // 首个事件尚未到达 → 用（通常更宽的）首字节阈值；到达后各次 reset 用 idle 阈值。
    // 判据取 snapshot.firstEventAt：它在主循环收到首个事件时置值，是本层唯一的结构事实。
    const limit = snapshot.firstEventAt === null ? effectiveFirstByteMs : idleTimeoutMs;
    idleTimer = setTimeout(() => {
      if (!fireTimeout("idle")) return;
      log.warn(
        `LLM:${label}`,
        `流式${snapshot.firstEventAt === null ? "首字节" : "空闲"}超时 ${limit / 1000}s，中断`,
        { totalEvents: snapshot.totalEvents },
      );
      onTelemetry?.({
        type: "stream_idle_timeout",
        provider: providerTag,
        timeoutMs: limit,
        totalEvents: snapshot.totalEvents,
      });
      onTimeout?.("idle");
    }, limit);
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
    contentTimer = setTimeout(() => {
      if (!fireTimeout("content_progress")) return;
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
    }, contentProgressTimeoutMs!);
  };

  // overall timer——请求级整体上限，从流开始计时，**不因任何事件重置**。
  const startOverall = () => {
    if (!overallEnabled) return;
    overallTimer = setTimeout(() => {
      if (!fireTimeout("overall")) return;
      log.warn(`LLM:${label}`, `流式整体超时 ${overallTimeoutMs! / 1000}s（请求级硬上限），中断`, {
        totalEvents: snapshot.totalEvents,
      });
      onTelemetry?.({
        type: "stream_overall_timeout",
        provider: providerTag,
        timeoutMs: overallTimeoutMs!,
        totalEvents: snapshot.totalEvents,
      });
      onTimeout?.("overall");
    }, overallTimeoutMs!);
  };

  // stall 心跳：每 stallWarnMs 检查一次，如果期间无事件则告警（只记不杀）。
  stallTimer = setInterval(() => {
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

  resetIdle();
  resetContentProgress(); // 启动 content progress 计时（未启用时空转）
  startOverall(); // 启动 overall 计时（未启用时空转）
  try {
    // P0-2 §7.3 修复：与 fallback.ts/stream-processor.ts 同理，将 for-await 改为
    // 手动迭代 + Promise.race(abortPromise)。当 source（SDK raw stream）半开时，
    // reader.read() 永不 settle，signal?.aborted / snapshot.timedOut 检查永远执行不到。
    // 通过 race signal + timedOut，超时/abort 触发时立即退出。
    const abortPromise: Promise<never> | null = (() => {
      if (!signal || signal.aborted) return null;
      return new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error("Stream aborted (lifecycle abort race)"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
    })();

    const iterator = source[Symbol.asyncIterator]();
    let iterDone = false;
    while (!iterDone) {
      if (snapshot.timedOut) break;
      if (signal?.aborted) break;
      const racers: Promise<IteratorResult<T>>[] = [iterator.next()];
      if (abortPromise) racers.push(abortPromise as any);
      let iterResult: IteratorResult<T>;
      try {
        iterResult = await Promise.race(racers);
      } catch (e) {
        // 关键：只有"abort race 主动 reject"才静默退出；source 抛出的真实错误
        // （如 parseSSE 字节级超时、网络错误）必须原样抛出，保持与旧 for-await 一致的语义，
        // 否则会把超时/错误吞成"流正常结束"。
        if (signal?.aborted) break;
        throw e;
      }
      if (iterResult.done) {
        iterDone = true;
        break;
      }
      const event = iterResult.value;

      if (snapshot.timedOut) break;
      // signal 纵深防御：流消费中检查 signal，支持用户中断穿透
      if (signal?.aborted) break;
      snapshot.totalEvents++;
      if (snapshot.firstEventAt === null) snapshot.firstEventAt = Date.now();
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
  } finally {
    clearTimers();
    const elapsedMs = Date.now() - streamStartTime;
    const ttftMs = snapshot.firstEventAt ? snapshot.firstEventAt - streamStartTime : undefined;
    log.debug(`LLM:${label}`, `流结束`, { totalEvents: snapshot.totalEvents, elapsedMs, ttftMs });
    onTelemetry?.({
      type: "stream_completed",
      provider: providerTag,
      totalEvents: snapshot.totalEvents,
      elapsedMs,
      ttftMs,
    });
  }
}
