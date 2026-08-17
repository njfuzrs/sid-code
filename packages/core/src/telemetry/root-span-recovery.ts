/**
 * 会话根 span 的启动期重建（三方对比差距清单 §三 P0-2 · PR3）
 *
 * ## 缺陷
 *
 * `SpanHandle.end()` 才把 span 推进队列（`bus.ts:101`），而会话根
 * `invoke_agent` 的 `end()` 只在 `handleSessionEnd`（`hook-probe.ts`）里调。
 * 于是根 span 在「会话正常结束」这个**最不可靠的时刻**才落盘：
 *
 *   实测 `SessionStart 50 : SessionEnd 23` —— **54% 的会话没有 SessionEnd**；
 *   退出状态 `31 end_turn / 11 unknown / 6 error / …` —— 39% 不是正常收尾。
 *   第二道门是 `TELEMETRY_FLUSH_TIMEOUT_MS = 500`
 *   （`packages/shared/src/utils/graceful-shutdown.ts:13`）。
 *
 * 可观测性最需要看的恰好是没正常结束的那些会话，而它们恰好一个根都没有。
 *
 * ## 为什么是「重建」而不是「提前 enqueue」
 *
 * 方案 A（SessionStart 就 enqueue 一个「进行中」的根，SessionEnd 再更新）要求
 * exporter 支持 span 更新（JSONL 是 append-only、OTLP 已导出的 span 不可改），
 * 而且**覆盖不了 kill -9 / OOM** —— 那时根本没有「后续更新」这一步。
 *
 * 方案 B（本模块）照抄 `trace/cost-recompute.ts` 的形态：运行时不落，
 * **下次启动扫描上一会话的 `events.jsonl` 重建**。cost 同样依赖 SessionEnd，
 * 但靠这个思路在 54% 缺 SessionEnd 的情况下做到了 100% 覆盖 —— 结论是
 * **不要让 SessionEnd 更可靠，要让根 span 不依赖它**。
 *
 * ## 为什么必须持久化「身份」，不能只靠 events.jsonl 重建
 *
 * 这是本模块与 cost 重算最关键的差别，也是 PR3 的实现要点：
 *
 * `events.jsonl` 里**没有任何 span 身份**（没有 traceId / spanId）。而子 span
 * （chat / execute_tool）在运行时已经把**运行时那个根的 spanId** 写成了自己的
 * `parentSpanId` 并落盘了 —— 实测 `traces.jsonl` 里 680 个 `parentSpanId` 解析不到
 * 父，就是这么来的。
 *
 * 所以如果只从 events 重建、给根一个新生成的 spanId，结果是：孤儿子 span 照旧悬空，
 * 盘上再多一个谁也不挂的根 —— PR2 的判据①（每棵树恰好一个根）和判据②（无悬空父）
 * **依然全红**，而「根 span 数 != 0」这种旧判据会显示已修复。这正是本文两次栽过的坑。
 *
 * 因此 SessionStart 时同步落一个**只含身份**的极小标记文件
 * （traceId / spanId / startTime / 初始属性），语义是「这个根还欠一次 end」：
 *
 * - 会话正常收尾 → `handleSessionEnd` 里 span 照常 `end()` 入队，**当场删标记**，
 *   本模块下次启动无事可做（正常路径零成本、零重复落盘）。
 * - 会话被杀 / OOM / 超时刷不完 → 标记残留，下次启动据 `events.jsonl` 补齐
 *   属性（轮次 / model / cost / token / 退出归因）后用**原 traceId + 原 spanId**
 *   落盘 —— 那些悬空的子 span 当场接回树上。
 *
 * ## 退出归因复用现成设施
 *
 * `trace/crash-marker.ts` 已导出 `isTerminalDeathSnapshot()`：用户关终端引发的
 * EIO/EPIPE **不是崩溃**，不能把它算成 error 状态（否则「崩溃率」里混进
 * 「用户正常关窗口」）。这里直接用它，不另写一份判据。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { ATTR } from "./types.ts";
import type { Attributes, SpanData } from "./types.ts";

/**
 * 「这个根 span 还欠一次 end」的标记。
 *
 * 刻意只存**身份 + 起点**，不存任何运行时会变的统计值：统计值由 `events.jsonl`
 * 提供（它是 append 语义、崩溃安全），标记里再存一份只会两处不一致。
 */
