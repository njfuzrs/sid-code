/**
 * 轨迹事件采集器
 * 通过 runtime hook 注册接收所有 hook 事件，在内存中累积 RequestResponsePair，
 * 驱动 TraceWriter 写入文件、TraceBuilder 构建 .traj，SessionEnd 时触发上传。
 *
 * 设计原则：
 * - 所有事件处理 try-catch，失败时仅记录警告不抛异常（采集不影响正常使用）
 * - 每次 AfterModel 后立即追加 raw.jsonl、重建 session.traj（崩溃安全）
 * - SessionEnd 时以 stats 参数覆盖自己累积的统计值（SessionState 更准确）
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import {
  HookEventName,
  type HookInput,
  type PreToolUseInput,
  type PostToolUseInput,
  type BeforeModelInput,
  type AfterModelInput,
  type SessionStartInput,
  type SessionEndInput,
  type PreCompactInput,
  type SubagentStartInput,
  type UserPromptSubmitInput,
} from "../hook/types.ts";
import type { HookSystem } from "../hook/system.ts";
import { TraceWriter, type RawJsonlEntry } from "./writer.ts";
import { buildTrajectory, type RequestResponsePair, type TraceMetadata } from "./builder.ts";
import { buildDigest, resolvePaths } from "./digest.ts";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import { estimateTextTokens } from "../context/token.ts";
import type { Message, Usage } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import { TokenEstimator } from "../llm/token-estimator.ts";
import { checkMessageHistoryIntegrity } from "../agent/message-invariants.ts";
import { resetSideCallStats, getSideStats, setSideStatsObserver } from "./side-call-sink.ts";
import {
  initStreamObserver,
  resetStreamObserver,
  getStreamSnapshot,
  getActiveStreamSnapshots,
  clearStreamSnapshot,
} from "./stream-observer.ts";

// ─── 最小化上传器接口（避免循环依赖，Task 8 实现后注入） ───

export interface TraceUploaderInterface {
  uploadSession(sessionDir: string, sessionId: string): Promise<{ allConfirmed: boolean }>;
  /** 获取上传平台基础 URL（/debug 显示用，可选实现） */
  getBaseUrl?(): string;
}

// ─── 采集器选项 ───

export interface CollectorOptions {
  /** 本地输出目录（默认 ~/.sid-code/trajectories） */
  outputDir?: string;
  /** 本地最大保留会话数（默认 100） */
  maxSessionsRetained?: number;
}

// ─── system prompt 文本提取 ───

function extractSystemPromptText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return (system as Array<Record<string, unknown>>)
      .filter(b => b.type === "text")
      .map(b => b.text as string)
      .join("\n");
  }
  return "";
}

// ─── raw_preview token 估算（§3.5 fdb47f30 / §6.1 修复）───
// 对一次请求做字符级 token 估算。OOM/hang 复盘时能看出"最后一次请求上下文规模"。
//
// §6.1 修复：旧实现只序列化 rawMessages 的 content，漏掉了 system prompt 与 tools 定义——
// 实测一次请求的真实 token（27424）里，messages 往往只占很小一部分，system（2-5k）+
// tools 定义（10-20k）才是大头，导致旧估算低估 ~380 倍。现把 system / tools 一并计入。
//
// 纯本地、无外部依赖；容错：任何异常返回当前累计值，绝不抛。
function estimateMessagesTokens(
  rawMessages: unknown[],
  system?: unknown,
  tools?: unknown,
): number {
  let total = 0;
  try {
    for (const msg of rawMessages) {
      if (msg == null) continue;
      const content = (msg as { content?: unknown }).content;
      // content 可能是字符串，或 content block 数组，或其他结构——统一序列化估算。
      const text = typeof content === "string" ? content : JSON.stringify(content ?? msg);
      total += estimateTextTokens(text);
    }
    // §6.1：system prompt（字符串或 text block 数组）
    if (system !== undefined && system !== null) {
      const systemText = extractSystemPromptText(system) || JSON.stringify(system);
      total += estimateTextTokens(systemText);
    }
    // §6.1：tools 定义（name/description/input_schema 都计入 prompt token）
    if (tools !== undefined && tools !== null) {
      total += estimateTextTokens(JSON.stringify(tools));
    }
  } catch {
    // 序列化/估算失败（如循环引用）返回已累计值，不影响 preview 落盘。
  }
  return total;
}

// ─── 主类 ───

export class TraceCollector {
  private pairs: RequestResponsePair[] = [];
  private metadata!: TraceMetadata;
  private currentPair: Partial<RequestResponsePair> | null = null;
  private prevMessageCount: number = 0;
  /** 修复问题一：resume 续接时，已存在 raw.jsonl 的历史轮次数；新轮 index 在此基础上接续。 */
  private resumedPairOffset: number = 0;
  private writer!: TraceWriter;
  private uploader: TraceUploaderInterface | null;
  private readonly outputDir: string;
  /** 本地最大保留会话数（LRU 清理用，默认 100） */
  private readonly maxSessionsRetained: number;
  private initialized = false;
  /** 待写入下次 raw.jsonl 的 compact_boundary */
  private pendingCompactBoundary: RawJsonlEntry["compact_boundary"] | undefined;
  /** 心跳定时器：每 10 秒写 heartbeat.txt */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 心跳文件路径 */
  private heartbeatPath: string = "";
  /** §3.4：BeforeModel 配对看门狗（index → timer） */
  private pendingModelCalls = new Map<number, ReturnType<typeof setTimeout>>();
  /** 发现 1：index → StreamPhase 快照定位信息（turn_index + loop_id）。
   * 看门狗 fire 时据此用与 emitStreamPhase 一致的 key 查快照，修复 stream_snapshot 恒 null。 */
  private streamSnapshotRefs = new Map<number, { turn_index: number; loop_id: string }>();
  /** 配对超时阈值——作为 fallback/stream-processor abort race 都失效时的最后兜底。
   *
   * 发现 2 修复：原 120s 对慢模型（如 glm-5.2 单轮 200s+ 长响应）偏紧，会把「慢但活着」的
   * 请求误报成 [高] 疑似 hang。放宽到 300s，并允许经 SID_CODE_PAIRING_TIMEOUT_MS 覆盖（运维调参 /
   * 测试注入）。真正的区分「慢 vs 死」靠 fire 时查流快照（chunks 仍在涨 = 活着，不报/降级），
   * 阈值只决定「多久之后才值得去看一眼流状态」。
   * 不按模型名硬编码分档（见 MEMORY feedback-no-hardcoded-model-tier-rules）。 */
  private readonly PAIRING_TIMEOUT_MS = TraceCollector.resolvePairingTimeoutMs();