export interface PendingRootSpanMarker {
  /**
   * **轨迹会话 id**，即 `trajectories/sessions/<这个值>/` 的目录名。
   *
   * resume 续接时它是 `resumed_from`（被恢复的旧 id）而非本进程 id ——
   * 与 `collector.ts:handleSessionStart` 的 `traceSessionId` 必须同口径，
   * 否则重建时按新 id 去找 events.jsonl 会找不到目录、静默退化成「无素材」。
   */
  session_id: string;
  /** 原始 traceId：子 span 已按它落盘，重建必须沿用 */
  trace_id: string;
  /** 原始 spanId：子 span 的 parentSpanId 指的就是它，重建必须沿用 */
  span_id: string;
  /** span 名，形如 `invoke_agent <model>` */
  name: string;
  /** 根 span 起始时间（Unix 毫秒） */
  start_time: number;
  /** SessionStart 时的初始属性（cwd / model / conversation.id / enricher 产出等） */
  attributes: Attributes;
  /**
   * 写标记的进程 pid。
   *
   * 用途是**避免抢正在运行的会话**：多开终端是常态，扫到别人的标记时若那个进程还活着，
   * 它自己会在退出时把根 span 落好并删标记，这里插一手就成了重复落盘。
   */
  pid: number;
}

/** 一次启动期重建的结果 */
export interface RootSpanRecoveryResult {
  /** 成功重建并入队的根 span 数 */
  recovered: number;
  /** 因进程仍存活而跳过的标记数 */
  skippedAlive: number;
  /** 因过期（超出保留期且无素材）而删除的标记数 */
  pruned: number;
}

/** 标记文件目录：`~/.sid-code/telemetry/pending-root-spans/` */
export function pendingRootSpanDir(): string {
  return join(sidPaths.telemetry(), "pending-root-spans");
}

/**
 * session id → 标记文件路径。
 *
 * 文件名做白名单化：session id 正常形如 `20260812-143454-1f445b50`，但它有一条
 * 来自 hook 载荷 / resume 参数的外部路径，不能直接拼进文件名（`../` 会写出目录外）。
 */
export function pendingRootSpanPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(pendingRootSpanDir(), `${safe}.json`);
}

/**
 * 同步落标记。
 *
 * 同步写的理由与 `crash-marker.ts:write` 一致：调用点之后随时可能被 kill -9，
 * 异步写会被事件循环裁剪掉。标记只有几百字节，同步开销可忽略。
 *
 * 绝不抛异常 —— 采集设施不能成为新的故障点。
 */
export function writePendingRootSpan(marker: PendingRootSpanMarker): boolean {
  try {
    const dir = pendingRootSpanDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(pendingRootSpanPath(marker.session_id), JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

/**
 * 删标记 —— 根 span 已经正常 `end()` 入队，不需要重建了。
 *
 * 幂等：文件不存在也算成功（会话可能压根没写出标记，比如目录不可写）。
 */
export function clearPendingRootSpan(sessionId: string): void {
  try {
    const p = pendingRootSpanPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* 清理失败不是故障：下次启动重建一遍，代价是一个重复的根 span，不是数据损坏 */
  }
}

/** 从 events.jsonl 提取出的重建素材 */
interface EventsMaterial {
  /** BeforeModel 计数 —— 与运行时 `probe.turns` 同口径（它也在 BeforeModel 自增） */
  turns: number;
  /** 末条事件时间戳（毫秒），作为 endTime 的兜底 */
  lastEventMs?: number;
  /** SessionEnd 事件的时间戳（存在则优先作为 endTime） */
  sessionEndMs?: number;
  /** SessionEnd 载荷里的 exit_status */
  exitStatus?: string;
  /** SessionEnd 载荷里的 reason */
  endReason?: string;
  /** 出现次数最多的 model（events 里 BeforeModel 带 model） */
  model?: string;
}

/** 解析一个会话的 events.jsonl，取重建根 span 需要的那几项 */
function readEventsMaterial(sessionDir: string): EventsMaterial | null {
  const eventsPath = join(sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(eventsPath, "utf-8");
  } catch {
    return null;
  }

  const material: EventsMaterial = { turns: 0 };
  const modelCounts = new Map<string, number>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过（append 写在崩溃瞬间可能留半行）
    }
    const ts = typeof evt?.timestamp === "string" ? Date.parse(evt.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      // 不假定事件严格有序：取最大值而非「最后一行」
      material.lastEventMs = Math.max(material.lastEventMs ?? ts, ts);
    }

    if (evt?.event === "BeforeModel") {
      material.turns++;
      const m = evt?.data?.model;
      if (typeof m === "string" && m) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
    } else if (evt?.event === "SessionEnd") {
      if (Number.isFinite(ts)) material.sessionEndMs = ts;
      const st = evt?.data?.exit_status;
      if (typeof st === "string") material.exitStatus = st;
      const rs = evt?.data?.reason;
      if (typeof rs === "string") material.endReason = rs;
    }
  }

  let maxCount = 0;
  for (const [m, c] of modelCounts) {
    if (c > maxCount) {
      maxCount = c;
      material.model = m;
    }
  }

  return material;
}

/**
 * 读会话目录里的 crash.json 做退出归因。
 *
 * 返回 `"crash"` / `"terminal_death"` / `undefined`。**terminal_death 不算崩溃**：
 * 用户关终端 → tty 消失 → Ink 卸载写 fd 1 拿到 EIO → 冒泡成 uncaughtException。
 * 整条链没有一处是本体故障，判据直接复用 `crash-marker.ts` 的
 * `isTerminalDeathSnapshot()`，不另写一份（两份判据必然漂移）。
 */
function readCrashAttribution(sessionDir: string): "crash" | "terminal_death" | undefined {
  const p = join(sessionDir, "crash.json");
  if (!existsSync(p)) return undefined;
  try {
    const snapshot = JSON.parse(readFileSync(p, "utf-8"));
    // 同步 require 而非 await import：本函数在启动路径上被同步调用，
    // 且 crash-marker 已是同一个包内的纯同步模块。
    const { isTerminalDeathSnapshot } =
      require("../trace/crash-marker.ts") as typeof import("../trace/crash-marker.ts");
    return isTerminalDeathSnapshot(snapshot) ? "terminal_death" : "crash";
  } catch {
    return undefined;
  }
}

/**
 * `sidcode.root_span.end_time_source` 的取值 —— 让重建出来的数据自己说明 endTime 哪来的。
 *
 * 消费方必须能区分这几种：拿 `marker_mtime` 那档去算「会话时长分位」是在算噪声，
 * 而 `session_end_event` 那档与运行时落的根几乎等价。
 */
export type EndTimeSource =
  | "session_end_event"
  | "last_event"
  | "session_dir_mtime"
  | "marker_mtime";

/** 取文件/目录 mtime（毫秒）；取不到返回 undefined 而不是 0（0 会被当成有效的早期时间） */
function statMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** 重建时可注入的依赖（测试与 CLI 传不同的根目录 / 定价表） */
export interface RebuildOptions {
  /** `trajectories/sessions` 的父目录下的 sessions 目录；默认 `sidPaths.trajectories()/sessions` */
  sessionsRoot?: string;
  /** 用户配置的模型列表（带权威 pricing），用于 cost 重算 */
  availableModels?: import("../api/cost-tracker.ts").PricingModelEntry[];
  /** 标记文件的 mtime（毫秒）——events 完全缺失时作为 endTime 的最后兜底 */
  markerMtimeMs?: number;
}

/**
 * 据标记 + `events.jsonl` 重建一个完整的会话根 `SpanData`。
 *
 * **身份沿用标记**（traceId / spanId / startTime / 初始属性），统计值来自 events。
 * 返回的 span 可直接 `bus.enqueueSpan()`。
 *
 * 素材完全缺失（连 events.jsonl 都没有，例如 trace 被关掉）时**仍然重建**：
 * 一个只有起止时间的根，也比「整棵树没有栈底」有用得多 —— 那些子 span 挂上它就
 * 不再是孤儿。此时 endTime 退化为标记文件的 mtime，并在属性里标明来源。
 */
export function rebuildRootSpanFromEvents(
  marker: PendingRootSpanMarker,
  opts?: RebuildOptions,
): SpanData {
  const sessionsRoot = opts?.sessionsRoot ?? join(sidPaths.trajectories(), "sessions");
  const sessionDir = join(sessionsRoot, marker.session_id);
  const material = readEventsMaterial(sessionDir);

  // ── endTime：四个候选取**最大值**，而不是「优先级取第一个可用的」 ──
  //
  // 为什么必须取最大值：endTime 是个**估计值**，而它同时是 PR2 判据③的父区间上界
  // （子 span 的 startTime 必须落在父的 `[startTime, endTime]` 内）。子 span 在崩溃
  // 前就已经 flush 到 traces.jsonl 了，重建时**看不到它们**，所以估得偏早的直接后果是：
  // 根 span 确实回来了，但判据③报「时间错位」—— 换一种方式的树不成形。
  //
  // 优先级取数（if / else if）在这里是错的：SessionEnd 事件存在但比末条事件更早
  // （事件不保证严格有序、writer 是 append），就会取到偏早的那个。取最大值天然免疫。
  //
  // 第三个候选 `sessionDirMtimeMs` 是**复用现成设施**：collector 的心跳每 10s 覆写
  // 一次 `heartbeat.txt`（collector.ts 的 heartbeatTimer），所以会话目录 mtime 距
  // 「进程最后活着的时刻」不超过约 10s —— 比「末条 events 行」更贴近真实终点，
  // 尤其是最后那段只有工具执行、没产生任何 events 行的时候。
  const candidates: Array<[EndTimeSource, number | undefined]> = [
    ["session_end_event", material?.sessionEndMs],
    ["last_event", material?.lastEventMs],
    ["session_dir_mtime", statMtimeMs(sessionDir)],
    ["marker_mtime", opts?.markerMtimeMs],
  ];
  let endTimeSource: EndTimeSource = "marker_mtime";
  // 单调性兜底：任何取数源都不许算出比起点更早的终点（时钟回拨 / 手改文件都可能）
  let endTime = marker.start_time;
  for (const [source, value] of candidates) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (value > endTime) {
      endTime = value;
      endTimeSource = source;
    }
  }

  // ── cost / token：复用 cost-recompute（同一份 AfterModelRaw 口径，不另写一遍解析） ──
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let recomputedModel: string | undefined;
  try {
    const { recomputeCostFromEvents } =
      require("../trace/cost-recompute.ts") as typeof import("../trace/cost-recompute.ts");
    const r = recomputeCostFromEvents(sessionDir, opts?.availableModels);
    if (r) {
      cost = r.totalCostUSD;
      // input 用累积口径（flow），与 cost 可比。末次快照值（stock）除以累加值是错数。
      inputTokens = r.cumulativeInputTokens;
      outputTokens = r.totalOutputTokens;
      if (r.model) recomputedModel = r.model;
    }
  } catch {
    /* 重算不可用就只落身份与时间，不阻断重建 */
  }

  const crashAttribution = readCrashAttribution(sessionDir);
  // exit_status：SessionEnd 载荷优先；没有就按崩溃归因兜底。
  // 刻意不兜成 "end_turn"：把「不知道怎么结束的」谎报成正常收尾，正是这条缺陷
  // 一开始被低估的原因。
  const exitStatus =
    material?.exitStatus ?? (crashAttribution === "crash" ? "error" : "interrupted");

  const model =
    (typeof marker.attributes[ATTR.REQUEST_MODEL] === "string"
      ? (marker.attributes[ATTR.REQUEST_MODEL] as string)
      : undefined) ??
    material?.model ??
    recomputedModel;

  const attributes: Attributes = {
    ...marker.attributes,
    ...(model ? { [ATTR.REQUEST_MODEL]: model } : {}),
    [ATTR.TOTAL_TURNS]: material?.turns ?? 0,
    [ATTR.TOTAL_COST_USD]: cost,
    [ATTR.INPUT_TOKENS]: inputTokens,
    [ATTR.OUTPUT_TOKENS]: outputTokens,
    "sidcode.session.exit_status": exitStatus,
    // 三个自描述属性：消费方必须能区分「运行时落的根」与「事后重建的根」，
    // 否则拿重建值去算「会话时长分位」会把归因错到别处（endTime 语义不同）。
    "sidcode.root_span.recovered": true,
    "sidcode.root_span.end_time_source": endTimeSource,
    ...(crashAttribution ? { "sidcode.root_span.exit_attribution": crashAttribution } : {}),
  };

  return {
    traceId: marker.trace_id,
    spanId: marker.span_id,
    // 根 span 无父 —— 这一条是 PR2 判据①的锚点，别顺手填 undefined 以外的值
    parentSpanId: undefined,
    name: marker.name,
    kind: "invoke_agent",
    // terminal_death 不是故障，不能标 error（见 readCrashAttribution 注释）
    status: crashAttribution === "crash" || material?.endReason === "error" ? "error" : "ok",
    startTime: marker.start_time,
    endTime,
    durationMs: endTime - marker.start_time,
    attributes,
    events: [],
  };
}