  /** 解析配对看门狗阈值：env 覆盖 > 默认 300s。非法值回退默认。 */
  private static resolvePairingTimeoutMs(): number {
    const DEFAULT_MS = 300_000;
    const raw = process.env.SID_CODE_PAIRING_TIMEOUT_MS;
    if (raw && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_MS;
  }
  /**
   * §3.8：audit.log 起始字节 offset（SessionStart 时快照）
   *
   * P0-3：原实现是「起始行号」，用 readFileSync 整个文件 → split('\n') → .length
   * 拿行号。104MB 文件单次调用 111ms、RSS 28→420MB，每会话 2 次（SessionStart +
   * SessionEnd）。改为字节 offset（statSync().size，O(1)），全量读彻底消除。
   *
   * 字段语义从 line 改为 offset——audit_range.json 的 start_line/end_line 同步改为
   * start_offset/end_offset。已确认全仓无外部消费方（只有本文件写入 audit_range.json）。
   */
  private auditLogStartLine: number = 0;
  /** §3.8：audit.log 文件路径（SessionStart 时快照） */
  private auditLogPath: string = "";
  /** 性能优化：rebuildTraj 节流（最多每 30s 重写一次 session.traj，session end 时强制刷） */
  private trajDirty = false;
  private trajThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TRAJ_THROTTLE_MS = 30_000;

  // ── Harness 编辑统计内部计数器 ──
  private harnessEditCount = 0;
  private harnessEditFirstPass = 0;
  private harnessProtocols: Record<string, number> = {};

  // 缺口分析五类：上下文窗口查询（TokenEstimator 是窗口大小的 SSOT，避免另建静态表漂移）
  private readonly tokenEstimator = new TokenEstimator();

  constructor(options: CollectorOptions = {}, uploader: TraceUploaderInterface | null = null) {
    this.outputDir = options.outputDir
      ?? sidPaths.trajectories();
    this.maxSessionsRetained = options.maxSessionsRetained ?? 100;
    this.uploader = uploader;
    // 启动时做一次 LRU 清理，回收已上传/旧会话目录，防止本地无限堆积
    this.pruneOldSessions();
    // 辅助调用（标题生成/记忆召回等）用量落定的瞬间即同步进 trajectory，
    // 不必等待（可能因崩溃/被杀而永远不会到来的）SessionEnd——见 syncSideCallMetadata 注释。
    // 用 forceRebuildTraj（非节流版）——side-call 稀少（一两次/会话），崩溃安全优先。
    setSideStatsObserver(() => {
      if (!this.initialized) return;
      this.syncSideCallMetadata();
      void this.forceRebuildTraj();
    });
  }

  /**
   * LRU 清理：当 sessions/ 下目录数超过 maxSessionsRetained 时，按修改时间删最旧的。
   * 优先删已上传的（含 .uploaded 标记）——它们的数据已安全落到远端；
   * 未上传的目录（重试队列待传）即使较旧也尽量保留，避免丢失尚未采集到的训练数据。
   * 失败静默：清理不是关键路径，不能阻塞采集。
   */
  private pruneOldSessions(): void {
    try {
      const sessionsDir = join(this.outputDir, "sessions");
      if (!existsSync(sessionsDir)) return;

      const entries = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const dir = join(sessionsDir, e.name);
          let mtime = 0;
          try { mtime = statSync(dir).mtimeMs; } catch { /* 忽略 */ }
          const uploaded = existsSync(join(dir, ".uploaded"));
          return { dir, mtime, uploaded };
        });

      if (entries.length <= this.maxSessionsRetained) return;

      const overflow = entries.length - this.maxSessionsRetained;
      // 删除优先级：已上传的优先（按最旧在前），其次才动未上传的（同样最旧在前）
      const deletable = [
        ...entries.filter((e) => e.uploaded).sort((a, b) => a.mtime - b.mtime),
        ...entries.filter((e) => !e.uploaded).sort((a, b) => a.mtime - b.mtime),
      ].slice(0, overflow);

      let removed = 0;
      for (const e of deletable) {
        try {
          rmSync(e.dir, { recursive: true, force: true });
          removed++;
        } catch { /* 单个删除失败不影响其余 */ }
      }
      if (removed > 0) {
        getLogger().info("TRACE", `LRU 清理：本地会话 ${entries.length} 个超过上限 ${this.maxSessionsRetained}，已删除最旧 ${removed} 个`);
      }
    } catch (err) {
      getLogger().warn("TRACE", `LRU 清理失败（不影响采集）: ${err}`);
    }
  }

  /**
   * 修复问题一：统计已存在历史「完整轮次」数（resume 续接时用，使新轮 index 接续）。
   *
   * 两种来源，按优先级：
   *   1. raw.jsonl 存在（未上传/未清理）：逐行数「完整 pair 行」（无 type 字段）。
   *      `type:"request_sent"` 预写行只有请求侧、不计。
   *   2. raw.jsonl 不存在但 metadata.json 存在（已上传成功 → uploader.cleanupLocal
   *      删除了 raw/traj/events，仅留 .uploaded + metadata snapshot）：回退读
   *      metadata.json 的 total_api_calls 作为历史轮次数。
   *      ——否则复用已上传目录续接时 index 会从 1 重号、与远端历史冲突。
   * 全部失败返回 0（视为全新会话），绝不抛。
   */
  private countExistingPairs(sessionDir: string): number {
    const rawPath = join(sessionDir, "raw.jsonl");
    if (existsSync(rawPath)) {
      let count = 0;
      try {
        const content = readFileSync(rawPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const rec = JSON.parse(trimmed) as { type?: string };
            // 完整 pair 行没有 type 字段；request_sent 预写行有 type，跳过。
            if (rec.type === undefined) count++;
          } catch { /* 跳过损坏行 */ }
        }
        return count;
      } catch { /* 读失败转下方 metadata 回退 */ }
    }

    // 回退：已上传清理场景，从 metadata snapshot 读历史轮次数
    try {
      const metaPath = join(sessionDir, "metadata.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { total_api_calls?: number };
        if (typeof meta.total_api_calls === "number" && meta.total_api_calls > 0) {
          return meta.total_api_calls;
        }
      }
    } catch { /* 读失败视为全新会话 */ }
    return 0;
  }

  // ─── Hook 注册 ───

  /**
   * 将采集器注册为 runtime hook，监听所有相关事件。
   * 必须在 SessionStart 之前调用。
   */
  registerHooks(hookSystem: HookSystem): void {
    const eventNames = [
      HookEventName.SessionStart,
      HookEventName.BeforeModel,
      HookEventName.AfterModel,
      HookEventName.PreToolUse,
      HookEventName.PostToolUse,
      HookEventName.PostToolUseFailure,
      HookEventName.UserPromptSubmit,
      HookEventName.PreCompact,
      HookEventName.SubagentStart,
      HookEventName.SubagentStop,
      HookEventName.SessionEnd,
    ] as const;

    for (const eventName of eventNames) {
      hookSystem.registerHook(
        {
          type: "runtime",
          name: `trace-collector-${eventName}`,
          action: async (input: HookInput) => {
            await this.handleEvent(input);
          },
        },
        eventName,
        { source: "runtime" as any },
      );
    }
  }

  // ─── 事件路由 ───

  private async handleEvent(input: HookInput): Promise<void> {
    try {
      switch (input.hook_event_name) {
        case HookEventName.SessionStart:
          await this.handleSessionStart(input as SessionStartInput);
          break;
        case HookEventName.BeforeModel:
          this.handleBeforeModel(input as BeforeModelInput);
          break;
        case HookEventName.AfterModel:
          await this.handleAfterModel(input as AfterModelInput);
          break;
        case HookEventName.PreToolUse:
          this.handlePreToolUse(input as PreToolUseInput);
          break;
        case HookEventName.PostToolUse:
          this.handlePostToolUse(input as PostToolUseInput);
          break;
        case HookEventName.PostToolUseFailure:
          this.handlePostToolUseFailure(input as PostToolUseInput);
          break;
        case HookEventName.UserPromptSubmit:
          this.handleUserPromptSubmit(input as UserPromptSubmitInput);
          break;
        case HookEventName.PreCompact:
          this.handlePreCompact(input as PreCompactInput);
          break;
        case HookEventName.SubagentStart:
          this.handleSubagentStart(input as SubagentStartInput);
          break;
        case HookEventName.SubagentStop:
          this.handleSubagentStop(input);
          break;
        case HookEventName.SessionEnd:
          await this.handleSessionEnd(input as SessionEndInput);
          break;
      }
    } catch (err) {
      getLogger().warn("TRACE", `采集事件处理失败 [${input.hook_event_name}]: ${err}`);
    }
  }

  // ─── SessionStart ───

  private async handleSessionStart(input: SessionStartInput): Promise<void> {
    this.pairs = [];
    this.prevMessageCount = 0;
    this.currentPair = null;

    // 重置辅助调用统计（避免跨会话污染）
    resetSideCallStats();

    // 修复问题一：-c/--resume 续接同一 trajectory 目录，而非每次恢复都新建。
    // input.resumed_from 是被恢复会话的旧 id；resume 时用它作 trajectory session_id，
    // 使多轮 -c 续接全部落在 sessions/<旧id>/ 同一目录，历史不再碎成多个目录。
    // 注意：PID 文件 / crash marker 仍用本进程新 id（见 app.ts），避免跨进程文件名冲突——
    // 复用的只是「逻辑会话轨迹目录」，进程级唯一标识不受影响。
    const isResume = input.source === "resume" && !!input.resumed_from;
    const traceSessionId = isResume ? input.resumed_from! : input.session_id;

    this.metadata = {
      session_id: traceSessionId,
      model: input.model ?? "",
      // ★§6.4：冻结启动模型,供"启动 vs /model 切换后"归因对照。`model` 随后跟踪实际模型。
      model_at_start: input.model ?? "",
      start_time: input.timestamp,
      working_directory: input.cwd,
      permission_mode: input.permission_mode,
      tools_used: new Set(),
      files_edited: new Set(),
      user_prompts: [],
      compactions: [],
      subagent_spans: [],
      has_thinking: false,
      has_sub_agent: false,
      start_source: input.source,
      resumed_from: input.resumed_from,
      total_tokens_sent: 0,
      total_tokens_received: 0,
      total_cumulative_prompt_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0,
      total_api_calls: 0,
      // 缺口分析补全：派生/采集类指标（逐轮更新）
      total_reasoning_tokens: 0,
      total_gen_elapsed_ms: 0,
      gen_samples: 0,
      total_tool_duration_ms: 0,
      tool_duration_samples: 0,
      context_usage_trend: [],
      discarded_streams: 0,
      model_retry_count: 0,
      // 辅助 LLM 调用统计（影子调用：标题生成/记忆召回/权限分类/摘要压缩/预热/目标评估等）
      side_api_calls: 0,
      side_cost_usd: 0,
      side_tokens_sent: 0,
      side_tokens_received: 0,
    };

    this.writer = new TraceWriter(this.outputDir, traceSessionId);
    this.initialized = true;

    // 修复问题一续：resume 复用旧目录时，把已存在的历史 pair 数读回，
    // 使本次续接的 index 从历史末尾接续（而非从 1 重号、与已落盘/已上传的历史冲突）。
    // 仅恢复计数（轻量、崩溃安全），完整 pair 对象不载回内存。
    //
    // 数据完整性说明（已知局限，非本次回归）：
    //   - raw.jsonl 靠 append 语义天然保留全部历史轮次 → 评测/训练的权威全量数据源完整。
    //   - session.traj 是 rebuildTraj 用「本进程新 pairs」覆盖写的派生视图，跨进程续接时
    //     只反映本次轮次、不含历史轮次。这与改动前「resume 每次新建目录」时 traj 本就只有
    //     新轮次的行为一致，未变坏。如需 traj 全量历史，应从 raw.jsonl 重建（另行处理）。
    if (isResume) {
      try {
        const restored = this.countExistingPairs(this.writer.getSessionDir());
        if (restored > 0) {
          this.prevMessageCount = 0; // 续接首个请求的 messages 视为全量基线
          this.resumedPairOffset = restored;
          getLogger().info("TRACE", `resume 续接 trajectory 目录 ${traceSessionId}，已有 ${restored} 轮，index 从 ${restored + 1} 接续`);
        }
      } catch (err) {
        getLogger().warn("TRACE", `读取历史 pair 数失败（不影响续接）: ${err}`);
      }
    }

    // 启动心跳：每 10 秒写 heartbeat.txt（用于下次启动诊断 session hang）
    // 缺口 5 增强：增加 event_loop_lag_ms + active_request 快照，区分"正常等待"vs"异常 hang"
    this.heartbeatPath = join(this.writer.getSessionDir(), "heartbeat.txt");
    this.heartbeatTimer = setInterval(() => {
      try {
        const lagStart = performance.now();
        setTimeout(() => {
          try {
            const lagMs = Math.round(performance.now() - lagStart);
            // 从 stream-observer 获取活跃请求快照
            //
            // B4：并行子代理隔离后，这里可能同时有多份活快照（改造前 6 路子代理
            // 碰撞成 1 份，恒定只有一个候选）。选取规则必须显式：
            //   1. 优先主循环那份（无 agentId）—— 心跳的首要用途是诊断"主进程卡在哪"，
            //      随手取 [0] 会在 Map 插入顺序变化时随机报某个子代理，比没有更误导；
            //   2. 主循环无活跃流（如正在跑工具）时退到最早开始的子代理那份，
            //      并带上 agent_id 说明这是谁 —— 否则读心跳的人会以为主循环在流式阶段。
            // 并发数一并落盘，让"6 路并行时卡住"与"单路卡住"在心跳里可分辨。
            const activeSnapshots = getActiveStreamSnapshots();
            const mainSnapshot = activeSnapshots.find((s) => s.agentId === undefined);
            const oldestAgent = activeSnapshots
              .filter((s) => s.agentId !== undefined)
              .reduce<typeof activeSnapshots[number] | undefined>(
                (acc, s) => (!acc || s.startedAt < acc.startedAt ? s : acc),
                undefined,
              );
            const picked = mainSnapshot ?? oldestAgent;
            const activeRequest = picked
              ? {
                  index: picked.index,
                  model: picked.model,
                  phase: picked.phase,
                  elapsed_ms: Date.now() - picked.startedAt,
                  last_progress_ms: Date.now() - picked.lastContentProgressAt,
                  chunks: picked.chunksReceived,
                  empty_chunks: picked.emptyChunks,
                  timeouts_fired: picked.timeoutsFired,
                  ...(picked.agentId ? { agent_id: picked.agentId } : {}),
                  ...(activeSnapshots.length > 1 ? { active_count: activeSnapshots.length } : {}),
                }
              : null;
            // 优化 3：stream-observer 快照仅覆盖流式阶段；工具执行/后处理等非流式阶段
            // activeRequest 为 null，此前心跳就只剩时间戳，进程 hang 时看不出卡在哪。
            // 兜底塞入 last_known_state（§3.6 已维护 phase/turn/model），让 tool_exec
            // 阶段的 hang 也能从最后一条心跳定位到「卡在第 N 轮工具执行」。
            const lastState = !activeRequest ? this.metadata.last_known_state ?? null : null;
            const content = JSON.stringify({
              ts: new Date().toISOString(),
              session_id: traceSessionId,
              event_loop_lag_ms: lagMs,
              active_request: activeRequest,
              ...(lastState ? { last_known_state: lastState } : {}),
            });
            writeFileSync(this.heartbeatPath, content);
          } catch { /* 心跳失败静默 */ }
        }, 0);
      } catch { /* 心跳失败静默 */ }
    }, 10_000);
    // unref 确保心跳定时器不阻止进程退出
    this.heartbeatTimer.unref();

    this.writer.appendEvent({
      event: HookEventName.SessionStart,
      session_id: traceSessionId,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        source: input.source,
        model: input.model,
        permission_mode: input.permission_mode,
        // resume 续接时记录本进程真实 id，便于跨进程排查（trajectory 目录名=旧id，进程=新id）
        ...(isResume ? { resumed_from: input.resumed_from, process_session_id: input.session_id } : {}),
      },
    });

    // 缺口 1/2/3：初始化流状态观测器（注入 session_id 和事件写入器）
    initStreamObserver(
      traceSessionId,
      this.writer.getSessionDir(),
      (event) => { try { this.writer.appendEvent(event); } catch { /* 静默 */ } },
    );

    // 缺口 7：注入 per-session warn.log 路径（WARN/ERROR 级别日志追加到此，不被后续会话覆盖）
    const sessionWarnLogPath = join(this.writer.getSessionDir(), "warn.log");
    getLogger().setSessionWarnLogPath(sessionWarnLogPath);

    // §3.8：快照 audit.log 起始字节 offset（用于 SessionEnd 写 audit_range.json）
    try {
      const logPath = getLogger().getLogFilePath();
      if (logPath && existsSync(logPath)) {
        this.auditLogPath = logPath;
        // P0-3：O(1) 取文件大小，替代 readFileSync+split 数行号
        // （104MB 文件原实现 111ms / RSS 28→420MB，每会话 2 次）
        this.auditLogStartLine = statSync(logPath).size;
      }
    } catch { /* 静默：索引是辅助功能 */ }
  }

  /**
   * 记录一条自定义事件到 events.jsonl（P2-3：git 操作度量等运行时事件的通用入口）。
   * writer 未就绪（SessionStart 之前）或未初始化时静默忽略——度量不阻断主流程。
   */
  recordCustomEvent(event: string, data: Record<string, unknown>): void {
    if (!this.initialized || !this.writer) return;
    try {
      this.writer.appendEvent({
        event,
        session_id: this.metadata.session_id,
        timestamp: new Date().toISOString(),
        data,
      });
    } catch { /* 事件落盘失败静默，不影响主流程 */ }
  }

  // ─── BeforeModel ───

  private handleBeforeModel(input: BeforeModelInput): void {
    if (!this.initialized) return;

    const req = input.llm_request;
    const rawMessages = (req.raw_messages ?? req.messages ?? []) as unknown[];
    // resume 续接时 index 在历史轮次（resumedPairOffset）之上接续，避免与旧 raw.jsonl 行 index 重号。
    const index = this.resumedPairOffset + this.pairs.length + 1;

    // 发现 1：记住本轮的流快照定位信息（turn_index + loop_id），供看门狗 fire 时用一致的 key 查快照。
    if (input.stream_snapshot_ref) {
      this.streamSnapshotRefs.set(index, input.stream_snapshot_ref);
    }

    // 首次请求提取 system prompt
    if (index === 1 && req.system !== undefined) {
      const systemText = extractSystemPromptText(req.system);
      if (systemText) {
        this.metadata.system_prompt = systemText;
        this.metadata.system_prompt_hash = createHash("md5").update(systemText).digest("hex");
      }
      // ★§6.4：跟踪实际模型（而非仅首次写入后冻结）。`/model` 中途切换后，后续请求
      // 的 req.model 即为新模型，这里随之更新 metadata.model，与 raw/events/TUI 一致。
      // model_at_start 仍保留启动值不变，供归因对照。
      if (req.model && this.metadata.model !== req.model) {
        this.metadata.model = req.model;
      }
    }

    // 计算增量 messages
    const newMessages = this.computeNewMessages(rawMessages);

    // 构建 currentPair 的 request 侧
    const requestSide: RequestResponsePair["request"] = {
      model: req.model,
      raw_messages: rawMessages,
      new_messages: newMessages,
    };

    if (index === 1) {
      // 首次请求保存完整数据
      requestSide.system = req.system;
      requestSide.tools = req.tools;
      requestSide.messages = rawMessages as unknown[];
    } else {
      // 后续请求只记录增量
      requestSide._messages_count = rawMessages.length;
    }

    this.currentPair = {
      timestamp: input.timestamp,
      index,
      model: req.model,
      request: requestSide,
      stop_reason: "",
      is_partial: false,
    };

    this.writer.appendEvent({
      event: HookEventName.BeforeModel,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: { model: req.model, index, msg_count: rawMessages.length },
    });

    // §3.6：更新 last_known_state → before_model
    this.metadata.last_known_state = {
      phase: "before_model",
      turn: index,
      model: req.model,
      updated_at: input.timestamp,
    };

    // §3.4（fdb47f30）：接入审计日志。原先 BeforeModel 只写 events.jsonl，audit.log
    // 拿不到——会话异常时（如 index 23 无响应）只能解析轨迹文件，无法从审计日志快速定位。
    // 用 INFO 级写入（writeToFile 写所有级别 → 进 audit.log 文件；fileOnly 下不刷屏）。
    getLogger().info(
      "AUDIT:MODEL",
      `→ BeforeModel index=${index} model=${req.model} msg_count=${rawMessages.length}`,
    );

    // 迷你 raw_preview：即使进程在 API 调用期间被 V8 OOM kill，也能知道最后一次请求的关键指标
    // 约 200 字节一行，不依赖 AfterModel 才能落盘
    try {
      const sessionDir = this.writer.getSessionDir();
      // §3.5（fdb47f30）：原先硬编码 0，导致 raw_preview 永远显示 total_tokens_est=0，
      // OOM/hang 复盘时看不出"第 N 次请求上下文有多大"。改为字符级估算 rawMessages：
      // 对每条消息序列化后累加 estimateTextTokens。纯本地计算、无外部依赖，失败被
      // 外层 try-catch 静默兜底（preview 非关键路径）。
      // §6.1：system + tools 一并计入（system/tools 仅首次请求在 req 上完整提供）。
      const totalTokensEst = estimateMessagesTokens(rawMessages, req.system, req.tools);
      const previewLine = JSON.stringify({
        ts: input.timestamp,
        index,
        model: req.model,
        msg_count: rawMessages.length,
        total_tokens_est: totalTokensEst,
      });
      appendFileSync(join(sessionDir, "raw_preview.jsonl"), previewLine + "\n");
    } catch {
      // 静默失败：preview 不是关键路径
    }

    // §3.5：raw.jsonl 预写请求侧——区分"请求没发"vs"发了但没收到响应"vs"收到但处理崩溃"
    // 排查者看到 raw.jsonl 有 request_sent 但没有对应的完整记录，即可确认请求已发出。
    try {
      const totalTokensEst = estimateMessagesTokens(rawMessages, req.system, req.tools);
      this.writer.appendRawJsonl(JSON.stringify({
        timestamp: input.timestamp,
        index,
        type: "request_sent",
        model: req.model,
        msg_count: rawMessages.length,
        estimated_input_tokens: totalTokensEst,
      }));
    } catch {
      // 静默失败：预写不是关键路径
    }

    // §3.4：启动配对看门狗——超时未收到 AfterModel/AfterModelRaw/TurnError 则写入 ModelCallUnpaired
    // 根因修复：index 由"已完成 pair 数 + 1"计算，同一轮请求超时重试时 index 不变，
    // handleBeforeModel 会被多次调用。若不先清除旧定时器就 set() 覆盖，旧定时器仍存活，
    // 在重试已成功之后的 PAIRING_TIMEOUT_MS 触发误报的 ModelCallUnpaired（幽灵超时）。
    const staleTimer = this.pendingModelCalls.get(index);
    if (staleTimer) {
      clearTimeout(staleTimer);
    }
    const pairingTimer = setTimeout(() => {
      try {
        // 缺口 3 + 发现 1：从 stream-observer 获取流状态快照，附加到 ModelCallUnpaired 事件。
        // 发现 1 修复：用 emitStreamPhase 写入时同款 key（turn_index + loop_id）查快照。
        // ref 缺失（非 queryLoop 来源）时退化为原行为（用 index 直查），不至于比修复前更差。
        const ref = this.streamSnapshotRefs.get(index);
        const snapshot = ref
          ? getStreamSnapshot(ref.turn_index, ref.loop_id)
          : getStreamSnapshot(index);
        // 发现 2：区分「慢 vs 死」。若快照仍在收 chunk（最近有内容进展、未收到终止/abort），
        // 说明请求「慢但活着」，标记 still_progressing=true 供 digest 降级为 [低] 慢响应，
        // 不再一律报 [高] 疑似 hang。判据：有快照 + 收到过 chunk + 最近进展在阈值内。
        const PROGRESS_FRESH_MS = 30_000; // 最近 30s 内还有内容进展 = 仍在动
        const lastProgressMs = snapshot?.lastContentProgressAt
          ? Date.now() - snapshot.lastContentProgressAt
          : null;
        const stillProgressing = !!snapshot
          && snapshot.chunksReceived > 0
          && !snapshot.abortSignalAborted
          && lastProgressMs !== null
          && lastProgressMs < PROGRESS_FRESH_MS;
        const streamDiag = snapshot ? {
          last_known_phase: snapshot.phase,
          http_status_received: snapshot.httpStatusReceived,
          http_status: snapshot.httpStatus,
          chunks_received: snapshot.chunksReceived,
          empty_chunks: snapshot.emptyChunks,
          last_content_progress_ms: lastProgressMs,
          timeouts_fired: snapshot.timeoutsFired,
          abort_signal_aborted: snapshot.abortSignalAborted,
          still_progressing: stillProgressing,
        } : null;

        this.writer.appendEvent({
          event: "ModelCallUnpaired",
          session_id: this.metadata.session_id,
          timestamp: new Date().toISOString(),
          data: {
            index,
            model: req.model,
            elapsed_ms: this.PAIRING_TIMEOUT_MS,
            // still_progressing 时是「慢响应」而非 hang，hint 相应区分，避免误导排查者。
            hint: stillProgressing
              ? "BeforeModel 发出后超时未配对，但流仍在收 chunk：慢响应而非 hang（模型长响应/网关慢）"
              : "BeforeModel 发出后超时未收到 AfterModel/AfterModelRaw/TurnError，可能：1)请求hang 2)处理崩溃但未被catch",
            stream_snapshot: streamDiag,
          },
        });
      } catch { /* 看门狗写入失败静默 */ }
      this.pendingModelCalls.delete(index);
      this.streamSnapshotRefs.delete(index);
    }, this.PAIRING_TIMEOUT_MS);
    // unref 确保看门狗不阻止进程退出
    if (pairingTimer && typeof pairingTimer === "object" && "unref" in pairingTimer) {
      (pairingTimer as any).unref();
    }
    this.pendingModelCalls.set(index, pairingTimer);
  }

  // ─── AfterModel ───

  private async handleAfterModel(input: AfterModelInput): Promise<void> {
    if (!this.initialized || !this.currentPair) return;

    // §3.4：清除配对看门狗（AfterModel 到达即证明请求已正常返回并处理）
    const pairIndex = this.currentPair.index ?? this.resumedPairOffset + this.pairs.length + 1;
    const pairingTimer = this.pendingModelCalls.get(pairIndex);
    if (pairingTimer) {
      clearTimeout(pairingTimer);
      this.pendingModelCalls.delete(pairIndex);
    }
    // 缺口 3 + 发现 1：清除流状态快照（正常完成，不再需要诊断数据）。
    // 发现 1 修复：快照 key 是 turn_index+loop_id（见 handleBeforeModel），此前用 pairIndex 清除
    // 从来清不掉对应快照（key 不符），快照要拖到 loop 结束 clearAllSnapshots 才回收。改用同款 ref 清。
    const ref = this.streamSnapshotRefs.get(pairIndex);
    if (ref) {
      clearStreamSnapshot(ref.turn_index, ref.loop_id);
      this.streamSnapshotRefs.delete(pairIndex);
    } else {
      clearStreamSnapshot(pairIndex);
    }

    const resp = input.llm_response;
    const usage = resp.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheCreate = usage.cacheCreationInputTokens ?? 0;
    // 缺口分析二类：推理 token（output 子集，仅 OpenAI 族提供；Anthropic 恒 undefined）
    const reasoningTokens = usage.reasoningTokens ?? 0;
    const stopReason = resp.stop_reason ?? "end_turn";
    const contentBlocks = (resp.content_blocks ?? []) as unknown[];
    const thinkingBlocks = resp.thinking_blocks as Array<{ type: "thinking"; thinking: string }> | undefined;

    // 缺口分析五类：上下文占用率。used=完整 prompt 规模（promptTotal，厂商无关），
    // window=模型上下文窗口（TokenEstimator SSOT）。窗口未知则不落（不猜一个误导比率）。
    const ctxUsage = this.computeContextUsage(input.llm_request.model, usage, resp.provider);

    // §3.2：AfterModelRaw 事件——processStream 返回即落盘，消除"有 Before 无 After"的诊断盲区。
    // 即使后续 pair 完成/raw.jsonl/traj 重建崩溃，排查者也能看到响应已到达。
    const currentIndex = this.currentPair.index ?? this.resumedPairOffset + this.pairs.length + 1;
    try {
      this.writer.appendEvent({
        event: "AfterModelRaw",
        session_id: this.metadata.session_id,
        timestamp: input.timestamp,
        cwd: input.cwd,
        data: {
          index: currentIndex,
          model: input.llm_request.model,
          stop_reason: stopReason,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read: cacheRead,
            // cache_creation（写入）此前缺失，导致 cost-recompute 对「首轮大量 cache 写入」的
            // 僵尸/中断会话 cost 偏低（cache_creation 定价 ≈ 1.25× 普通 input）。cacheCreate 已在手边，
            // 补落使 events 重算与 SessionState 权威值口径一致（对齐 claude-code 的 JSONL usage）。
            cache_creation: cacheCreate,
          },
          content_types: contentBlocks.filter(Boolean).map((b: any) => b.type),
          elapsed_ms: (resp as any).api_duration_ms,
          provider: resp.provider,  // T12.4：Provider 维度标记
          // 端点维度：区分同模型不同渠道，供排查 + cost-recompute 按 (model, endpoint) 精确重算
          ...(resp.base_url ? { base_url: resp.base_url } : {}),
          ttft_ms: (resp as any).ttft_ms,  // T14.4：TTFT 持久化
          // 缺口分析二类：推理 token 落盘（仅 OpenAI 族 >0，供 digest 拆解思考成本）
          ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
          // 缺口分析五类：上下文占用率（used=完整 prompt 规模 / 模型上下文窗口）。
          // used 走 normalizeCacheUsage 的 promptTotal（厂商无关：Anthropic=未命中+命中+写入，
          // OpenAI=prompt_tokens 全量），避免因缓存字段口径差异误算占用。
          ...(ctxUsage ? {
            context_used_tokens: ctxUsage.usedTokens,
            context_window: ctxUsage.window,
            context_usage_ratio: ctxUsage.ratio,
          } : {}),
        },
      });
    } catch {
      // AfterModelRaw 写入失败不阻断后续处理
    }

    // §3.6：更新 last_known_state → post_stream
    this.metadata.last_known_state = {
      phase: "post_stream",
      turn: currentIndex,
      model: input.llm_request.model,
      updated_at: input.timestamp,
    };

    // 检测 thinking
    if (thinkingBlocks && thinkingBlocks.length > 0) {
      this.metadata.has_thinking = true;
    }

    // 更新统计
    // ⚠️ inputTokens 是"本次 API 调用的 prompt 总长度"，每次调用都包含整段历史 prompt。
    // 直接累加会 N² 过计数（case_028 实测：29 次调用累加 = 3.65M，实际只有 167k）。
    // 正确口径：input 取最后一次（已含全部历史），output/cache 累加。
    // 校准记录见 evals/eval-judge.ts gradeCost 注释 + 2026-05-25 横向对比实验。
    this.metadata.total_tokens_sent = inputTokens;
    this.metadata.total_tokens_received += outputTokens;
    // DISP-1：累计 prompt（flow），与累计 cost 口径可比
    this.metadata.total_cumulative_prompt_tokens += inputTokens;
    this.metadata.total_cache_read_tokens += cacheRead;
    this.metadata.total_cache_creation_tokens += cacheCreate;
    this.metadata.total_api_calls += 1;
    // 缺口分析二类：reasoning token 累计（flow，仅 OpenAI 族 >0）
    this.metadata.total_reasoning_tokens += reasoningTokens;
    // 缺口分析五类：上下文占用峰值（取各轮最大值——最接近溢出的时刻最有预警价值）+ 逐轮趋势序列
    if (ctxUsage) {
      if (ctxUsage.ratio > (this.metadata.context_usage_peak_ratio ?? 0)) {
        this.metadata.context_usage_peak_ratio = ctxUsage.ratio;
        this.metadata.context_usage_peak_tokens = ctxUsage.usedTokens;
        this.metadata.context_window_at_peak = ctxUsage.window;
      }
      // 趋势：保留逐轮 ratio 时序（看是否随轮次线性膨胀）。保留 3 位小数够用且省空间。
      this.metadata.context_usage_trend.push(Math.round(ctxUsage.ratio * 1000) / 1000);
    }
    // 成本增量落盘（flow，与 SessionState.totalCostUSD 同口径累加）。
    // 此前 total_cost_usd 只在 SessionEnd 用 stats 覆盖一次（见 handleSessionEnd），
    // 若 SessionEnd 未干净触发（进程被杀 / 仍存活，heartbeat.txt 残留），
    // session.traj.total_cost_usd 会永远停在初始 0。这里每轮 AfterModel 增量累加，
    // 使 traj 在中断场景也保留已发生的成本；SessionEnd 触发时仍以 SessionState 权威值覆盖。
    this.metadata.total_cost_usd += resp.cost_usd ?? 0;
    // ★§6.4：同上,跟踪实际模型（/model 切换后随之更新，非仅首次）。
    if (input.llm_request.model && this.metadata.model !== input.llm_request.model) {
      this.metadata.model = input.llm_request.model;
    }

    // 完成 pair
    const usageNormalized = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    };

    const pair: RequestResponsePair = {
      ...(this.currentPair as RequestResponsePair),
      response: {
        content: contentBlocks,
        stop_reason: stopReason,
        usage: usageNormalized,
      },
      usage: usageNormalized,
      stop_reason: stopReason,
      ...(thinkingBlocks && thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
    };

    // 如果 Hook 载荷中有 harness_context，存入当前 pair
    if (input.harness_context) {
      pair.harness_turn_context = {
        tool_subset: input.harness_context.tool_subset,
        context_actions: input.harness_context.context_actions,
        runtime_mode: input.harness_context.runtime_mode,
        edit_protocol: input.harness_context.extra?.edit_protocol as string | undefined,
        extra: input.harness_context.extra,
      };
    }

    this.pairs.push(pair);
    this.currentPair = null;

    // 追加 raw.jsonl（不写入 raw_messages，仅内存持有）
    const rawEntry = this.toRawJsonlEntry(pair);
    this.writer.appendRaw(rawEntry);

    // 性能优化：剥离旧 pair 的 raw_messages 引用，消除 O(N²) 内存驻留。
    // 每个 pair.request.raw_messages 持有该轮请求时的**全量**会话历史引用，而每轮请求
    // 历史都在增长 → N 个 pair 累计驻留 O(N²) 消息。raw.jsonl 已剥离 raw_messages 落盘，
    // buildTrajectory.findToolResult 现回退到 new_messages（增量），故仅需为其 lookahead
    // 窗口（3）保留最近几轮的 raw_messages，更旧的可安全置空释放。
    this.pruneOldRawMessages();

    // 重建 session.traj（节流：最多 30s 一次，不再每轮全量覆盖）
    this.rebuildTraj();

    this.writer.appendEvent({
      event: HookEventName.AfterModel,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        stop_reason: stopReason,
        usage: usageNormalized,
        index: pair.index,
        // P1-3: 填充 elapsed_ms/ttft_ms/content_types（此前恒 null，已在 AfterModelRaw 有值但此处缺失导致复盘误判）
        elapsed_ms: (resp as any).api_duration_ms ?? null,
        ttft_ms: (resp as any).ttft_ms ?? null,
        content_types: contentBlocks.filter(Boolean).map((b: any) => b.type),
      },
    });

    // §3.4：审计日志同步 AfterModel（含 stop_reason + token），与 BeforeModel 配对，
    // 使审计日志能看出"第 N 次请求是否拿到响应、停止原因、用量"。
    getLogger().info(
      "AUDIT:MODEL",
      `← AfterModel index=${pair.index} stop=${stopReason} in=${inputTokens} out=${outputTokens} cache_read=${cacheRead}`,
    );

    // §3.6：更新 last_known_state → done（本轮 AfterModel 处理完毕）
    this.metadata.last_known_state = {
      phase: "done",
      turn: pair.index,
      model: input.llm_request.model,
      updated_at: input.timestamp,
    };
  }

  // ─── PreToolUse ───

  private handlePreToolUse(input: PreToolUseInput): void {
    if (!this.initialized) return;

    // §3.6：更新 last_known_state → tool_exec
    this.metadata.last_known_state = {
      phase: "tool_exec",
      turn: this.pairs.length,
      model: this.metadata.model,
      updated_at: input.timestamp,
    };

    this.writer.appendEvent({
      event: HookEventName.PreToolUse,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
      },
    });

    // §3.4：审计日志同步 PreToolUse（工具开始执行）。
    getLogger().info("AUDIT:TOOL", `▶ ${input.tool_name} id=${input.tool_use_id ?? "?"}`);
  }

  // ─── PostToolUse ───

  private handlePostToolUse(input: PostToolUseInput): void {
    if (!this.initialized) return;

    this.metadata.tools_used.add(input.tool_name);

    // 推断 files_edited
    if (input.tool_name === "write" || input.tool_name === "edit") {
      const filePath = input.tool_input?.file_path;
      if (typeof filePath === "string") {
        this.metadata.files_edited.add(filePath);
      }
    }

    // 如果有 edit_meta，累积 Harness 编辑统计
    if (input.edit_meta) {
      this.harnessEditCount++;
      if (input.edit_meta.first_pass_success) this.harnessEditFirstPass++;
      if (input.edit_meta.protocol) {
        this.harnessProtocols[input.edit_meta.protocol] =
          (this.harnessProtocols[input.edit_meta.protocol] ?? 0) + 1;
      }
    }

    // 缺口分析（一类·工具耗时）：主循环 tool-executor 已在 firePostToolUseEvent 透传
    // duration_ms（= Pre→Post 墙钟），此前采集器丢弃，工具级耗时无从离线复盘。
    // 落盘到 PostToolUse 事件 + 会话级累计，供 digest 定位"慢在哪个工具"。
    const toolDurationMs =
      typeof input.duration_ms === "number" && input.duration_ms >= 0 ? input.duration_ms : undefined;
    if (toolDurationMs !== undefined) {
      this.metadata.total_tool_duration_ms += toolDurationMs;
      this.metadata.tool_duration_samples += 1;
    }

    this.writer.appendEvent({
      event: HookEventName.PostToolUse,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        is_error: input.is_error ?? false,
        // 缺口分析（一类·工具耗时）：每次工具执行墙钟，供 digest 聚合分位/定位慢工具
        ...(toolDurationMs !== undefined ? { duration_ms: toolDurationMs } : {}),
      },
    });

    // §3.4：审计日志同步 PostToolUse。工具报错（is_error=true）升 WARN 级——
    // 工具失败是事故复盘关键信号，必须在 audit.log 显式可见；成功用 INFO。
    const isErr = input.is_error ?? false;
    const auditMsg = `${isErr ? "✗" : "✓"} ${input.tool_name} id=${input.tool_use_id ?? "?"}${isErr ? " (is_error)" : ""}`;
    if (isErr) {
      getLogger().warn("AUDIT:TOOL", auditMsg);
    } else {
      getLogger().info("AUDIT:TOOL", auditMsg);
    }
  }

  // ─── PostToolUseFailure ───

  private handlePostToolUseFailure(input: PostToolUseInput): void {
    if (!this.initialized) return;

    this.metadata.tools_used.add(input.tool_name);

    this.writer.appendEvent({
      event: HookEventName.PostToolUseFailure,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        is_error: true,
      },
    });

    // §3.4：工具执行失败（PostToolUseFailure）必为 WARN 级，审计日志显式可见。
    getLogger().warn(
      "AUDIT:TOOL",
      `✗ ${input.tool_name} id=${input.tool_use_id ?? "?"} (PostToolUseFailure)`,
    );
  }

  // ─── UserPromptSubmit ───

  private handleUserPromptSubmit(input: UserPromptSubmitInput): void {
    if (!this.initialized) return;

    if (typeof input.prompt === "string" && input.prompt.trim()) {
      this.metadata.user_prompts.push(input.prompt);
    }

    this.writer.appendEvent({
      event: HookEventName.UserPromptSubmit,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: { prompt: input.prompt },
    });
  }

  // ─── PreCompact ───

  private handlePreCompact(input: PreCompactInput): void {
    if (!this.initialized) return;

    this.metadata.compactions.push({
      trigger: input.trigger,
      timestamp: input.timestamp,
    });

    // 暂存 compact_boundary 信息，在下次 AfterModel 写入 raw.jsonl
    this.pendingCompactBoundary = {
      summary: input.trigger ?? "auto",
      messageCountBefore: this.pairs.length,
      timestamp: input.timestamp,
    };

    // 重置增量计数器：压缩后 messages 数组会被截断重组
    this.prevMessageCount = 0;

    this.writer.appendEvent({
      event: HookEventName.PreCompact,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: { trigger: input.trigger },
    });
  }

  // ─── SubagentStart ───

  private handleSubagentStart(input: SubagentStartInput): void {
    if (!this.initialized) return;

    this.metadata.has_sub_agent = true;
    this.metadata.subagent_spans.push({
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      start: input.timestamp,
      description: input.description,
    });

    this.writer.appendEvent({
      event: HookEventName.SubagentStart,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        agent_id: input.agent_id,
        agent_type: input.agent_type,
        parent_session_id: input.parent_session_id,
        // §9.2：写入派活意图，排查时无需回 raw.jsonl 找原始 prompt
        description: input.description ?? null,
      },
    });
  }

  // ─── SubagentStop ───

  private handleSubagentStop(input: HookInput): void {
    if (!this.initialized) return;

    // 找到最后一个未结束的 span，填入 end 时间
    for (let i = this.metadata.subagent_spans.length - 1; i >= 0; i--) {
      if (!this.metadata.subagent_spans[i].end) {
        this.metadata.subagent_spans[i].end = input.timestamp;
        break;
      }
    }

    // P1-3: SubagentStop 补全 data（此前 data 恒为空，子代理开销无法从轨迹核算）
    const stopInput = input as any; // SubagentStopInput 字段
    this.writer.appendEvent({
      event: HookEventName.SubagentStop,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        agent_id: stopInput.agent_id ?? null,
        agent_type: stopInput.agent_type ?? null,
        elapsed_ms: stopInput.duration_ms ?? null,
        output_tokens: stopInput.usage?.outputTokens ?? null,
        input_tokens: stopInput.usage?.inputTokens ?? null,
        turns: stopInput.turns ?? null,
        status: stopInput.success === true ? "completed" : stopInput.success === false ? "error" : "unknown",
      },
    });
  }

  // ─── SessionEnd ───

  private async handleSessionEnd(input: SessionEndInput): Promise<void> {
    if (!this.initialized) return;

    this.metadata.end_time = input.timestamp;
    this.metadata.end_source = input.reason;

    // ── 在途请求收尾：BeforeModel 已发但 AfterModel 未到（被中断/超时/异常退出） ──
    // 将在途 pair 标记为 partial 塞进 pairs，使 rebuildTraj 能写出 traj（哪怕只有请求侧）。
    // 若不处理，中断会话 pairs.length=0 → traj 无任何轮次信息，诊断全盲。
    if (this.currentPair) {
      const partialPair: RequestResponsePair = {
        ...(this.currentPair as RequestResponsePair),
        response: {
          content: [],
          stop_reason: "interrupted",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "interrupted",
        is_partial: true,
      };
      this.pairs.push(partialPair);
      this.currentPair = null;
    }

    // 用 SessionState 统计值覆盖采集器自己累积的（SessionState 更准确）
    if (input.stats) {
      const s = input.stats;
      if (s.model) this.metadata.model = s.model;
      if (s.total_tokens_sent !== undefined) this.metadata.total_tokens_sent = s.total_tokens_sent;
      if (s.total_tokens_received !== undefined) this.metadata.total_tokens_received = s.total_tokens_received;
      if (s.total_cumulative_prompt_tokens !== undefined) this.metadata.total_cumulative_prompt_tokens = s.total_cumulative_prompt_tokens;
      if (s.total_cache_read_tokens !== undefined) this.metadata.total_cache_read_tokens = s.total_cache_read_tokens;
      if (s.total_cache_creation_tokens !== undefined) this.metadata.total_cache_creation_tokens = s.total_cache_creation_tokens;
      if (s.total_cost_usd !== undefined) this.metadata.total_cost_usd = s.total_cost_usd;
      if (s.total_api_calls !== undefined) this.metadata.total_api_calls = s.total_api_calls;
      if (s.tools_used) for (const t of s.tools_used) this.metadata.tools_used.add(t);
      if (s.files_edited) for (const f of s.files_edited) this.metadata.files_edited.add(f);
      if (s.has_thinking !== undefined) this.metadata.has_thinking = s.has_thinking;
    }

    // 缺口分析一类：派生会话级输出吞吐 tokens/sec。
    // 分母是纯生成耗时累计（total_gen_elapsed_ms，来自 stream_completed，不含握手/重试/等待），
    // 分子取 total_tokens_received（若上面被 SessionState 覆盖，用的是权威值，口径仍是"最终输出"）。
    // 无纯生成耗时样本（gen_samples=0，如 anthropic 未接 lifecycle telemetry 的旧路径）时留 undefined，
    // 不落一个误导的 0 或 ∞——与 TTFT/Bug A 的"宁缺毋滥"philosophy 一致。
    if (this.metadata.gen_samples > 0 && this.metadata.total_gen_elapsed_ms > 0) {
      this.metadata.output_tokens_per_sec =
        this.metadata.total_tokens_received / (this.metadata.total_gen_elapsed_ms / 1000);
    }

    // 缺口分析三类：输出/输入 token 比。分母用累计输入 prompt（flow，与 output 累计同口径），
    // 输出单价是输入的 3–8×，此比率上涨即成本结构恶化的早期信号。
    if (this.metadata.total_cumulative_prompt_tokens > 0) {
      this.metadata.output_input_ratio =
        this.metadata.total_tokens_received / this.metadata.total_cumulative_prompt_tokens;
    }

    // 缺口分析四类：本会话缓存命中率 = cache_read /（cache_read + 全价输入）。
    // 分母口径与跨会话命中率（usage-aggregator）对齐：命中 + 全价输入 = 可缓存的总输入基数。
    // 全价输入 = 累计 prompt − 命中 − 写入（写入本身不算命中但占输入）。
    const cacheRead = this.metadata.total_cache_read_tokens;
    const cacheCreate = this.metadata.total_cache_creation_tokens;
    const cacheableBase = this.metadata.total_cumulative_prompt_tokens;
    if (cacheableBase > 0) {
      // 命中率分母用完整输入基数（含命中+写入+全价），与 /cache 跨会话口径一致
      this.metadata.session_cache_hit_rate = Math.min(1, cacheRead / cacheableBase);
    } else if (cacheRead + cacheCreate > 0) {
      // 极端兜底：cumulative 缺失但有缓存数据时，用命中/(命中+写入) 近似
      this.metadata.session_cache_hit_rate = cacheRead / (cacheRead + cacheCreate);
    }

    // 推断 exit_status
    // reason 语义：
    //   exit/other → 看最后一次 stop_reason，end_turn 即正常结束，否则视为 user_interrupt
    //   clear → /clear 上下文清除
    //   abort → 用户主动 Ctrl-C 或外部 SIGTERM
    //   error → runtime 抛出异常（流式中断 / API 错误 / 上下文溢出兜底失败）
    const lastPair = this.pairs[this.pairs.length - 1];
    if (input.reason === "exit" || input.reason === "other") {
      this.metadata.exit_status = lastPair?.stop_reason === "end_turn"
        ? "end_turn"
        : "user_interrupt";
    } else {
      this.metadata.exit_status = input.reason;
    }

    // 错误退出时把错误信息也写入 metadata，便于 trajectory 诊断
    if (input.reason === "error" && input.error) {
      this.metadata.error = {
        message: input.error.message,
        name: input.error.name,
      };
    }

    // 把 Harness 汇总写入 metadata
    if (input.harness_summary) {
      this.metadata.harness = input.harness_summary;
    } else if (this.harnessEditCount > 0) {
      // 即使没有外部汇总，也把 collector 自己累积的编辑统计写入
      this.metadata.harness = {
        edit_stats: {
          total_edits: this.harnessEditCount,
          first_pass_success: this.harnessEditFirstPass,
          retry_count: 0,
          protocols_used: this.harnessProtocols,
        },
      };
    }

    // 辅助 LLM 调用统计汇总（影子调用 sink → metadata）
    this.syncSideCallMetadata();

    // 最终写入 events.jsonl
    const sideStats = getSideStats();
    this.writer.appendEvent({
      event: HookEventName.SessionEnd,
      session_id: this.metadata.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        reason: input.reason,
        exit_status: this.metadata.exit_status,
        // T13.4：side-call 失败统计
        sideCallStats: sideStats.apiCalls > 0 ? {
          total: sideStats.apiCalls,
          succeeded: sideStats.apiCalls - sideStats.failed,
          failed: sideStats.failed,
          timedOut: sideStats.timedOut,
          byLabel: sideStats.byLabel,
        } : undefined,
      },
    });

    // 最终重建 session.traj（强制刷，确保包含所有数据，取消未 fire 的节流定时器）
    await this.forceRebuildTraj();

    // D3-1 + D3-3：退出时落 messages.json（完整消息历史 + 退出归因）。
    // 落实 CLAUDE.md 评测纪律不变量第 1 条「transcript 必落盘」到真实交互退出路径。
    // 尤其 abnormal / user_interrupt 退出时，此前只有 metadata.json 无法验尸。
    this.persistMessagesSnapshot(input);

    // 优化 2：落 session-summary.json（批量分诊入口）。
    // 必须在 forceRebuildTraj 之后——buildDigest 从刚重建的 session.traj 读取。
    this.persistSessionSummary();

    // 修复问题二：空白轨迹（无任何 LLM 调用的纯空壳）既不上传也不保留——
    // 上传空目录纯属浪费，且会把噪音同步到远端。提前判定，空壳直接清理并返回。
    if (this.isBlankSession()) {
      // 停止心跳（下面正常路径也会停，这里提前停避免删目录后定时器再写）
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.cleanupIfBlankSession();
      return;
    }

    // 触发上传（有限等待）
    if (this.uploader) {
      try {
        const uploadPromise = this.uploader.uploadSession(
          this.writer.getSessionDir(),
          this.metadata.session_id,
        );
        // 最多等 10 秒，超时后上传继续在后台运行
        const result = await Promise.race([
          uploadPromise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000)),
        ]);

        if (result === null) {
          getLogger().info("TRACE", "上传超时，任务将在后台继续或由重试队列处理");
        } else if (!result.allConfirmed) {
          getLogger().warn("TRACE", "部分文件上传失败，已加入重试队列");
        } else {
          getLogger().info("TRACE", "上传完成，本地文件已清理");
        }
      } catch (err: any) {
        getLogger().warn("TRACE", `上传异常: ${err.message}`);
      }
    }

    // 停止心跳并清理 heartbeat.txt
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      if (this.heartbeatPath && existsSync(this.heartbeatPath)) {
        unlinkSync(this.heartbeatPath);
      }
    } catch { /* 清理失败静默 */ }

    // 缺口 1/2/3：重置流状态观测器
    resetStreamObserver();

    // 缺口 7：清除 per-session warn.log 路径（避免下个会话启动前的日志误写入此 session）
    getLogger().setSessionWarnLogPath(undefined);

    // §3.8：写 audit_range.json（audit.log 按 session 索引）
    if (this.auditLogPath && this.auditLogStartLine > 0) {
      try {
        // P0-3：O(1) 取文件大小，替代 readFileSync+split 数行号
        let endOffset = this.auditLogStartLine;
        if (existsSync(this.auditLogPath)) {
          endOffset = statSync(this.auditLogPath).size;
        }
        const rangeData = {
          audit_log_path: this.auditLogPath,
          start_offset: this.auditLogStartLine,
          end_offset: endOffset,
        };
        writeFileSync(
          join(this.writer.getSessionDir(), "audit_range.json"),
          JSON.stringify(rangeData, null, 2),
        );
      } catch { /* 索引写入失败静默 */ }
    }

    // 修复问题二：空白轨迹已在上传前提前判定+清理（见函数前段 isBlankSession 分支），
    // 走到这里说明本会话有真实 LLM 轮次，正常收尾即可。
  }

  /**
   * 判定当前会话是否「空白轨迹」——打开即退、从未发生任何有效 LLM 调用的纯空壳。
   *
   * 两类空壳（均要求 resumedPairOffset===0 且 total_api_calls===0）：
   *   1. 经典空壳：pairs 空 + 无在途请求（打开即退，从未发起任何请求）；
   *   2. ★启动即中断空壳（§6.1）：发出一次 BeforeModel 即被 abort、0 token，pairs 里只剩
   *      is_partial+interrupted+空 content 的空壳 pair。覆盖"敲 hi 随即 Ctrl-C"这类噪音会话。
   *
   * 保守边界：只要有任何一轮真正收到过响应内容（response.content 非空），或有在途请求残留，
   *   就视为有诊断价值而保留——网关侧可能已计费，本地目录不能删。
   */
  private isBlankSession(): boolean {
    // 前置铁律：resume 续接目录即便本进程空跑也含历史轮次，绝不能删。
    if (this.resumedPairOffset !== 0) return false;
    // 权威统计确认零 LLM 调用（SessionEnd 已用 SessionState 覆盖 total_api_calls）。
    if ((this.metadata.total_api_calls ?? 0) !== 0) return false;

    // 经典空壳：打开即退，从未发起任何请求（pairs 空 + 无在途）。
    if (this.pairs.length === 0 && !this.currentPair) return true;

    // ★§6.1 放宽分支（根治文档观测项）：覆盖"发出一次 BeforeModel 即被 abort、0 token"的
    // 启动即中断会话（如用户开终端敲 "hi" 随即 Ctrl-C，全天 18 条这类噪音）。
    // 此判定发生在 handleSessionEnd 已把在途 currentPair 冲成 partial pair 塞进 pairs 之后
    // （见 handleSessionEnd 的"在途请求收尾"段），故此时 currentPair 已为 null、pairs 里
    // 只剩若干 is_partial 且 stop_reason="interrupted" 的空壳 pair。
    // 严格条件（全部满足才判空壳，任一不满足即保留供诊断）：
    //   - 没有任何在途请求残留（currentPair 为空）；
    //   - pairs 全部是 partial/interrupted（没有任何一轮真正收到过 response）；
    //   - 每个 partial pair 的 response.content 为空（从未收到任何响应字节/内容块）。
    // 只要有一轮收到过内容（哪怕未正常收尾），就说明网关侧可能已计费、有诊断价值，保留。
    if (!this.currentPair && this.pairs.length > 0) {
      const allInterruptedEmpty = this.pairs.every((p) => {
        const contentLen = Array.isArray(p.response?.content) ? p.response!.content.length : 0;
        return p.is_partial === true && p.stop_reason === "interrupted" && contentLen === 0;
      });
      if (allInterruptedEmpty) return true;
    }

    return false;
  }

  /**
   * 确认空壳时删除整个 trajectory 目录。best-effort：失败只告警，不抛
   * （退出路径不能被采集副作用阻断）。
   */
  private cleanupIfBlankSession(): void {
    try {
      if (!this.isBlankSession()) return;
      const dir = this.writer.getSessionDir();
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        getLogger().info("TRACE", `清理空白轨迹（无任何 LLM 调用）: ${this.metadata.session_id}`);
      }
    } catch (err) {
      getLogger().warn("TRACE", `空白轨迹清理失败（不影响退出）: ${err}`);
    }
  }

  // ─── 辅助：增量 messages 计算 ───

  /**
   * D3-1：把完整消息历史 + 退出归因落到 sessions/<id>/messages.json。
   *
   * 消息历史来源：最后一个 pair 的 raw_messages（发送给 LLM 前的完整历史，含全部
   * 历史轮次），再追加最后一次 response 的 content（assistant 回复），近似还原退出
   * 时刻 ctxMgr 的完整 messages。best-effort：失败只告警，不阻塞退出。
   */
  private persistMessagesSnapshot(input: SessionEndInput): void {
    try {
      const messages = this.reconstructMessages();

      // D3-3：崩溃自动归因摘要——abnormal 时一行根因，免去人工翻日志
      const attribution = this.buildExitAttribution(input, messages);

      // 把归因摘要也写进 metadata（D3-3），便于 trajectory 诊断不必另开 messages.json
      if (attribution.abnormal) {
        this.metadata.exit_attribution = attribution;
      }

      const snapshot = {
        kind: "messages-snapshot",
        session_id: this.metadata.session_id,
        reason: input.reason,
        exit_status: this.metadata.exit_status,
        timestamp: input.timestamp,
        attribution,
        message_count: messages.length,
        messages,
      };
      this.writer.writeMessagesSnapshot(snapshot);

      if (attribution.abnormal) {
        getLogger().warn(
          "TRACE",
          `异常退出已落 messages.json 验尸: ${attribution.summary}`,
        );
      }
    } catch (err: any) {
      getLogger().warn("TRACE", `落 messages.json 失败（不影响退出）: ${err?.message ?? err}`);
    }
  }

  /**
   * 优化 2：把 digest 在 SessionEnd 算好的结论瘦身落盘为 session-summary.json。
   *
   * 关键设计：不在此处另写摘要逻辑，而是复用 digest（唯一事实源，已含 20+ 条分层异常规则）。
   * 否则 collector 一套、digest 一套，日后必然漂移出两套结论。此处只做「跑 digest + 取字段」。
   *
   * 前置条件：调用点必须在 forceRebuildTraj() 之后——buildDigest 从刚重建的 session.traj 读取。
   * 全程 try-catch 容错（不变量 1：采集永不阻塞主循环）；失败仅告警，退出流程照常。
   */
  private persistSessionSummary(): void {
    try {
      const sessionDir = this.writer.getSessionDir();
      const trajPath = join(sessionDir, "session.traj");
      // session.traj 尚未落盘（如空壳会话已提前 return，理论上到不了这里）则跳过
      if (!existsSync(trajPath)) return;

      // 复用 digest 引擎。digest.ts 是纯只读逻辑（无副作用），静态导入（见文件头）。
      // resolvePaths() 不传参——与 /trace 命令一致，从 SID_CODE_HOME → ~/.sid-code 推导 root。
      // 不能传 this.outputDir：它已是 .../trajectories，而 resolvePaths 会再拼一层 trajectories/sessions。
      const paths = resolvePaths();
      const ref = {
        id: this.metadata.session_id,
        dir: sessionDir,
        trajPath,
        mtimeMs: 0, // summary 落盘不依赖 mtime 排序，占位即可
      };
      const digest = buildDigest(ref, false, paths);
      if (!digest) return;

      // 瘦身：只取批量分诊需要的顶层信号，剔除大字段（userPrompts 全文 / toolSequence 明细 /
      // thinkingHighlights 等）。异常只保留 kind+severity+layer，详情仍在 digest / errors.jsonl。
      //
      // 发现 3 修复：此前只落一个 `errors` = high+medium 严重度**异常**计数，但字段名(errors)与语义
      // (anomalies，含 L1 假设 + watchdog/stuck_loop 等假阳性)不一致——批量分诊主键 select(.errors>0)
      // 被假阳性灌水，几乎每个含慢响应/并行读的干净会话都 errors>0，稀释真有 bug 的会话。
      // 现拆成两个诚实字段：
      //   - real_errors：仅「确认的硬错误信号」计数（工具 is_error / TurnError / errors.jsonl /
      //     退出状态 error / 侧调用失败 / 数据损坏），不含 L1 假设与假阳性。批量分诊新主键。
      //   - anomalies_count：high+medium 异常总数（旧 errors 语义，含假阳性），保留供参考。
      // `errors` 字段保留为 anomalies_count 的别名（向后兼容旧脚本），但注释标注已弃用。
      const REAL_ERROR_KINDS = new Set([
        "exit_status_error",       // L0：退出状态为 error
        "tool_result_is_error",    // L0：工具 tool_result 标记 is_error（如 LSP 超时）
        "turn_error_in_events",    // L0：events.jsonl 有 TurnError
        "errors_jsonl_has_entries",// L0：errors.jsonl 有条目
        "side_call_failures",      // L0：侧调用（子代理等）失败
        "schema_missing_core_keys",// L0：轨迹数据损坏
      ]);
      const anomaliesCount = digest.anomalies.filter(
        (a) => a.severity === "high" || a.severity === "medium",
      ).length;
      const realErrors = digest.anomalies.filter((a) => REAL_ERROR_KINDS.has(a.kind)).length;
      const highSeverityAnomalies = digest.anomalies.filter((a) => a.severity === "high").length;
      const summary = {
        session_id: digest.sessionId,
        model: digest.model,
        exit_status: digest.exitStatus,
        abnormal: digest.abnormal,
        duration_ms: digest.durationMs,
        turns: digest.apiCalls,
        total_steps: digest.totalSteps,
        cost_usd: digest.costUSD,
        tokens_sent: digest.tokensSent,
        tokens_received: digest.tokensReceived,
        // 发现 3：批量分诊主键 = real_errors（诚实错误计数）。旧 errors 字段保留为 anomalies_count 别名。
        real_errors: realErrors,
        anomalies_count: anomaliesCount,
        high_severity_anomalies: highSeverityAnomalies,
        /** @deprecated 用 real_errors（真错误）或 anomalies_count（含假阳性的异常总数）替代 */
        errors: anomaliesCount,
        anomaly_kinds: [...new Set(digest.anomalies.map((a) => a.kind))],
        anomalies: digest.anomalies.map((a) => ({
          kind: a.kind,
          severity: a.severity,
          layer: a.layer,
        })),
        top_tools: digest.toolsUsed.slice(0, 8),
        files_edited_count: digest.filesEdited.length,
        has_subagent: digest.subAgents != null,
      };
      this.writer.writeSessionSummary(summary);
    } catch (err: any) {
      getLogger().warn("TRACE", `落 session-summary.json 失败（不影响退出）: ${err?.message ?? err}`);
    }
  }

  /**
   * 从 pairs 还原退出时刻的完整消息历史。
   * 最后一个 pair 的 raw_messages 已含本轮发送前的全部历史；再补最后一次 assistant 回复。
   */
  private reconstructMessages(): Message[] {
    const lastPair = this.pairs[this.pairs.length - 1];
    if (!lastPair) return [];

    const base = (lastPair.request.raw_messages ?? lastPair.request.messages ?? []) as Message[];
    const messages: Message[] = Array.isArray(base) ? [...base] : [];

    // 补最后一次 response 的 assistant content（raw_messages 是"发送前"快照，不含本轮回复）
    const respContent = lastPair.response?.content as unknown[] | undefined;
    if (Array.isArray(respContent) && respContent.length > 0) {
      messages.push({ role: "assistant", content: respContent as Message["content"] });
    }
    return messages;
  }

  /**
   * D3-3：构建退出归因。abnormal 时给出错误类型 / 最后工具 / 步数 / 是否孤儿。
   */
  private buildExitAttribution(input: SessionEndInput, messages: Message[]): {
    abnormal: boolean;
    summary: string;
    reason: string;
    exit_status: string;
    api_calls: number;
    last_tool: string | null;
    has_orphan_tool_use: boolean;
    error_name?: string;
  } {
    const exitStatus = String(this.metadata.exit_status ?? "");
    const abnormal =
      input.reason === "error" ||
      input.reason === "abort" ||
      exitStatus === "user_interrupt" ||
      exitStatus === "error" ||
      exitStatus === "abort";

    // 最后一个被调用的工具名（从消息历史里找最后一个 tool_use）
    let lastTool: string | null = null;
    for (let i = messages.length - 1; i >= 0 && !lastTool; i--) {
      const c = messages[i]?.content;
      if (!Array.isArray(c)) continue;
      for (let j = c.length - 1; j >= 0; j--) {
        const b = c[j];
        if (b.type === "tool_use") { lastTool = b.name; break; }
      }
    }

    const orphan = checkMessageHistoryIntegrity(messages).orphans.length > 0;
    const errName = this.metadata.error?.name;

    const summaryParts = [
      `reason=${input.reason}`,
      `exit=${exitStatus}`,
      `api_calls=${this.metadata.total_api_calls}`,
      `last_tool=${lastTool ?? "none"}`,
      `orphan_tool_use=${orphan}`,
    ];
    if (errName) summaryParts.push(`error=${errName}`);

    return {
      abnormal,
      summary: summaryParts.join(" "),
      reason: String(input.reason),
      exit_status: exitStatus,
      api_calls: this.metadata.total_api_calls,
      last_tool: lastTool,
      has_orphan_tool_use: orphan,
      ...(errName ? { error_name: errName } : {}),
    };
  }

  // ─── 辅助：增量 messages 计算 ───
  /**
   * 计算本次请求相对于上次请求新增的 messages
   * 处理压缩边界（压缩后 messages 数组截断重组）
   */
  computeNewMessages(messages: unknown[]): unknown[] {
    if (this.pairs.length === 0 && this.prevMessageCount === 0) {
      // 首次请求，全部都是新的
      this.prevMessageCount = messages.length;
      return messages;
    }

    if (messages.length < this.prevMessageCount) {
      // 压缩发生了：messages 被截断重组，旧计数失效，视为全量
      this.prevMessageCount = messages.length;
      return messages;
    }

    const newMsgs = messages.slice(this.prevMessageCount);
    this.prevMessageCount = messages.length;
    return newMsgs;
  }

  // ─── 辅助：重建 session.traj ───

  /**
   * 节流版重建：短会话（前 5 轮）立即写，之后标记脏 + 节流。
   *
   * 背景（性能修复 2026-07）：旧实现每轮 AfterModel 都 buildTrajectory(全部 pairs) +
   * JSON.stringify(全文) + Bun.write 全量覆盖 session.traj，长会话写放大 O(N²)
   * （实测 190 轮累计写盘 30MB）。而 session.traj 是**派生视图**，权威数据是 append
   * 语义的 raw.jsonl（每轮已实时追加，崩溃安全）。故长会话 traj 无需每轮落盘——节流到
   * 30s 一次即可满足"复盘时大致最新"，session end / snapshot 上传前再 forceRebuildTraj
   * 保证完整。前 5 轮立即写保证：① 短会话/测试行为不变 ② 用户打开 traj 能尽快看到首轮。
   */
  private rebuildTraj(): void {
    // 短会话：前几轮直接写（成本低且保证测试/短会话行为不变）
    if (this.pairs.length <= 5) {
      void this.flushTraj();
      return;
    }
    // 长会话：节流
    this.trajDirty = true;
    if (this.trajThrottleTimer !== null) return; // 已排程，等它 fire
    this.trajThrottleTimer = setTimeout(() => {
      this.trajThrottleTimer = null;
      if (this.trajDirty) void this.flushTraj();
    }, this.TRAJ_THROTTLE_MS);
    // unref：不因这个定时器阻止进程退出（session end 有 forceRebuildTraj 兜底）。
    this.trajThrottleTimer?.unref?.();
  }

  /** 强制立即重建 session.traj（session end / snapshot 上传 / 侧调用用量落定时调用）。 */
  private async forceRebuildTraj(): Promise<void> {
    if (this.trajThrottleTimer !== null) {
      clearTimeout(this.trajThrottleTimer);
      this.trajThrottleTimer = null;
    }
    await this.flushTraj();
  }

  /** 实际执行 buildTrajectory + 落盘（节流与强制路径共用）。 */
  private async flushTraj(): Promise<void> {
    this.trajDirty = false;
    try {
      const traj = buildTrajectory(this.pairs, this.metadata);
      await this.writer.writeTraj(traj);
    } catch (err) {
      getLogger().warn("TRACE", `重建 session.traj 失败: ${err}`);
    }
  }

  /**
   * 剥离旧 pair 的 raw_messages 引用，消除 O(N²) 内存驻留。
   *
   * findToolResult 的 maxLookahead=3，即从当前 pair 向后最多查 3 个 pair。
   * 保留最近 KEEP_RAW_WINDOW 个 pair 的 raw_messages 供 findToolResult 兜底，
   * 更旧的置 undefined 释放内存（buildTrajectory 回退到 new_messages）。
   * 首轮（index=1）始终保留（含 system prompt + tools）。
   */
  private static readonly KEEP_RAW_WINDOW = 4; // maxLookahead(3) + 1 余量
  private pruneOldRawMessages(): void {
    const cutoff = this.pairs.length - TraceCollector.KEEP_RAW_WINDOW;
    for (let i = 1; i < cutoff; i++) { // i=0 首轮始终保留
      const req = this.pairs[i]?.request;
      if (req && req.raw_messages) {
        req.raw_messages = undefined;
      }
    }
  }

  /**
   * 把 side-call-sink 的累计用量同步进 trajectory metadata（不落盘，只更新内存态；
   * 落盘由调用方紧跟着触发的 rebuildTraj() 完成）。
   *
   * 背景：此前只有 handleSessionEnd 调用一次，若会话未走到 SessionEnd（崩溃/被杀/挂起），
   * 已经产生的辅助调用（标题生成/记忆召回等）用量会从 trajectory 永久丢失——即便
   * provider 已经计费。现由 setSideStatsObserver 注册的观察者在每次 recordSideCall
   * 后立即调用本方法，不再仅依赖 SessionEnd。
   *
   * 未初始化（SessionStart 尚未跑完）时静默跳过——理论上不会发生（side-call 都在会话内
   * 触发），纯防御性判断，避免 this.metadata 访问报错。
   */
  private syncSideCallMetadata(): void {
    if (!this.initialized) return;
    const sideStats = getSideStats();
    if (sideStats.apiCalls > 0) {
      this.metadata.side_api_calls = sideStats.apiCalls;
      this.metadata.side_cost_usd = sideStats.costUSD;
      this.metadata.side_tokens_sent = sideStats.tokensSent;
      this.metadata.side_tokens_received = sideStats.tokensReceived;
    }
  }

  // ─── /debug 命令用：中间态快照上传 ───

  /**
   * /debug 命令用：立即上传当前轨迹快照（mid-session）。
   * best-effort：最多等 5 秒，超时或失败不影响调用方。
   * 会话结束时正常上传以相同 session_id + file_type 覆盖此快照（服务端幂等）。
   */
  async uploadSnapshot(): Promise<{ uploaded: boolean; sessionId: string; sessionDir: string; error?: string }> {
    if (!this.initialized) {
      return { uploaded: false, sessionId: "", sessionDir: "", error: "轨迹采集尚未初始化" };
    }

    const sessionId = this.metadata.session_id;
    const sessionDir = this.writer.getSessionDir();

    if (!this.uploader) {
      return { uploaded: false, sessionId, sessionDir, error: "上传未配置" };
    }

    // 先重建 session.traj 确保包含最新数据（快照上传前强制刷）
    await this.forceRebuildTraj();

    // 上传，最多等 5 秒
    try {
      const uploadPromise = this.uploader.uploadSession(sessionDir, sessionId);
      const result = await Promise.race([
        uploadPromise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000)),
      ]);

      if (result === null) {
        return { uploaded: false, sessionId, sessionDir, error: "上传超时（5s），将在会话结束后重试" };
      }
      return { uploaded: result.allConfirmed, sessionId, sessionDir, error: result.allConfirmed ? undefined : "部分文件上传失败" };
    } catch (err: any) {
      return { uploaded: false, sessionId, sessionDir, error: err.message };
    }
  }

  /** 获取上传平台 URL（/debug 显示用） */
  getUploadUrl(): string | undefined {
    return this.uploader?.getBaseUrl?.();
  }

  // ─── 辅助：pair → RawJsonlEntry（不含 raw_messages） ───

  private toRawJsonlEntry(pair: RequestResponsePair): RawJsonlEntry {
    const { raw_messages: _rm, ...requestWithoutRaw } = pair.request;
    // 纳入待写入的 compact_boundary（如果有）
    const compactBoundary = this.pendingCompactBoundary;
    this.pendingCompactBoundary = undefined;
    return {
      timestamp: pair.timestamp,
      index: pair.index,
      model: pair.model,
      request: requestWithoutRaw,
      response: pair.response,
      usage: pair.usage,
      stop_reason: pair.stop_reason,
      is_partial: pair.is_partial,
      ...(compactBoundary ? { compact_boundary: compactBoundary } : {}),
    };
  }

  // ─── 异常路径诊断信号（§3.1 errors.jsonl）───

  /**
   * 将异常持久化到轨迹目录的 errors.jsonl。
   * 任何被 engine/queryLoop/fallback 的 catch 块捕获的异常都应调用此方法，
   * 确保排查时 `cat errors.jsonl` 直接看到崩溃现场，无需翻全局 audit.log。
   */
  recordError(input: {
    phase: "connection" | "stream" | "post_stream" | "tool_execution" | "hook" | "engine";
    index: number;
    error: string;
    stack?: string;
    context?: Record<string, unknown>;
  }): void {
    if (!this.initialized) return;
    try {
      const entry = {
        event: "Error",
        timestamp: new Date().toISOString(),
        session_id: this.metadata.session_id,
        data: input,
      };
      this.writer.appendError(entry);
    } catch (err) {
      getLogger().warn("TRACE", `recordError 失败: ${err}`);
    }
  }

  /**
   * 记录 TurnError 到 events.jsonl（§3.3）。
   * 当 engine.ts catch 到 queryLoop 异常并 yield fatal_error 时同步调用。
   */
  recordTurnError(input: {
    error: string;
    stack?: string;
    turn: number;
  }): void {
    if (!this.initialized) return;
    try {
      this.writer.appendEvent({
        event: "TurnError",
        session_id: this.metadata.session_id,
        timestamp: new Date().toISOString(),
        data: input,
      });
    } catch (err) {
      getLogger().warn("TRACE", `recordTurnError 失败: ${err}`);
    }
  }

  // ─── 供测试访问的只读属性 ───

  /** 当前累积的 pairs（供测试检查） */
  getPairs(): RequestResponsePair[] {
    return this.pairs;
  }

  /** 当前会话元数据（供测试检查） */
  getMetadata(): TraceMetadata | undefined {
    return this.initialized ? this.metadata : undefined;
  }

  /** 当前 prevMessageCount（供测试检查增量逻辑） */
  getPrevMessageCount(): number {
    return this.prevMessageCount;
  }

  /**
   * 缺口分析五类：计算单轮上下文占用率。
   *
   * used = normalizeCacheUsage().promptTotal —— 厂商无关的"完整输入 prompt 规模"
   *   （Anthropic=未命中+命中+写入；OpenAI=prompt_tokens 全量）。这是"喂给模型的上下文有多满"
   *   的正确口径，缓存命中不减少上下文占用（缓存只省钱不省窗口）。
   * window = TokenEstimator.getContextLimit(model) —— 窗口大小 SSOT。
   *
   * 窗口未知（返回兜底值也算已知）时仍可算比率；provider 缺失时按 model 名启发式归一化，
   * 与 normalizeCacheUsage 的 anthropic 判定同源。异常一律返回 null（可观测性不阻断主流程）。
   */
  private computeContextUsage(
    model: string,
    usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
    provider?: string,
  ): { usedTokens: number; window: number; ratio: number } | null {
    try {
      const prov = provider || (/claude/i.test(model) ? "anthropic" : "openai");
      const normalized = normalizeCacheUsage(usage as Usage, prov);
      const usedTokens = normalized.promptTotal;
      if (!(usedTokens > 0)) return null;
      const window = this.tokenEstimator.getContextLimit(model);
      if (!(window > 0)) return null;
      // 比率封顶 1（极端情况下 prompt 超窗口时 clamp，避免 >1 的诡异值）
      const ratio = Math.min(1, usedTokens / window);
      return { usedTokens, window, ratio };
    } catch {
      return null;
    }
  }

  /** T12：写入 RetryTelemetry 事件到 events.jsonl */
  writeRetryTelemetry(event: Record<string, unknown>): void {
    if (!this.initialized) return;
    try {
      this.writer.appendEvent({
        event: "RetryTelemetry",
        session_id: this.metadata.session_id,
        timestamp: new Date().toISOString(),
        data: event,
      });
      // 缺口分析（一类·输出吞吐）：stream_completed.elapsedMs 是"单次 fetch 从连接到流结束
      // 的纯生成耗时"（不含握手/重试/等待），是 tokens/sec 唯一正确的分母。
      // 累加到会话级，SessionEnd 时与 total_tokens_received 派生 output_tokens_per_sec。
      // 每轮流内可能有多次 stream_completed（重试重连），全部累加 → 分母是"实际生成墙钟"，
      // 分子是"最终采纳的输出 token"，二者口径一致（都只算真正产出 token 的那段时间）。
      if (event.type === "stream_completed") {
        const elapsed = event.elapsedMs;
        if (typeof elapsed === "number" && elapsed > 0) {
          this.metadata.total_gen_elapsed_ms += elapsed;
          this.metadata.gen_samples += 1;
        }
      }
      // 缺口分析六类·可靠性：重试 / 弃流会话级聚合。
      // 每次 retry / 超时中断 / 529 掉线，都意味着前一次流被丢弃、已生成的 output 白烧
      //（本次排查命中 12 条弃流）。聚成会话级计数，避免排查时手工数 events.jsonl。
      const telType = event.type;
      if (telType === "retry") {
        this.metadata.model_retry_count += 1;
        this.metadata.discarded_streams += 1;
      } else if (
        telType === "stream_idle_timeout" ||
        telType === "stream_content_progress_timeout" ||
        telType === "stream_overall_timeout" ||
        telType === "529_dropped"
      ) {
        this.metadata.discarded_streams += 1;
      }
    } catch { /* 遥测写入失败不影响主流程 */ }
  }

  /**
   * 阶段 2.5：网关定价采集可观测事件。
   * 记录采集成功/失败、命中版本、覆盖模型数、端点，便于排查「价格是否最新 / 走了哪个端点」。
   */
  writeGatewayPricingEvent(event: Record<string, unknown>): void {
    if (!this.initialized) return;
    try {
      this.writer.appendEvent({
        event: "GatewayPricingSync",
        session_id: this.metadata.session_id,
        timestamp: new Date().toISOString(),
        data: event,
      });
    } catch { /* 采集遥测写入失败不影响主流程 */ }
  }
}