/** 标记保留期：超过这么久且无素材的标记直接删（防止无限堆积） */
const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** `recoverPendingRootSpans` 的注入点 */
export interface RecoveryOptions extends RebuildOptions {
  /** 落 span 的去处（生产传 TelemetryBus） */
  enqueue: (span: SpanData) => void;
  /** 本进程 pid —— 自己的标记当然要跳过（它还没结束） */
  selfPid?: number;
  /** 判断某 pid 是否仍存活；默认 `process.kill(pid, 0)` */
  isProcessAlive?: (pid: number) => boolean;
}

/** 默认存活判定：信号 0 只查存在性。EPERM = 存在但无权限，按存活算。 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== "ESRCH";
  }
}

/**
 * 启动期扫描残留标记，重建并入队会话根 span。
 *
 * **调用时机必须早于本会话 fire SessionStart**：那之后本会话自己的标记就落盘了，
 * 会被本函数当成「上一会话的残留」重建一遍（进程存活判定挡得住绝大多数情况，
 * 但依赖这个兜底不如把顺序摆对）。
 *
 * 绝不抛异常。
 */
export function recoverPendingRootSpans(opts: RecoveryOptions): RootSpanRecoveryResult {
  const result: RootSpanRecoveryResult = { recovered: 0, skippedAlive: 0, pruned: 0 };
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const selfPid = opts.selfPid ?? process.pid;

  let files: string[];
  const dir = pendingRootSpanDir();
  try {
    if (!existsSync(dir)) return result;
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return result;
  }

  const now = Date.now();

  for (const f of files) {
    const full = join(dir, f);
    try {
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        /* 取不到 mtime 不影响重建，只影响 endTime 的最后兜底 */
      }

      const marker = JSON.parse(readFileSync(full, "utf-8")) as PendingRootSpanMarker;

      // 形态校验：缺身份的标记重建不出能接回树的根，留着也没用
      if (!marker?.session_id || !marker.trace_id || !marker.span_id) {
        unlinkSync(full);
        result.pruned++;
        continue;
      }

      // 本进程自己的标记：会话还在跑，根 span 由正常路径负责
      if (marker.pid === selfPid) continue;

      // 别人还活着：它自己会落根 span 并删标记，抢了就是重复落盘
      if (typeof marker.pid === "number" && isAlive(marker.pid)) {
        result.skippedAlive++;
        continue;
      }

      const span = rebuildRootSpanFromEvents(marker, { ...opts, markerMtimeMs: mtimeMs });
      opts.enqueue(span);
      // 入队成功才删：删了再入队失败就永久丢了这个根，而重复落盘只是脏一条数据
      unlinkSync(full);
      result.recovered++;
    } catch {
      // 单个标记失败不影响其余；超期的坏标记顺手清掉，避免每次启动都重试同一个
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > MARKER_MAX_AGE_MS) {
          unlinkSync(full);
          result.pruned++;
        }
      } catch {
        /* 连 stat 都失败就留着，下次再说 */
      }
    }
  }

  if (result.recovered > 0) {
    getLogger().info(
      "TELEMETRY",
      `§三 P0-2：为 ${result.recovered} 个未正常收尾的会话重建了根 span（据 events.jsonl）`,
    );
  }
  return result;
}
