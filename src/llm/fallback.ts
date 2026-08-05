/**
 * 模型回退机制 — 统一的重试引擎
 *
 * Phase 1.2 重写：从双引擎（fallback.ts + retry-engine.ts）统一为单一引擎，
 * 吸收 retry-engine 的全部能力：
 * - QuerySource 前台/后台差异化
 * - 指数退避 + 25% jitter + Retry-After 优先
 * - x-should-retry header 支持
 * - rate-limit-reset header 解析
 * - 529 连续计数 + Fallback 触发
 * - max_tokens 溢出自动恢复
 * - 401 认证刷新重试
 * - keep-alive 管理（ECONNRESET/EPIPE）
 * - Telemetry 埋点回调
 *
 * Phase 4：persistent retry + fast-mode 预留
 */

import type { Provider } from "./provider.ts";
import type { SendParams, StreamEvent } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { emitTimeoutFired, armIneffectiveCheck, getStreamSnapshot } from "../trace/stream-observer.ts";
import { currentSseDumpContext } from "./sse-chunk-dumper.ts";
import {
  classifyError,
  classifyStreamError,
  TerminalError,
  RetryableError,
  StreamValidationError,
  isAbortError,
  toAbortError,
  RequestAbortedError,
  getNetworkErrorCode,
  parseXShouldRetry,
  is401Error,
  is408Error,
  is409Error,
} from "./errors.ts";
import { ModelAvailabilityService } from "./availability.ts";
import { lookupRegistry } from "./model-registry.ts";
import { lookupWireModelAlias } from "./wire-model.ts";
import { dispatchRetryTelemetry, type RetryTelemetryEvent } from "./retry-telemetry.ts";
import { DEFAULTS as NETWORK_DEFAULTS } from "../config/network-profile.ts";
import { calculateRetryDelay as calculateSharedRetryDelay } from "./retry-backoff.ts";
import { disableKeepAlive } from "./keepalive.ts";
// S4：非流式降级。`src/api/stream-handler.ts` 早就写好了这套（含 SSE 事件重放），
// 但生产零消费——只有测试在驱动它（§2.3 / §七 F7 记的三处"死能力"之一）。
// 这里把它接进漏斗，成为空响应/传输错误的最后一道兜底。
import {
  convertToStreamEvents,
  isStreamingTransportError,
} from "../api/stream-handler.ts";

// ═══════════════════════════════════════════════════════════════════
// 查询来源分类（从 retry-engine.ts 吸收）
// ═══════════════════════════════════════════════════════════════════

/** 查询来源分类。
 *
 *  B2：细分出全部 agent 源。原先只有笼统的 `"agent"`，而事故里六个并行子代理、
 *  强制总结轮、fork 子代理、无头子进程走的是**四条不同代码路径**——用同一个标签
 *  既无法在遥测里区分「哪条路径在重试」，也无法给它们各自的 529 前后台语义。
 *  对照 CC `withRetry.ts` 的 `FOREGROUND_529_RETRY_SOURCES`：它把全部 agent 源
 *  都算前台（子代理是用户等待链路的一环，不是可丢弃的后台 side-call）。 */
export type QuerySource =
  | "main_thread"     // 用户主对话（前台）
  | "agent"           // 子代理（前台）——保留为兼容旧调用方的笼统标签
  | "agent:builtin"   // 内置子代理主流（前台）
  | "agent:custom"    // 自定义子代理主流（前台）
  | "agent:summary"   // 子代理强制总结轮（前台，B2 首次获得韧性）
  | "agent:fork"      // fork 子代理（前台）
  | "headless"        // 无头子进程主循环（前台，绝不阻塞）
  | "compact"         // 上下文压缩（前台）
  | "goal_eval"       // 目标评估（B3 接线）
  | "hook_agent"      // hook 触发的 agent（B3 接线）
  | "memory_recall"   // 记忆召回（B3 接线）
  | "summary"         // 摘要生成（后台）
  | "title"           // 标题生成（后台）
  | "classifier";     // 分类器（后台）

/** 前台查询源 — 用户正在等待结果，529 时重试。
 *
 *  B2：全部 agent 源纳入前台（对照 CC `FOREGROUND_529_RETRY_SOURCES`）。
 *  子代理失败会直接让父代理的任务失败，属于用户等待链路，不是可丢弃的后台调用——
 *  事故 20260730-183103 里两个子代理失败即导致整轮审计残缺，正是把它们当"可丢"的代价。 */
export const FOREGROUND_SOURCES = new Set<QuerySource>([
  "main_thread",
  "agent",
  "agent:builtin",
  "agent:custom",
  "agent:summary",
  "agent:fork",
  "headless",
  "compact",
  "goal_eval",
  "hook_agent",
]);

/** 后台查询遇到 529 时是否仍重试 */
export function shouldRetry529(querySource?: QuerySource): boolean {
  return querySource === undefined || FOREGROUND_SOURCES.has(querySource);
}

// ═══════════════════════════════════════════════════════════════════
// 重试常量
// ═══════════════════════════════════════════════════════════════════

// B1-b：原 CONNECTION_RETRY 常量已删除。它只服务于「连接阶段重试 for 循环」，
// 而该循环在生产路径不可达（sendMessageStream 是惰性 async generator 工厂 +
// 两个 provider 都把连接错误转成流内 error 事件而非抛出），已随之删除。
// 现在只有一套重试参数 STREAM_RETRY，不再有两份平行配置可供漂移。

/** 流式阶段重试配置。
 *  maxDelayMs 从 10s 抬到 120s（最关键）：旧值 10s 把流式退避硬砍到 10 秒内，遇限流/过载时
 *  几次重试全挤在十几秒内打完，未给服务恢复窗口。现与 network-profile.retryBackoffMaxMs 对齐。 */
const STREAM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 120000,
};

/** 默认流超时（毫秒）。配置-1：不再独立硬编码 300_000，从 network-profile 统一默认值派生
 *  （生产路径由 app.ts 注入 streamTimeoutMs；此默认仅在未注入时兜底，如直接 new ModelFallback() 的测试）。 */
const DEFAULT_STREAM_TIMEOUT_MS = NETWORK_DEFAULTS.watchdogNoProgressMs; // 300s

/** max_tokens 溢出恢复：安全余量 */
const SAFETY_BUFFER = 1_000;

/** max_tokens 溢出恢复：最小输出 token 数的绝对下限（兜底）。
 *  历史固定值 3000——对输出能力 128K 的模型，降到 3K 几乎等于放弃恢复。
 *  现改为"按 contextLimit 比例算 floor，再与此绝对下限取较大者"（见 resolveFloorOutputTokens），
 *  可经 SID_RECOVERY_FLOOR_TOKENS 显式覆盖。保成功：让需要大段输出的任务更易从溢出中恢复。 */
const FLOOR_OUTPUT_TOKENS = 3_000;

/** 溢出恢复 floor 占 contextLimit 的比例（默认 5%）。
 *  对 1M 窗口模型给出 50K floor，对 200K 给 10K，远比固定 3K 更贴合模型能力。 */
const FLOOR_OUTPUT_RATIO = 0.05;

/** 解析溢出恢复的最小输出 token 下限。
 *  优先级：SID_RECOVERY_FLOOR_TOKENS 显式值 > contextLimit × 5%（与绝对下限取大）> 绝对下限 3000。
 *  非法 env 值（NaN/≤0）静默回退，绝不更紧。 */
function resolveFloorOutputTokens(contextLimit: number): number {
  const raw = process.env.SID_RECOVERY_FLOOR_TOKENS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (contextLimit > 0) {
    return Math.max(FLOOR_OUTPUT_TOKENS, Math.floor(contextLimit * FLOOR_OUTPUT_RATIO));
  }
  return FLOOR_OUTPUT_TOKENS;
}

/** 连续 529 触发降级的阈值 */
const MAX_529_CONSECUTIVE = 3;

/** persistent retry 最大退避（5 分钟） */
const PERSISTENT_MAX_DELAY_MS = 300_000;

/** S4：非流式降级的 maxTokens 上限。
 *
 *  非流式响应没有增量、要等整段生成完才返回，maxTokens 越大越容易整体超时。
 *  与 `api/stream-handler.ts` 的 `DEFAULT_NON_STREAMING_MAX_TOKENS` 同值——
 *  刻意不 import 那个常量：它是 stream-handler 自己的默认值（可被其 config 覆盖），
 *  这里是漏斗侧的独立决策，两者同值是巧合而非依赖，绑在一起反而制造隐式耦合。 */
const NON_STREAMING_MAX_TOKENS = 16_384;

/** S3：一次重试要「有意义」所需的最小剩余时间（毫秒）。
 *
 *  含义：退避睡完之后，至少还得留这么多时间给那次请求，重试才不是白等。
 *  取 5s 的依据——它要盖住「建连 + 首字节」这段：本仓 TTFT 观测（trace-digest 的
 *  gen 分位数）典型在 1–3s，5s 给慢网关留了余量，又不至于把"其实还来得及"的重试
 *  提前砍掉。这个值不需要精确：它是**方向正确的粗钳制**，用来替换"睡满 120s 再被
 *  外层 abort"这个明确错误的现状。 */
const MIN_USEFUL_ATTEMPT_MS = 5_000;

/**
 * S2：共享冷却对齐时的错峰槽位数。
 *
 * ── 为什么必须错峰（实测，不是推论）──
 *
 * 第一版只做"对齐到同一个冷却截止时刻"，实测**完全没有收益**：
 * 6 路并发、1.2s 窗口只放行 2 个请求的配额网关下，对齐前后
 * 「总请求 16 / 被拒 10」一模一样。原因是把 6 路对齐到同一时刻 = **惊群**：
 * 大家一起睡、一起醒、一起再撞一次，只是把撞击时刻整齐地推后了一点。
 *
 * 加上错峰后（同一实验）：总请求 15→9、被拒 9→3。
 * 「冷却」提供的是"该等多久"，「错峰」提供的是"别一起醒"——两者缺一不可。
 *
 * 槽位数取 6：与典型并发子代理规模（本仓 Task 并发上限量级）同阶。槽位多于实际
 * 并发数只会让错峰更细、不会变坏；少于并发数则退化为部分惊群。
 */
const COOLDOWN_STAGGER_SLOTS = 6;

/**
 * S2：把调用方身份映射成稳定的错峰槽位。
 *
 * 用 `agentId` 的哈希而非随机数：**同一个 agent 每次重试落在同一槽位**，
 * 于是"谁在什么时刻发请求"可复现、可在轨迹里对照。随机错峰同样能减少碰撞，
 * 但会让同一条轨迹两次回放的时序不同——排查限流问题时这是很贵的代价。
 *
 * 无 agentId（主循环）→ 槽位 0，即不错峰：主循环只有一路，错峰无意义。
 */
/** S2：每个错峰槽位的间隔（毫秒）。
 *
 *  取 300ms 的依据：它要比"网关放行一个请求所需的时间"稍大，才能让相邻槽位真的
 *  落进不同的放行时机；又要足够小，使最坏错峰（槽位 5）只多等 1.5s——相对 429
 *  典型的秒级窗口是可接受的代价。这是**方向正确的粗参数**，不是精调值。 */
const COOLDOWN_STAGGER_MS = 300;

function cooldownStaggerSlot(agentId?: string): number {
  if (!agentId) return 0;
  let h = 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (h * 31 + agentId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % COOLDOWN_STAGGER_SLOTS;
}

// B1-b：原 PERSISTENT_HEARTBEAT_MS（30s）已删除。它只用于「重连同步抛错后 persistent
// 模式的心跳等待」——该分支随重连 try/catch 一并删除（重连现走 openStream 归一化，
// 同步抛错会回到统一的流式 catch，persistent 无限重试由
// `attempt >= streamMaxRetries` 分支的 `attempt = -1` 承担，语义不变且只剩一处）。

// ═══════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════

/**
 * Fallback 切换决策结果（onFallbackDecision 钩子返回）。
 * - switch：切换到指定模型（含已构建好的 provider）。
 * - abort：不切换，终止本轮（yield error 让上层展示"已终止，可重发/换模型"）。
 */
export type FallbackDecision =
  | { action: "switch"; model: string; provider: Provider }
  | { action: "abort" };

/** Fallback 切换模式：ask 询问用户 / auto 自动切默认 / off 不降级直接报错。 */
export type FallbackSwitchMode = "ask" | "auto" | "off";

/** 回退配置 */
export interface FallbackConfig {
  /** 降级 Provider */
  fallbackProvider?: Provider;
  /** 降级模型 */
  fallbackModel?: string;
  /**
   * 切换模式（默认 "auto"，保护直接 new ModelFallback() 的测试不被弹窗阻塞；
   * 生产由 app.ts 从 config.fallbackSwitchMode ?? "ask" 注入——即生产默认询问）。
   * - "ask"：主模型失败且有 onFallbackDecision 钩子时，询问用户是否切换、切到哪个模型。
   * - "auto"：保持旧行为，重试耗尽直接切 fallbackModel。
   * - "off"：不降级，直接 yield error 终止本轮。
   */
  fallbackSwitchMode?: FallbackSwitchMode;
  /**
   * 切换决策钩子（ask 模式生效）。由 app.ts 注入，内部弹出选择题并阻塞等用户作答。
   * 惰性执行：仅在真正触发降级那一刻调用（此时 TUI handler 早已就绪）。
   * headless/无交互通道时应内部降级为 auto 语义（切默认或 abort），绝不阻塞无头进程。
   */
  onFallbackDecision?: (ctx: {
    failedModel: string;
    reason: string;
    defaultFallbackModel?: string;
    signal?: AbortSignal;
  }) => Promise<FallbackDecision>;
  /** 模型可用性服务 */
  availability?: ModelAvailabilityService;
  /** 查询来源（前台/后台），影响 529 重试策略 */
  querySource?: QuerySource;
  /** 最大重试次数（默认由各阶段配置决定） */
  maxRetries?: number;
  /** 不确定-2/3：单次 executeWithFallback 调用内"连接阶段 + 流式阶段"重试的共享总上界。
   *  防止两阶段各自独立计数叠加成退避风暴。默认由 network-profile 的 maxRetriesPerCall 注入。 */
  maxRetriesPerCall?: number;
  /** 流式整体超时（毫秒，默认 5 分钟） */
  streamTimeoutMs?: number;
  /** 配置-1：退避基数（毫秒）。默认由 network-profile 的 retryBackoffBaseMs 注入 */
  retryBackoffBaseMs?: number;
  /** 配置-1：退避上限（毫秒）。默认由 network-profile 的 retryBackoffMaxMs 注入 */
  retryBackoffMaxMs?: number;
  /** 上下文窗口大小（用于 max_tokens 溢出恢复）。
   *  H1：此前构造从不注入 → tryRecoverMaxTokens 恒 return null（死代码）。
   *  静态值适合固定单模型；主模型可切换时优先用 resolveContextLimit 回调按当前模型实时解析。 */
  contextLimit?: number;
  /** H1：按模型名解析上下文窗口的回调（主模型可切换时用，优先于静态 contextLimit）。
   *  由 app.ts 注入，内部走 TokenEstimator().getContextLimit(model, availableModels)。 */
  resolveContextLimit?: (model: string) => number | undefined;
  /** H4：按模型名解析输出上限（maxOutputTokens）的回调。
   *  由 app.ts 注入，内部走 resolveMaxOutputTokensForModel（availableModels > 注册表）。
   *  fallback 目标钳制 maxTokens 时用它替代「只查内置注册表」，避免注册表外的自定义模型漏钳制。 */
  resolveMaxOutputTokens?: (model: string) => number | undefined;
  /** 是否禁用 keep-alive（ECONNRESET 后自动置位） */
  disableKeepAlive?: boolean;
  /** Phase 4：无人值守 persistent retry 模式 */
  persistent?: boolean;
  /** Phase 4：fast-mode 感知（预留，暂未启用） */
  fastMode?: boolean;
  /** Telemetry 埋点回调 */
  onTelemetry?: (event: RetryTelemetryEvent) => void;
  /**
   * B5-7（§5 新发现 3）：凭据刷新钩子。401 时调用，返回 true 表示**已刷新凭据、可重试**。
   *
   * ── 为什么需要它 ──
   *
   * 在它落地前，401 的处理是「用**同一份旧凭据**重试一次，再失败就 `TerminalError`
   * → `markTerminal` 拉黑该模型」。这是个**错误归因**：模型是好的，过期的是凭据。
   * 而 `markTerminal` 是进程内永久态（`availability.ts`：terminal 默认不可被自动流程
   * 恢复），于是一次凭据过期能让一个健康模型在整个会话里不可用。
   *
   * 对照 CC `withRetry.ts:234-251`——它在认证失败时做**真刷新**并重建 client，覆盖
   * OAuth / OAuth-revoked / Bedrock / Vertex / stale-conn 五类。**这条对我们比对 CC
   * 更重要**：CC 那几类都是它自家凭据体系，而我们是多 provider，每接一家就多一套凭据
   * 过期语义，此前一套刷新都没有。
   *
   * ── 契约 ──
   *
   * - 返回 `true`：凭据已刷新 → 漏斗**不退避、立即重试一次**（新凭据值得马上试）；
   * - 返回 `false` / 抛异常 / 未注入：退化为原有的 retry-once 语义（用旧凭据重试一次），
   *   即**行为与改造前逐字节一致**。未注入不该让 401 变得更糟，这是接线安全的底线。
   * - 抛异常不向上传播（刷新失败是预期内的一种结果，不是 bug），只记日志。
   *
   * 注意 `needsAuthRefresh` 闸门必须保留（防无限刷新循环）：无论刷新成功与否，
   * 一次调用后即置位，第二个 401 落 `classifyError` → terminal，不会反复刷新。
   *
   * @param provider 发生 401 的 provider 名（`provider.name()`），用于分派到对应的凭据体系
   * @param error 原始 401 错误，供实现方判别子类型（如 OAuth revoked vs 普通过期）
   */
  onAuthRefresh?: (provider: string, error: unknown) => Promise<boolean>;
  /**
   * S4（§2.3 / §七 F7）：是否允许**非流式降级**。默认 `true`。
   *
   * ── 为什么这是"接线"而不是"新功能" ──
   *
   * `src/api/stream-handler.ts` 的 `streamWithFallback` 早就实现了完整的
   * 「流式失败 → 非流式请求 → 把结果重放成 SSE 事件」，与 CC `claude.ts:2465`
   * 的非流式降级同型。但实测**生产零消费**：`grep -rn "streamWithFallback" src/`
   * 只命中它自己的定义，驱动它的全是测试。这是本方案 §七 F7 记录的三处"死能力"
   * 之一——写好了、有注释、有单测，唯独没有生产调用方。
   *
   * ── 它兜住的是哪一类失败 ──
   *
   * 重试解决的是"再试一次可能就好了"，而这里兜的是**重试必然无效**的一类：
   * 网关/中转层不支持 SSE（回 `text/html` 错误页、回空 body、chunked 编码被
   * 截断）。这类故障对同一个流式请求是确定性的，重试 N 次得到 N 次同样的空——
   * 正是北极星"更省"最讨厌的形态。换成非流式请求反而能穿过去。
   *
   * 关闭它只会退回"重试耗尽 → 换模型/报错"，不会更糟；故默认开。
   */
  allowNonStreamingFallback?: boolean;
  /**
   * S2（超越 CC）：是否参与**共享限流冷却**。默认 `true`。
   *
   * 一路撞 429 就在共享的 `availability` 上写下冷却截止时刻，其余并发路径发请求前
   * 先等这段——把"6 路各撞一次限流"变成"1 路撞、其余延迟起跑"。
   *
   * CC 没有这层：它的重试逐调用独立，自己的注释承认"each retry is 3-10x gateway
   * amplification"却无跨 agent 协调。我们能做是因为 `availability` 本就是刻意共享的
   * 那个对象（见 `availability.ts` 的 S2 段注释）。
   *
   * 关掉它只会退回 CC 的语义（各自撞、各自退避），不会更糟。
   */
  respectSharedCooldown?: boolean;
}

/** 回退事件监听器 */
export interface FallbackListener {
  onRetry?: (attempt: number, error: string, delayMs: number) => void;
  onFallback?: (reason: string, fallbackModel: string) => void;
  /** 后台 529 被丢弃时的回调 */
  on529Dropped?: (querySource: string) => void;
  /** max_tokens 自动调整时的回调 */
  onMaxTokensAdjusted?: (originalTokens: number, adjustedTokens: number) => void;
}

/** 系统 API 错误消息 — 对标 claude-code 的 SystemAPIErrorMessage */
export interface SystemAPIErrorMessage {
  type: "system_api_error";
  /** 用户可读的错误描述 */
  content: string;
  /** 等待时间（毫秒） */
  delayMs: number;
  /** 当前尝试次数（1-based） */
  attempt: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 错误分类标签 */
  category: string;
}

/**
 * 单次调用级参数覆盖（B1-a）。
 *
 * 对标 claude-code `withRetry.ts` 的 `options` 参数：**per-call 差异靠传参表达，
 * 而不是靠实例配置**。背景（§0.2 实证 4）：`querySource` 等字段原本只存在于
 * `this.config`，而 `app.ts:709` 是全进程单实例 —— 单实例无法同时正确服务
 * `main_thread`（前台）与 `agent`（子代理）/ 后台 side-call，而 529 前后台闸门
 * 恰好依赖 querySource，故闸门在并发下必然失准。
 *
 * 未传的字段**全部回落 `this.config`**，因此现有调用方（`engine.ts:275` 等）
 * 零改动、行为逐字段不变。B2 让子代理走漏斗时，只需在这里传
 * `{ querySource: "agent:builtin", switchMode: "auto" }` —— 旧文档因
 * 「生产默认 switchMode=ask 需要 TUI」把「子代理不能降级」记为合理设计差异，
 * 改成 per-call 后这只是一个参数，差异消失。
 */
export interface PerCallOptions {
  /** 本次调用的查询来源（影响 529 前后台闸门）。未传回落 config.querySource。 */
  querySource?: QuerySource;
  /** 本次调用的降级模式。未传回落 config.fallbackSwitchMode（生产默认 ask）。 */
  switchMode?: FallbackSwitchMode;
  /** 本次调用的降级目标模型。未传回落 config.fallbackModel。 */
  fallbackModel?: string;
  /** 本次调用的降级目标 provider。未传回落 config.fallbackProvider。 */
  fallbackProvider?: Provider;
  /** 本次调用的重试上界。未传回落 config.maxRetries。 */
  maxRetries?: number;
  /** 发起方 agent 标识（遥测归因与 B4 per-agent 状态隔离用）。 */
  agentId?: string;
  /**
   * S3（§5 缺口 C）：本次调用的 **wall-clock 截止时刻**（`Date.now()` 同轴的毫秒时间戳）。
   *
   * ── 它修的是什么 ──
   *
   * `maxRetries` 是**次数**上界，但子代理真正的硬约束是**时间**（`sub-agent.ts` 的
   * `timeoutCtrl`，180–360s）。两者不换算，于是"重试 10 次"是个幻觉：实测退避累计
   * （base 5s、cap 120s）第 7 次就到 395s，早已超过 300s 预算——外层 abort 一到，
   * **最后一次退避连等完都等不到**，那次重试的等待时间纯属白烧。
   *
   * CC 不需要这个，因为它的子代理没有 wall-clock 超时；我们有，所以必须做。
   *
   * ── 语义 ──
   *
   * 传了就在每次退避**前**检查："这次退避 + 一次最小请求耗时"是否还塞得进剩余预算。
   * 塞不进就**立即停止重试**（转降级/换模型），而不是先睡满 120s 再被外层砍断。
   * 好处是把本会白等的时间还给"至少留个能落地的结论"。
   *
   * 不传则完全退化为原有的纯次数上界（行为逐字节不变）。
   */
  deadlineAt?: number;
}

/** 内部重试上下文 */
interface RetryContext {
  /** 401 认证错误的「只重试一次」闸门（首个 401 置位并立即重试；第二个 401 因已置位落到
   *  classifyError → TerminalError → markTerminal + fallback）。
   *  N1（另案）：当前无 auth 刷新钩子消费此标志——重试用的仍是同一份旧凭据，故它实际只是
   *  「retry-once 闸门」而非「刷新触发器」。真正接线凭据刷新钩子超出本次修复范围，另案跟踪；
   *  在此之前**不可删除**该标志——删了会让首个 401 直接 terminal 拉黑，丧失「瞬时 401 重试一次」
   *  的容错。 */
  needsAuthRefresh: boolean;
  /** 是否需要禁用 keep-alive（ECONNRESET 后置位） */
  disableKeepAlive: boolean;
  /** 连续 529 计数 */
  consecutive529: number;
  /** max_tokens 溢出恢复时的覆盖值 */
  maxTokensOverride?: number;
  /** 不确定-2/3：本次 executeWithFallback 调用内累计的重试次数（连接阶段 + 流式阶段共享）。
   *  达到 maxRetriesPerCall 上界后不再重试，防两阶段独立计数叠加成退避风暴。 */
  totalRetriesThisCall: number;
  /** B2（缺口 D）：最近一次被重试消化掉的错误原文与分类。
   *
   *  重试耗尽后 `tryFallback` 原先只报「已达最大重试次数且无可用 fallback」——
   *  **真实根因（429 限流 / 529 过载 / ECONNRESET）被整句吞掉**。用户看到的是一句
   *  没有信息量的"重试次数用尽"，排查方向会跑偏到超时/网络配置，而非限流。
   *  在此留档，供三条耗尽出口拼进文案。 */
  lastRetryError?: string;
  /** B2（缺口 D）：最近一次重试错误的分类 reason（rate_limit / overloaded / …）。 */
  lastRetryReason?: string;
  /** B1-a：本次调用内是否已降级过（二次降级短路判据）。
   *
   *  原为实例字段 `this.hasFallenBack`，而 `app.ts` 是全进程单实例 → 6 个并行子代理
   *  共用一个标志：A 降级过一次置位后，B/C/D 再想降级会被 `tryFallback` 静默拒绝
   *  （§0.2 实证 2）。`engine.ts:275` 每次调用前先 `reset()` 正是「状态共享」的证据
   *  —— 无状态的实现不需要 reset，且并行调用会互相 reset 打架。
   *
   *  搬到 per-call 后职责分离：**控制流判据**取本上下文（并发安全）；实例侧
   *  `lastCallFellBack` 只作为「上次调用是否降级」的**上报位**给
   *  `checkFallbackOccurred()`（`loop.ts:2643` 消费它 yield tombstone）。 */
  hasFallenBack: boolean;
  /** B1-a：本次调用的有效 per-call 覆盖（未传字段已在入口回落 this.config）。 */
  perCall: PerCallOptions;
}

// ═══════════════════════════════════════════════════════════════════
// ModelFallback — 核心引擎
// ═══════════════════════════════════════════════════════════════════

export class ModelFallback {
  private config: FallbackConfig;
  private listener: FallbackListener | null;
  /** B1-a：**上报位**，不是控制位。
   *
   *  记录「最近一次 executeWithFallback 调用是否发生过降级」，供
   *  `checkFallbackOccurred()` → `loop.ts:2643` yield tombstone 撤回已推给 UI 的
   *  半截 assistant 消息。降级的**控制流判据**已搬进 per-call 的
   *  `RetryContext.hasFallenBack`（见其注释），故并行子代理不再互相干扰彼此的
   *  降级能力；本字段被并发覆盖最坏只影响 tombstone 时机（UI 提示），不影响韧性决策。 */
  private lastCallFellBack = false;
  private availability: ModelAvailabilityService;

  constructor(config: Partial<FallbackConfig> = {}, listener?: FallbackListener) {
    this.config = {
      fallbackProvider: config.fallbackProvider,
      fallbackModel: config.fallbackModel,
      fallbackSwitchMode: config.fallbackSwitchMode,
      onFallbackDecision: config.onFallbackDecision,
      availability: config.availability,
      querySource: config.querySource,
      maxRetries: config.maxRetries,
      maxRetriesPerCall: config.maxRetriesPerCall,
      streamTimeoutMs: config.streamTimeoutMs,
      retryBackoffBaseMs: config.retryBackoffBaseMs,
      retryBackoffMaxMs: config.retryBackoffMaxMs,
      contextLimit: config.contextLimit,
      resolveContextLimit: config.resolveContextLimit,
      resolveMaxOutputTokens: config.resolveMaxOutputTokens,
      disableKeepAlive: config.disableKeepAlive,
      persistent: config.persistent,
      fastMode: config.fastMode,
      onTelemetry: config.onTelemetry,
      // B5-7：漏字段就是"钩子注了但永不被调用"的半接线状态——本构造函数逐字段
      // 手抄，新增配置极易漏在这里，且漏了不会有任何报错（只是能力静默消失）。
      onAuthRefresh: config.onAuthRefresh,
      // S4：同上，漏抄即"降级能力又变回死代码"。`??` 而非直接赋值——默认开。
      allowNonStreamingFallback: config.allowNonStreamingFallback ?? true,
      // S2：同上。默认开——无限流时冷却表恒空，零影响。
      respectSharedCooldown: config.respectSharedCooldown ?? true,
    };
    this.listener = listener ?? null;
    this.availability = config.availability ?? new ModelAvailabilityService();
  }

  /** 获取可用性服务（供外部访问） */
  getAvailability(): ModelAvailabilityService {
    return this.availability;
  }

  /**
   * 运行时更新 fallback 目标（/model fallback 切换用）。
   * fallback 的 provider/model 原本只在构造时定死；/model 切换 fallbackModel 后若不同步更新，
   * 主模型出错降级仍会走旧目标。传 undefined 表示清除 fallback（回退到"无降级"）。
   */
  setFallbackTarget(fallbackModel: string | undefined, fallbackProvider: Provider | undefined): void {
    this.config.fallbackModel = fallbackModel;
    this.config.fallbackProvider = fallbackProvider;
    // 已发生过的降级状态重置，避免旧降级标志影响新目标判定。
    this.lastCallFellBack = false;
  }

  /**
   * 执行带回退的操作
   *
   * 分阶段：
   * 1. 连接阶段重试（含 401 认证刷新、ECONNRESET keep-alive 处理）
   * 2. 流式阶段消费（含 529 计数、max_tokens 溢出恢复、超时保护）
   * 3. Fallback Provider
   */
  async *executeWithFallback(
    primaryProvider: Provider,
    params: SendParams,
    signal?: AbortSignal,
    perCallOptions?: PerCallOptions,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    // B1-a：解析 per-call 覆盖 —— 未传的字段**逐个回落 this.config**，
    // 故现有三参调用方（engine.ts:275 等）行为逐字段不变。
    const perCall: PerCallOptions = {
      querySource: perCallOptions?.querySource ?? this.config.querySource,
      switchMode: perCallOptions?.switchMode ?? this.config.fallbackSwitchMode,
      fallbackModel: perCallOptions?.fallbackModel ?? this.config.fallbackModel,
      fallbackProvider: perCallOptions?.fallbackProvider ?? this.config.fallbackProvider,
      maxRetries: perCallOptions?.maxRetries ?? this.config.maxRetries,
      agentId: perCallOptions?.agentId,
      // S3：无实例级回落——deadline 是**单次调用**的属性（每个子代理各自的剩余预算），
      // 放进 this.config 会让全进程单实例的漏斗把一个子代理的截止时刻套到别人头上，
      // 正是 B1-a 修掉的那类状态共享缺陷。
      deadlineAt: perCallOptions?.deadlineAt,
    };

    // § 注入流内遥测转发：把 provider 产出的协议无关 StreamTelemetrySignal
    // 转成 RetryTelemetryEvent，进入统一遥测通道（events.jsonl / trace-digest.ts）。
    // 链式保留调用方可能已传入的回调（通常为空）。
    const upstreamStreamTelemetry = params.onStreamTelemetry;
    params = {
      ...params,
      onStreamTelemetry: (sig) => {
        try { upstreamStreamTelemetry?.(sig); } catch { /* ignore */ }
        // B4：流内诊断事件（stream_stall / stream_*_timeout / stream_completed）同样带
        // agentId。它们是 per-attempt 的耗时/停顿数据——并行子代理下若不带身份，
        // digest 的 gen 耗时分位数会把 6 路混在一起算，看不出是哪一路在卡。
        this.emitTelemetry({ ...sig, model: params.model }, perCall.agentId);
      },
    };

    // 检查模型可用性
    const availCheck = this.availability.isAvailable(params.model);
    if (!availCheck.available) {
      log.warn("FALLBACK", `模型 ${params.model} 不可用: ${availCheck.reason}`);
      yield* this.tryFallback(params, signal);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // S2：共享限流冷却 —— 别人刚撞了限流，我先缓一缓再发
    // ═══════════════════════════════════════════════════════════════
    //
    // 位置刻意在**首次建流之前**：整个 S2 的价值就在于"这一发根本不该发出去"。
    // 放到重试里就晚了——那时限流请求已经打出去、已经被网关计数、已经放大了级联。
    //
    // 与 S3 的关系：冷却等待也要受时间预算约束。若等完冷却就没时间发请求了，
    // 那等待毫无意义（还不如立刻发，赌限流窗口已过），故此处直接跳过冷却。
    if (this.config.respectSharedCooldown !== false) {
      const cd = this.availability.getCooldownInfo(params.model);
      if (cd) {
        // 同重试侧一样要错峰——入口处更需要：并发子代理往往是被同一个 Task 批次
        // **同时**拉起的，不错峰就是整批一起醒、一起撞。
        const slot = cooldownStaggerSlot(perCall.agentId);
        const waitMs = cd.remainingMs + slot * COOLDOWN_STAGGER_MS;
        const budgetOk =
          perCall.deadlineAt === undefined ||
          perCall.deadlineAt - Date.now() > waitMs + MIN_USEFUL_ATTEMPT_MS;
        if (budgetOk) {
          log.info(
            "FALLBACK",
            `S2：模型 ${params.model} 处于共享限流冷却（剩余 ${cd.remainingMs}ms，` +
            `错峰槽位 ${slot} → 等 ${waitMs}ms，已累计 ${cd.hits} 次限流），延迟起跑避免级联放大`,
          );
          this.emitTelemetry({
            type: "shared_cooldown_wait",
            model: params.model,
            delayMs: waitMs,
            remainingMs: cd.remainingMs,
            error: cd.reason,
          }, perCall.agentId);
          await this.sleep(waitMs, signal);
          if (signal?.aborted) throw new RequestAbortedError("Request aborted");
        } else {
          // 预算不够等 → 不等。记一笔，否则"为什么这一路没遵守冷却"无从解释。
          log.info(
            "FALLBACK",
            `S2：冷却剩余 ${cd.remainingMs}ms（错峰后 ${waitMs}ms）但时间预算不足，跳过等待直接发起`,
          );
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 流超时保护：AbortController 主动中断 HTTP 连接
    // ═══════════════════════════════════════════════════════════════
    const streamTimeoutMs = this.config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    let streamTimeoutCtl = new AbortController();
    let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
    // 缺口 2 进阶：fallback 整体超时 fire 后武装未生效检查；abort 被流循环观察到时 disarm。
    // 若 5s 内 abort 未能中断已进入的 SSE 消费（parseSSE hang 场景）→ TimeoutIneffective。
    let disarmStreamIneffective: (() => void) | null = null;

    const startStreamTimeout = () => {
      streamTimeoutId = setTimeout(() => {
        log.warn("FALLBACK", `流式整体超时: ${streamTimeoutMs / 1000}s，主动中断连接`);
        // 缺口 2：记录 fallback 流式整体超时触发
        // B4：带 agentId —— 漏斗这层用的是 ambient `turnIndex`（主循环轮次），子代理调用
        // 也会拿到同一个 turnIndex。不带身份时，子代理的 fallback 超时会被写进**主循环那份
        // 快照**的 timeoutsFired，污染主循环的重开成因归因（并行子代理越多污染越重）。
        emitTimeoutFired(currentSseDumpContext().turnIndex, "fallback_stream_timeout", {
          threshold_ms: streamTimeoutMs,
          model: params.model,
        }, perCall.agentId);
        // 缺口 2 进阶：武装未生效检查（abort 后若流循环 5s 内未抛出 → TimeoutIneffective）
        disarmStreamIneffective = armIneffectiveCheck(
          currentSseDumpContext().turnIndex,
          "fallback_stream_timeout",
          "abort_not_observed_by_stream_after_5s",
        );
        streamTimeoutCtl.abort();
      }, streamTimeoutMs);
      // 不调 unref()：fdb47f30 教训——index 23 请求发出后 hang 死,若定时器被 unref,
      // 在事件循环空闲时 Node/Bun 不保证它按时 fire,整体超时形同虚设、无法自愈。
      // 这里是"受管理的非 unref 定时器"：resetStreamTimeout / 正常收尾路径都会 clearTimeout,
      // 不会泄漏阻止进程退出。宁可让它确实持有事件循环,也要保证超时一定触发。
    };

    const resetStreamTimeout = () => {
      if (streamTimeoutId !== null) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = null;
      }
      // 缺口 2 进阶：旧超时窗口作废 → disarm 其未生效检查（避免误报）。
      (disarmStreamIneffective as (() => void) | null)?.();
      disarmStreamIneffective = null;
      streamTimeoutCtl = new AbortController();
      startStreamTimeout();
    };

    const makeCombinedSignal = (): AbortSignal => {
      if (signal && !signal.aborted) {
        return AbortSignal.any([signal, streamTimeoutCtl.signal]);
      }
      return streamTimeoutCtl.signal;
    };

    startStreamTimeout();

    // 重试上下文（跨 phase 共享）
    const ctx: RetryContext = {
      needsAuthRefresh: false,
      disableKeepAlive: this.config.disableKeepAlive ?? false,
      consecutive529: 0,
      totalRetriesThisCall: 0,
      // B1-a：降级控制态从实例字段搬入 per-call 上下文（并发安全，见字段注释）。
      hasFallenBack: false,
      perCall,
    };
    // 不确定-2/3：单次调用共享重试预算上界（连接 + 流式两阶段合并计数）。
    const maxRetriesPerCall = this.config.maxRetriesPerCall ?? NETWORK_DEFAULTS.maxTimeoutRetries;

    // ═══════════════════════════════════════════════════════════════
    // 建流（不重试）——B1-b：原「阶段 1：连接重试 for 循环」已删除
    // ═══════════════════════════════════════════════════════════════
    //
    // 为什么删：`sendMessageStream` 是 **async generator 工厂**，调用它只是构造
    // 生成器对象、**不执行任何函数体**（惰性求值）——真正的网络 IO 直到下方流式
    // 阶段第一次 `iterator.next()` 才发生。因此原循环的 catch 在生产路径**永远
    // 捕不到网络错误**：401/ECONNRESET/529 全部在流式阶段抛出。
    //
    // 更强的证据（实测两条 provider 路径）：两个 provider 都**不抛**连接错误，
    // 而是把它转成流内 error 事件 —— `anthropic.ts:610-617` catch 后
    // `yield {type:"error"}`，`openai.ts:862-880` 对 `!response.ok` 同样
    // `yield {type:"error"}`。即连接失败在生产路径连「抛出」都不会发生，
    // 原循环的 catch 是双重不可达。
    //
    // 于是它承载的三项能力（401 retry-once 闸门 / ECONNRESET 禁 keep-alive /
    // 529 计数）全是**死代码**，看着有、实际从不生效。B1-b 把它们搬进下方流式
    // catch（真正会执行的地方），此处只保留一次同步建流：
    //   - 生产：构造生成器不会抛，等价于原循环首次迭代成功；
    //   - 测试：少数 mock 用**非 generator 函数**同步 throw（如 `throwProvider`），
    //     这条 try 保证它们仍被归一化为流式路径的可重试错误，而不是穿透成未捕获异常。
    // 防复发：`tests/llm/fallback-connection-loop-removed.test.ts` 钉住「本文件
    // 不得再出现连接阶段重试循环」，避免日后被"修活"成第二份平行实现。
    const initialParams = ctx.maxTokensOverride
      ? { ...params, maxTokens: ctx.maxTokensOverride }
      : params;
    let stream: AsyncIterable<StreamEvent> = this.openStream(
      primaryProvider,
      initialParams,
      makeCombinedSignal(),
      signal,
    );

    // ═══════════════════════════════════════════════════════════════
    // 流式消费（唯一的重试点）
    // ═══════════════════════════════════════════════════════════════
    let hasYieldedContent = false;
    const streamMaxRetries = perCall.maxRetries ?? STREAM_RETRY.maxRetries;

    try {
      for (let attempt = 0; attempt <= streamMaxRetries; attempt++) {
        try {
          log.debug("FALLBACK", `流式阶段尝试 ${attempt + 1}/${streamMaxRetries + 1}`);

          // P0-2 修复：将 `for await` 改为手动迭代 + Promise.race(abortPromise)。
          // 当 SSE 半开（TCP 连接在、服务端不再发 event）时，`for await` 内的 reader.read()
          // 永不 settle，signal?.aborted 检查永远执行不到。通过 race abort，abort 触发时
          // 立即 reject，不等下一个 event。参考模板：openai.ts:1291-1343。
          const abortPromise: Promise<never> | null = (() => {
            if (!signal || signal.aborted) return null;
            return new Promise<never>((_, reject) => {
              const onAbort = () => reject(new RequestAbortedError("请求已中止（abort race）"));
              signal.addEventListener("abort", onAbort, { once: true });
            });
          })();

          const iterator = stream[Symbol.asyncIterator]();
          let iterDone = false;
          while (!iterDone) {
            const racers: Promise<IteratorResult<StreamEvent>>[] = [iterator.next()];
            if (abortPromise) racers.push(abortPromise as any);
            const iterResult = await Promise.race(racers);
            if (iterResult.done) {
              iterDone = true;
              break;
            }
            const event = iterResult.value;

            if (signal?.aborted) {
              throw new RequestAbortedError("请求已中止");
            }

            if (event.type === "error") {
              if (isAbortError(event.error.message)) {
                throw toAbortError(event.error.message);
              }

              // ── max_tokens 溢出自动恢复（感知 thinking budget）──
              const maxTokensResult = this.tryRecoverMaxTokens(
                event.error.message,
                params.model,
                params.thinking?.budgetTokens,
              );
              if (maxTokensResult !== null) {
                const adjusted = maxTokensResult;
                const original = params.maxTokens;
                log.info("FALLBACK", `max_tokens 溢出恢复: ${original} → ${adjusted}`);
                ctx.maxTokensOverride = adjusted;
                this.listener?.onMaxTokensAdjusted?.(original, adjusted);
                this.emitTelemetry({
                  type: "max_tokens_adjust",
                  model: params.model,
                  originalTokens: original,
                  adjustedTokens: adjusted,
                }, perCall.agentId);
                // 跳出当前流，进入流式重试（会使用新的 maxTokens）
                throw new RetryableError(event.error.message, "server_error");
              }

              const classified = event.error.streamLevel
                ? classifyStreamError(
                    params.model.split(":")[0] || params.model,
                    event.error.message,
                    event.error.type,
                    event.error.statusCode,
                  )
                : classifyError(new Error(event.error.message));

              if (classified instanceof TerminalError) {
                this.availability.markTerminal(params.model, classified.reason);
                log.error("FALLBACK", `流式终端错误: ${classified.reason}`);
                yield* this.tryFallback(params, signal, ctx);
                return;
              }

              // ── 529 计数维护 ──
              if (classified instanceof RetryableError && classified.reason === "overloaded") {
                ctx.consecutive529++;
              } else {
                ctx.consecutive529 = 0;
              }

              // ── 后台 529 立即放弃 ──
              if (
                classified instanceof RetryableError &&
                classified.reason === "overloaded" &&
                !shouldRetry529(perCall.querySource)
              ) {
                log.info("FALLBACK", `后台查询遇 529，立即放弃`);
                this.listener?.on529Dropped?.(perCall.querySource ?? "unknown");
                this.emitTelemetry({
                  type: "529_dropped",
                  model: params.model,
                  querySource: perCall.querySource ?? "unknown",
                }, perCall.agentId);
                yield* this.tryFallback(params, signal, ctx);
                return;
              }

              // ── 529 连续达上限 ──
              if (
                classified instanceof RetryableError &&
                classified.reason === "overloaded" &&
                ctx.consecutive529 >= MAX_529_CONSECUTIVE
              ) {
                log.warn("FALLBACK", `连续 ${ctx.consecutive529} 次 529，触发降级`);
                this.emitTelemetry({
                  type: "fallback",
                  model: params.model,
                  fallbackModel: perCall.fallbackModel,
                  error: "连续 529 错误",
                }, perCall.agentId);
                yield* this.tryFallback(params, signal, ctx);
                return;
              }

              if (classified instanceof RetryableError && attempt < streamMaxRetries) {
                log.warn("FALLBACK", `流式错误，准备重试: ${event.error.message}`);
                throw classified;
              }

              yield* this.tryFallback(params, signal, ctx);
              return;
            }

            // B2：`content_block_start` 也算"有内容"。
            //
            // 原判据只认 `content_block_delta`，于是**无参数工具调用被误判为空响应**：
            // 一个 `tool_use` 块若 input 为 `{}`（无 `input_json_delta`），整条流只有
            // start + stop 两个事件，零 delta → 下方 `!hasYieldedContent` 触发
            // StreamValidationError("响应为空") → 白重试 N 次后转 fallback。
            //
            // 这在主路径长期未暴露，是因为主对话模型几乎总先输出一段文本再调工具；
            // 而子代理**第一个动作就是调工具**（explore 直接 grep/glob），无参数工具
            // （如 noop / 无参 MCP 工具）恰好命中。B2 把子代理接进漏斗才让它显形——
            // 这类"接线后才暴露的既存缺陷"正是收敛成唯一漏斗的收益：一处修好，四条路径同得。
            //
            // 判据仍然有效：伪装成功的空流（网关回 text/html 错误页被解析成 0 事件）
            // 连 `content_block_start` 都没有，照旧被拦住。
            if (event.type === "content_block_delta" || event.type === "content_block_start") {
              hasYieldedContent = true;
            }

            yield event;
          }

          // 验证流完整性
          if (!hasYieldedContent) {
            throw new StreamValidationError("响应为空", "empty_response");
          }

          // 成功完成，标记模型健康
          this.availability.markHealthy(params.model);
          // S2：成功产出是"限流窗口已过"的**最强信号**——比任何 Retry-After 估计都可靠。
          // 不清的话，后续并发路径会守着一段已经作废的冷却白等（把 S2 从"省"变成纯"慢"）。
          this.availability.clearCooldown(params.model);
          return;

        } catch (err) {
          // 用户主动中断（ESC）：立即传播，终止整轮对话
          if (signal?.aborted) {
            throw toAbortError(err);
          }

          // 区分「流式超时中断」与「其他 abort」：
          // - 超时中断（streamTimeoutCtl 触发）当作可重试的 timeout 错误，
          //   走正常重试 → fallback 路径（对标文档承诺的「超时 → 流重试 → fallback」）
          // - 其他 abort（非用户、非超时，理论上少见）仍传播
          const isTimeoutAbort = isAbortError(err) && streamTimeoutCtl.signal.aborted;
          // 缺口 2 进阶：流循环观察到超时 abort → 超时确实生效，disarm 未生效检查。
          if (isTimeoutAbort) {
            (disarmStreamIneffective as (() => void) | null)?.();
            disarmStreamIneffective = null;
          }
          if (isAbortError(err) && !isTimeoutAbort) {
            throw toAbortError(err);
          }

          // ═══════════════════════════════════════════════════════════
          // B1-b 复活①：401 retry-once 闸门
          // ═══════════════════════════════════════════════════════════
          //
          // **必须置于 classifyError 之前**：401 会被 classifyError 判成
          // TerminalError("auth_failed") → 下面立刻 markTerminal 拉黑模型 + 转
          // fallback。放在其后等于闸门永不生效（这正是它在原连接循环里"看着有、
          // 实际从不执行"之外的第二重失效）。
          //
          // 语义（沿用 RetryContext.needsAuthRefresh 注释）：首个 401 置位并**不退避**
          // 立即重试一次——覆盖凭据瞬时失效/网关抖动；第二个 401 因已置位而落到
          // classifyError → TerminalError → 拉黑 + fallback，不会无限重试。
          //
          // B5-7：`onAuthRefresh` 注入后，这里不再只是「retry-once 闸门」，而是
          // **先真刷新、再重试**（原 N1 另案的落地点，注释随之更新）。未注入钩子时
          // 完全退化为原语义（旧凭据重试一次），行为逐字节不变。
          if (!isTimeoutAbort && is401Error(err) && !ctx.needsAuthRefresh) {
            // 闸门先置位、再刷新：即便刷新实现里自己抛错或卡住，也不会因为"没走到置位"
            // 而让下一个 401 再刷一次 —— 防无限刷新循环的责任在闸门，不在刷新实现。
            ctx.needsAuthRefresh = true;

            // B5-7：真刷新。失败/未注入都不致命——退化成"用旧凭据重试一次"的原行为。
            let refreshed = false;
            if (this.config.onAuthRefresh) {
              try {
                refreshed = await this.config.onAuthRefresh(primaryProvider.name(), err);
              } catch (refreshErr) {
                // 刷新失败是预期内结果之一（refresh token 也过期了 / 刷新端点不可达），
                // 不是 bug，故不向上传播：继续走"旧凭据重试一次"，再失败自然落 terminal。
                log.warn("FALLBACK", `凭据刷新钩子抛错，退化为旧凭据重试一次: ${refreshErr}`);
              }
            }

            log.info(
              "FALLBACK",
              refreshed
                ? "401 认证错误，凭据已刷新，立即重试（不退避）"
                : `401 认证错误，触发 retry-once 闸门并重试（${this.config.onAuthRefresh ? "凭据刷新未成功" : "未注入凭据刷新钩子"}，不退避）`,
            );
            this.emitTelemetry({
              type: "auth_refresh",
              model: params.model,
              error: String(err),
              provider: primaryProvider.name(),
              // B5-7：区分"真刷新过"与"只是重试一次"。缺了它，遥测里两种语义
              // 完全同形——正是本项要消除的那类"看着有能力、实际没有"的盲区。
              authRefreshed: refreshed,
            }, perCall.agentId);
            resetStreamTimeout();
            // 作废语义广播（与下方重试路径同理）：401 重试同样是**全新请求**。
            // 401 通常在建流阶段就抛、尚未产出内容块，但「通常」不是「必然」——
            // 网关可能先回 200 + 部分 SSE 再插一个 401 错误事件。少这一行就留下
            // 一条能绕过作废广播的路径，事故会以更低频率复发（更难查）。
            yield { type: "stream_restart", reason: "auth_refresh", attempt: attempt + 1 };
            try {
              const retryParams = ctx.maxTokensOverride
                ? { ...params, maxTokens: ctx.maxTokensOverride }
                : params;
              stream = primaryProvider.sendMessageStream(retryParams, makeCombinedSignal());
              hasYieldedContent = false;
              // 不消耗 attempt 预算：retry-once 闸门自带"只一次"上界（needsAuthRefresh
              // 已置位），且不退避——与 CC withRetry 的 401 刷新重试同语义。
              attempt--;
              continue;
            } catch (reauthErr) {
              if (signal?.aborted || isAbortError(reauthErr)) {
                throw toAbortError(reauthErr);
              }
              log.error("FALLBACK", `401 重试建流失败: ${reauthErr}`);
              yield* this.tryFallback(params, signal, ctx);
              return;
            }
          }

          // ═══════════════════════════════════════════════════════════
          // B1-b 复活②：ECONNRESET / EPIPE → 禁用 keep-alive
          // ═══════════════════════════════════════════════════════════
          //
          // 与①同理，原先只在不可达的连接 catch 里置位；且置位的两个字段
          // （ctx.disableKeepAlive / config.disableKeepAlive）**全仓无消费者**，
          // 即便执行了也是空转。现同时接线真消费者：`keepalive.ts` 的进程级开关
          // → provider fetch 选项 `{ keepalive: false }`（anthropic 走自定义 fetch
          // 包装，openai 走 fetch init 展开）。
          //
          // 为什么必须禁用而非原样重试：ECONNRESET/EPIPE 的典型成因是连接池里的
          // socket 已被对端/网关单方面关闭而本地仍认为可用，**原样重试会命中同一条
          // 死连接**，重试次数被白烧。禁用复用后强制新建连接才可能自愈。
          const netCode = getNetworkErrorCode(err);
          if ((netCode === "ECONNRESET" || netCode === "EPIPE") && !ctx.disableKeepAlive) {
            log.info("FALLBACK", `${netCode} 检测到，禁用 keep-alive 连接池（进程级，后续请求不复用连接）`);
            ctx.disableKeepAlive = true;
            this.config.disableKeepAlive = true;
            disableKeepAlive(); // ← 真消费者：进入 provider 的 fetch 选项
          }

          const classified = isTimeoutAbort
            ? new RetryableError(`流式整体超时（${streamTimeoutMs / 1000}s 无数据）`, "timeout")
            : classifyError(err);

          if (classified instanceof TerminalError) {
            this.availability.markTerminal(params.model, classified.reason);
            log.error("FALLBACK", `终端错误: ${classified.reason}`);
            yield* this.tryFallback(params, signal, ctx);
            return;
          }

          // B2：**无法分类**的错误不重试（fail-fast），直接转 fallback。
          //
          // `classifyError` 的契约是「分类不出来就原样返回入参」（其第 4 分支注释写明
          // "无法分类，返回原始错误"）——即既非 RetryableError 也非 TerminalError。
          // 此前这类错误落进下方重试路径，等于把「我不知道这是什么」当成「值得重试」：
          // 最坏烧掉 maxRetries × 退避（默认 10 × 5s+）才放弃，而它们典型是**确定性
          // 故障**（provider 实现抛错、参数拼装 bug、SDK 版本不兼容），重试必然再失败。
          //
          // 判据取自本文档 §0.4：能力应由分类器**显式授予**，而非"没被否决就放行"。
          // 被删的 R1 循环在这点上是对的（`canRetry = !!retryable && …`），收敛进漏斗时
          // 必须把这条语义一并带过来——否则"删掉平行实现"会顺手弄丢一个正确行为。
          if (!(classified instanceof RetryableError)) {
            log.warn("FALLBACK", `错误无法分类为可重试，不重试直接转 fallback: ${classified.message}`);
            // 根因留档（缺口 D）：本路径没走重试，需在此显式记一笔，否则耗尽文案会丢掉它。
            ctx.lastRetryError = classified.message;
            // S4：**保留精确 reason**，不要一律压成 "unclassified"。
            //
            // `StreamValidationError("响应为空", "empty_response")` 也走这条 fail-fast 分支
            // （它不是 RetryableError），压成 "unclassified" 会丢掉"这是空响应"这个关键信息：
            // 空响应恰好是非流式降级唯一能治的那一类（网关回 text/html 错误页 / 空 body），
            // 而 "unclassified"（provider 实现 bug、参数拼装错）恰好是**不该**降级的一类。
            // 两者压成同一个标签，S4 就只能"要么都降级、要么都不降级"——前者浪费一次请求，
            // 后者让 S4 在它最该生效的场景上永久失效。
            ctx.lastRetryReason =
              classified instanceof StreamValidationError ? classified.reason : "unclassified";

            // S4：fail-fast 不代表"不许换传输方式"。
            //
            // 这条分支的语义是「**重试**必然无效」，而非流式降级不是重试——它是同一个
            // 模型换一条传输通道，恰好能穿过"重试多少次都一样空"的网关故障。
            // 门槛未被放宽：内部 transportish 白名单只放行 empty_response / network /
            // timeout，provider 代码 bug（unclassified）照旧直接转 fallback。
            const degradeOutcome = { degraded: false };
            yield* this.tryNonStreamingDegrade(
              primaryProvider, params, ctx, hasYieldedContent, signal, degradeOutcome,
            );
            if (degradeOutcome.degraded) return;

            yield* this.tryFallback(params, signal, ctx);
            return;
          }

          if (attempt >= streamMaxRetries) {
            log.warn("FALLBACK", `流式阶段重试 ${streamMaxRetries} 次后仍失败`);
            this.availability.markRetryOnce(params.model, "流式传输失败");

            // persistent 模式：无限重试
            if (this.config.persistent) {
              log.info("FALLBACK", "persistent 模式，继续重试");
              const delayMs = PERSISTENT_MAX_DELAY_MS;
              this.emitTelemetry({
                type: "persistent_retry_wait",
                model: params.model,
                delayMs,
              }, perCall.agentId);
              yield* this.sleepWithProgress(
                delayMs,
                attempt + 1,
                streamMaxRetries + 1,
                "persistent_retry",
                signal,
              );
              // 重置计数，继续循环
              attempt = -1;
              continue;
            }

            break;
          }

          // 不确定-2/3：单次调用共享重试预算上界。persistent（无人值守）模式豁免——它明确
          // 要求无限重试直到成功，不受此上界约束（其无限循环在上面的 attempt>=streamMaxRetries
          // 分支内自成一路）。非 persistent 路径达到上界即停止重试、转 fallback。
          if (!this.config.persistent && ctx.totalRetriesThisCall >= maxRetriesPerCall) {
            log.warn(
              "FALLBACK",
              `流式阶段：单次调用累计重试已达上界 ${maxRetriesPerCall}，停止重试转 fallback`,
            );
            this.availability.markRetryOnce(params.model, "单次调用重试上界");
            break;
          }
          ctx.totalRetriesThisCall++;

          // B2（缺口 D）：留档真实根因。每次重试都覆盖，故耗尽时留下的是**最后一次**
          // 失败原因——正是用户最需要看到的那个。
          ctx.lastRetryError = classified.message;
          ctx.lastRetryReason = classified instanceof RetryableError
            ? classified.reason
            : undefined;

          // 流式重试：重新发起完整请求
          const delayMs = this.calculateRetryDelay(err, attempt, classified, STREAM_RETRY.maxDelayMs);

          // ═══════════════════════════════════════════════════════════
          // S2（写侧）：撞到限流 → 在共享 availability 上写下冷却截止时刻
          // ═══════════════════════════════════════════════════════════
          //
          // 只对 `rate_limit` 写，不对 `overloaded`(529) 写：529 是服务端**容量**问题，
          // 各路退避重试本身就是正确应对（换个时刻可能就有容量了）；而 429 是**配额**
          // 问题，配额是全局的——别人替我撞出来的那条信息，对我同样有效。
          //
          // 写的是"退避时长"而非固定值：`delayMs` 已经融合了服务端 Retry-After /
          // rate-limit-reset（见 retry-backoff.ts 的优先级），是我们手上关于"这个限流
          // 窗口多长"的**最好估计**。冷却上限由 markRateLimited 内部钳制。
          if (
            this.config.respectSharedCooldown !== false &&
            classified instanceof RetryableError &&
            classified.reason === "rate_limit"
          ) {
            this.availability.markRateLimited(params.model, delayMs, classified.message);
          }

          // ═══════════════════════════════════════════════════════════
          // S2（读侧之二）：退避时长向共享冷却对齐
          // ═══════════════════════════════════════════════════════════
          //
          // 为什么入口那个读点不够（实测，非推论）：6 路并发子代理**几乎同时**发起，
          // 全部在任何人撞限流之前就通过了入口检查 —— 冷却表那时还是空的。真正的
          // 放大发生在**重试循环**里：6 路各自按自己的退避节奏重试，彼此不知道
          // 别人刚刚才撞了一次。第一版只写不在此处读，实测 `shared_cooldown_wait`
          // 事件为 0，即"能力已接线但从未生效"——正是 §七 F7 要求用断言钉住的形态。
          //
          // 取 max 而非相加：冷却与退避是对**同一个**限流窗口的两个估计，不是两段
          // 独立等待。相加会让 6 路一起过度退避，把 S2 从"更省"做成纯"更慢"。
          let effectiveDelayMs = delayMs;
          if (this.config.respectSharedCooldown !== false) {
            const cdRemaining = this.availability.getCooldownRemaining(params.model);
            if (cdRemaining > 0) {
              // 错峰：冷却给"等多久"，槽位给"别和别人同时醒"。缺了错峰就是惊群，
              // 实测零收益（见 COOLDOWN_STAGGER_SLOTS 注释里的前后数据）。
              const slot = cooldownStaggerSlot(perCall.agentId);
              const staggered = cdRemaining + slot * COOLDOWN_STAGGER_MS;
              if (staggered > effectiveDelayMs) {
                this.emitTelemetry({
                  type: "shared_cooldown_wait",
                  model: params.model,
                  attempt: attempt + 1,
                  delayMs: staggered,
                  remainingMs: cdRemaining,
                  error: `retry aligned to shared cooldown (slot ${slot})`,
                }, perCall.agentId);
                effectiveDelayMs = staggered;
              }
            }
          }

          // ═══════════════════════════════════════════════════════════
          // S3（§5 缺口 C）：按 wall-clock 剩余预算钳制
          // ═══════════════════════════════════════════════════════════
          //
          // 判据不是"还有没有剩余时间"，而是"**这次退避睡完之后还来得及发一次请求吗**"。
          // 只判前者会退化成"睡到被外层 abort"——那正是现状：最后一次退避等不完就被砍，
          // 白烧最长 120s，且用户拿不到任何结论。
          //
          // persistent（无人值守）豁免：它的语义就是"等多久都行"，与截止时刻互斥。
          // 注意判的是 `effectiveDelayMs`（已含 S2 冷却对齐）而不是原始 `delayMs`：
          // 顺序上 S2 先抬高等待、S3 再裁决，否则会"按短的批准、按长的睡"——
          // 批准了一个其实塞不进预算的等待，S3 就等于没做。
          if (!this.config.persistent && perCall.deadlineAt !== undefined) {
            const remaining = perCall.deadlineAt - Date.now();
            if (remaining <= effectiveDelayMs + MIN_USEFUL_ATTEMPT_MS) {
              log.warn(
                "FALLBACK",
                `S3：剩余预算 ${Math.max(0, remaining)}ms 不足以「退避 ${effectiveDelayMs}ms + 一次请求」，` +
                `停止重试（已重试 ${ctx.totalRetriesThisCall} 次）`,
              );
              this.emitTelemetry({
                type: "retry_budget_exhausted",
                model: params.model,
                attempt: attempt + 1,
                delayMs: effectiveDelayMs,
                remainingMs: Math.max(0, remaining),
                error: classified.message,
              }, perCall.agentId);
              // 留档：让耗尽文案说得出"是时间不够，不是次数用尽"——两者修法完全不同
              // （前者调 timeout / 降退避，后者查限流），归因混淆会把排查带偏。
              ctx.lastRetryError =
                `${classified.message}（剩余时间预算不足，已重试 ${ctx.totalRetriesThisCall} 次后停止）`;
              this.availability.markRetryOnce(params.model, "时间预算不足");
              break;
            }
          }

          // 日志/监听器/遥测统一报 effectiveDelayMs——报 delayMs 会让"日志说等 400ms、
          // 实际等了 2s"，是排查时最耗时间的那种不一致。
          log.info("FALLBACK", `流式重试 ${attempt + 1}，延迟 ${effectiveDelayMs}ms`);
          this.listener?.onRetry?.(attempt + 1, classified.message, effectiveDelayMs);
          // §6.3 重复开流成因遥测：推导本次"重新获取流"的结构化原因。
          // 优先取 stream-observer snapshot 里最近触发的超时层（idle_timeout /
          // content_progress_timeout / fallback_stream_timeout——这些是导致重开的精确信号），
          // 无超时记录则取 classified.reason（network_error/overloaded/empty_response 等）。
          // 这是 §2.7 "同一轮重复开流"观测盲区的根因定位钥匙——回放会话时可据此判断
          // 重复开流是 idle 超时、内容进展超时、还是网络抖动导致，而非仅凭 error 字符串猜测。
          // 控制流收窄在深层嵌套循环里退化为 Error，用显式 instanceof 取 reason。
          let reopenReason = "unknown";
          if (classified instanceof RetryableError) {
            reopenReason = classified.reason;
          }
          try {
            const { turnIndex, loopId } = currentSseDumpContext();
            // B4：读快照与上面 emitTimeoutFired 必须用**同一把 key**（含 agentId），
            // 否则子代理读到的是主循环的 timeoutsFired —— reopenReason 会把主循环的
            // 超时层安到子代理头上，是比"没有归因"更坏的错误归因。
            const snapshot = getStreamSnapshot(turnIndex, loopId, perCall.agentId);
            if (snapshot && snapshot.timeoutsFired.length > 0) {
              reopenReason = snapshot.timeoutsFired[snapshot.timeoutsFired.length - 1];
            }
          } catch { /* 可观测性不影响重试 */ }
          // B4：这条是"哪个子代理重试了几次"的**主数据源**——按 agentId 聚合
          // type=retry 事件即可回答。缺了它只能聚合到 querySource 类别，
          // 分不清"一路撞 N 次"和"N 路各撞一次"（修法完全不同）。
          this.emitTelemetry({
            type: "retry",
            model: params.model,
            attempt: attempt + 1,
            delayMs: effectiveDelayMs,
            error: classified.message,
            phase: "stream",
            reopenReason,
          }, perCall.agentId);

          // S2：睡 `effectiveDelayMs`（已向共享冷却对齐），不是原始 delayMs。
          // 这一行是 S2 从"写了个字段"变成"真的少发一发请求"的落点。
          yield* this.sleepWithProgress(
            effectiveDelayMs,
            attempt + 1,
            streamMaxRetries + 1,
            "retry",
            signal,
          );

          // 重置超时计时器
          resetStreamTimeout();

          // ═══════════════════════════════════════════════════════════
          // 作废语义广播：重开前告知消费方「上一次尝试的内容块全部作废」
          // ═══════════════════════════════════════════════════════════
          //
          // 2026-08-04 事故根因修复。下面重开的是**全新请求**（不是断点续传），
          // 但此前没有任何信号把这件事告诉消费方：消费方累加器跨重试存活，于是
          // 第一次尝试的残骸（含被 socket 截断成 `input={}` 的 tool_use）被焊死在
          // 第二次完整响应前面 → F1 误判为模型退化 + 健康 tool_use 变孤儿。
          //
          // 必须在 openStream **之前** yield：openStream 同步抛错时会被归一化成
          // 「首次 next() 即抛」的流并回到本 catch 继续重试，若放在其后，那条路径上
          // 的重开就不会广播作废（正是「看着有能力、实际有路径绕过」那类缺陷）。
          yield { type: "stream_restart", reason: reopenReason, attempt: attempt + 1 };

          // 重新获取流
          // B1-b：与首次建流走**同一个** openStream —— 同步抛错被归一化成「首次
          // next() 即抛」的流，于是下一轮迭代照常进入本 catch 继续退避重试。
          //
          // 修复前这里是独立 try/catch，同步抛错直接 `break` 转 fallback，形成
          // 「首次同步抛错可重试、重试时同步抛错却立刻放弃」两套语义。实测回归：
          // `stream-interrupt-recovery.test.ts` 的 ECONNRESET 用例断言 3 次尝试
          // （2 失败 + 1 成功），旧 break 路径只跑 2 次就降级。
          stream = this.openStream(
            primaryProvider,
            ctx.maxTokensOverride ? { ...params, maxTokens: ctx.maxTokensOverride } : params,
            makeCombinedSignal(),
            signal,
          );
          // 清空内容标志（新流需要重新检测）
          hasYieldedContent = false;
        }
      }
    } finally {
      if (streamTimeoutId !== null) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = null;
      }
      // 缺口 2 进阶：流式阶段收尾（正常/异常/fallback）→ disarm 未生效检查兜底。
      (disarmStreamIneffective as (() => void) | null)?.();
      disarmStreamIneffective = null;
    }

    // ═══════════════════════════════════════════════════════════════
    // S4：重试耗尽 → **先**试同模型非流式降级，再考虑换模型
    // ═══════════════════════════════════════════════════════════════
    //
    // 次序刻意如此：非流式降级是「同模型换传输方式」，而 tryFallback 是「换模型」。
    // 前者代价更小、语义更保守（模型能力/价格/上下文窗口全不变），且它兜住的那类
    // 故障（网关不支持 SSE）换模型往往**根本治不了**——同一个网关的另一个模型
    // 一样不支持流式。反过来把换模型放前面，会用一次无谓的模型切换掩盖真实成因。
    {
      const degradeOutcome = { degraded: false };
      yield* this.tryNonStreamingDegrade(
        primaryProvider,
        params,
        ctx,
        hasYieldedContent,
        signal,
        degradeOutcome,
      );
      if (degradeOutcome.degraded) return;
    }

    // ═══════════════════════════════════════════════════════════════
    // 重试耗尽 → Fallback Provider
    // ═══════════════════════════════════════════════════════════════
    yield* this.tryFallback(params, signal, ctx);
  }

  /**
   * 尝试使用 fallback Provider。
   *
   * 三态切换（fallbackSwitchMode，默认 auto）：
   * - "off"：不降级，直接 yield error 终止本轮。
   * - "auto"（或无 onFallbackDecision 钩子）：保持旧行为，直接切 config.fallbackModel。
   * - "ask"：调 onFallbackDecision 钩子（app.ts 注入，弹选择题）决定切哪个模型 / 不切。
   *
   * 所有降级路径都汇聚到本方法，故三态决策在此单点生效即全覆盖。
   */
  private async *tryFallback(
    params: SendParams,
    signal?: AbortSignal,
    ctx?: RetryContext,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (signal?.aborted) {
      throw new RequestAbortedError("Request aborted");
    }

    // B2（缺口 D）：把真实根因拼进耗尽文案。
    //
    // 修前三条耗尽出口都只报「已达最大重试次数…」——**根因整句丢失**。子代理侧尤其致命：
    // `sub-agent.ts` 再按 timeoutCtrl.aborted 包一层"子代理执行超时"，最终用户看到的是
    // 「超时」，而真相是「限流重试 N 次仍失败」，排查方向被彻底带偏。
    // 已重试次数一并透出（回答"到底试了几次"，也让缺口 C 的"10 次是幻觉"可被实测观察）。
    const rootCause = ((): string => {
      if (!ctx?.lastRetryError) return "";
      const reason = ctx.lastRetryReason ? `${ctx.lastRetryReason}: ` : "";
      return `（重试 ${ctx.totalRetriesThisCall} 次，最后一次失败原因 — ${reason}${ctx.lastRetryError}）`;
    })();

    // 已经用过 fallback（二次降级）→ 不再重复切换，直接报错。
    // B1-a：判据取 per-call 上下文（并发安全）；ctx 缺省时（理论上不发生，仅防御
    // 未来新增调用路径漏传）回落实例上报位，保持旧行为而非静默放开二次降级。
    if (ctx ? ctx.hasFallenBack : this.lastCallFellBack) {
      log.error("FALLBACK", "主 Provider 失败且 fallback 已用尽");
      yield {
        type: "error",
        error: { message: `模型请求失败，已达最大重试次数且 fallback 已用尽${rootCause}` },
      };
      return;
    }

    // B1-a：per-call 覆盖优先（ctx 缺省时回落 config，行为不变）。
    // B2 让子代理走漏斗时传 switchMode:"auto" 即可绕开需要 TUI 的 ask 模式——
    // 旧文档把「子代理不能降级」记为设计差异，改成 per-call 后它只是一个参数。
    const pc = ctx?.perCall;
    const mode = pc?.switchMode ?? this.config.fallbackSwitchMode ?? "auto";
    const cfgFallbackModel = pc?.fallbackModel ?? this.config.fallbackModel;
    const cfgFallbackProvider = pc?.fallbackProvider ?? this.config.fallbackProvider;

    // ── "off"：禁用降级，直接报错终止本轮 ──
    if (mode === "off") {
      log.warn("FALLBACK", "fallbackSwitchMode=off，不降级，直接终止本轮");
      yield {
        type: "error",
        error: { message: `模型请求失败，已达最大重试次数（降级已禁用 fallbackSwitchMode=off）${rootCause}` },
      };
      return;
    }

    // ── 决定切换目标：ask 走钩子，auto 走 config.fallbackModel ──
    let targetModel: string | undefined;
    let targetProvider: Provider | undefined;

    if (mode === "ask" && this.config.onFallbackDecision) {
      let decision: FallbackDecision;
      try {
        decision = await this.config.onFallbackDecision({
          failedModel: params.model,
          reason: "主模型重试耗尽",
          defaultFallbackModel: cfgFallbackModel || undefined,
          signal,
        });
      } catch (err) {
        // 钩子抛错 → fail-open 到 auto 语义（保任务不中断，切默认 fallback）。
        log.warn("FALLBACK", `onFallbackDecision 钩子异常，fail-open 到默认降级: ${err}`);
        decision = { action: "abort" };
        if (cfgFallbackProvider && cfgFallbackModel) {
          decision = {
            action: "switch",
            model: cfgFallbackModel,
            provider: cfgFallbackProvider,
          };
        }
      }
      if (decision.action === "abort") {
        log.warn("FALLBACK", "用户/钩子选择不切换，终止本轮");
        yield {
          type: "error",
          error: { message: "主模型请求失败，已终止本轮。可重新发送消息重试，或用 /model 切换模型。" },
        };
        return;
      }
      targetModel = decision.model;
      targetProvider = decision.provider;
    } else {
      // auto（或 ask 但无钩子）：切 config 里的默认 fallback。
      targetModel = cfgFallbackModel || undefined;
      targetProvider = cfgFallbackProvider;
    }

    // ── 无可用目标 → 报错 ──
    if (!targetProvider || !targetModel) {
      log.error("FALLBACK", "主 Provider 失败且无可用 fallback");
      yield {
        type: "error",
        error: { message: `模型请求失败，已达最大重试次数且无可用 fallback${rootCause}` },
      };
      return;
    }

    // ── 执行切换 ──
    // B1-a：控制态记在 per-call 上下文（并发安全，决定"本次调用不再二次降级"）；
    // 实例侧只更新上报位，供 loop.ts 的 tombstone 检查消费。
    if (ctx) ctx.hasFallenBack = true;
    this.lastCallFellBack = true;
    log.warn("FALLBACK", `切换到 fallback 模型: ${targetModel}`);
    this.listener?.onFallback?.("主模型失败", targetModel);
    // B4：agentId 从 ctx.perCall 取（tryFallback 无 perCall 局部变量）。
    // ctx 缺省时（防御性，仅未来新增路径漏传 ctx）退化为不带身份，与旧行为一致。
    this.emitTelemetry({
      type: "fallback",
      model: params.model,
      fallbackModel: targetModel,
      error: "主模型失败",
    }, ctx?.perCall.agentId);

    // 作废语义广播（第三个重开点）：降级换的是**另一个模型**的全新请求，
    // 主模型此前流出的部分内容块同样全部作废。
    //
    // 这条路径比重试路径更容易漏：tryFallback 的多数入口是「建流即失败」，看着不会
    // 有残留内容；但 executeWithFallback 里存在**流中途**转降级的分支（连续 529、
    // 重试次数耗尽、`!hasYieldedContent` 校验失败等），那时主模型的块已经在消费方
    // 累加器里了。少这一行，事故就换成「主模型半截 + fallback 模型完整」的形态复发。
    yield { type: "stream_restart", reason: "fallback_switch" };

    yield* this.streamFromFallback(params, targetModel, targetProvider, signal);
  }

  /**
   * 建流并归一化「同步抛错」（B1-b）。
   *
   * `sendMessageStream` 在生产路径是 async generator 工厂：调用它只构造生成器、
   * 不执行函数体，故网络错误都在首次 `next()`（即流式消费阶段）抛出，本函数的
   * catch 在生产路径不会命中。但部分测试 mock 用**非 generator 函数**同步 throw，
   * 若不归一化就会穿透成未捕获异常、绕过全部韧性逻辑。
   *
   * 归一化为「首次 next() 即抛该错误」的流后，两类 provider 走**完全相同**的
   * 处置路径（401 闸门 / keep-alive / 529 计数 / 退避重试），不再有第二份实现。
   *
   * abort 例外：用户中断（ESC）必须立即传播，不能包装成可重试错误。
   */
  private openStream(
    provider: Provider,
    params: SendParams,
    combinedSignal: AbortSignal | undefined,
    outerSignal: AbortSignal | undefined,
  ): AsyncIterable<StreamEvent> {
    try {
      return provider.sendMessageStream(params, combinedSignal);
    } catch (err) {
      if (outerSignal?.aborted || isAbortError(err)) {
        throw toAbortError(err);
      }
      const thrown = err;
      return (async function* (): AsyncIterable<StreamEvent> {
        throw thrown;
      })();
    }
  }

  /**
   * S4：尝试非流式降级。**成功产出内容才算降级成功**（返回 true）。
   *
   * 调用时机：流式阶段重试预算耗尽、即将转 `tryFallback`（换模型）之前。
   * 这个次序是刻意的——非流式降级是**同一个模型换个传输方式**，比换模型
   * 代价更小、语义更保守；只有它也不行才该动模型。
   *
   * 三条不降级的前提（任一不满足即返回 false，调用方照原路走 tryFallback）：
   *   ① 配置关闭；
   *   ② provider 不支持 `sendMessageNonStreaming`（可选方法）；
   *   ③ 下游已经收到过内容块 —— 重放会产出重复内容，宁可不降级。
   *
   * 失败不抛错：降级本身是兜底，它失败了不该盖掉真实根因（原始限流/超时错误
   * 才是用户要看的）。故内部 catch 后返回 false，让调用方继续原有的失败路径。
   */
  private async *tryNonStreamingDegrade(
    provider: Provider,
    params: SendParams,
    ctx: RetryContext,
    hasYieldedContent: boolean,
    signal: AbortSignal | undefined,
    outcome: { degraded: boolean },
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();

    if (this.config.allowNonStreamingFallback === false) return;
    if (!provider.sendMessageNonStreaming) return;
    // 已经流出去过内容 → 重放必然重复，直接放弃降级。
    if (hasYieldedContent) return;
    if (signal?.aborted) return;

    // 只对"传输层/空响应"类失败降级。限流(429)/过载(529)换成非流式一样会被限，
    // 白烧一次配额还多等一轮——那类该走的是重试与换模型，不是换传输方式。
    const lastReason = ctx.lastRetryReason ?? "";
    const transportish =
      lastReason === "empty_response" ||
      lastReason === "network_error" ||
      lastReason === "timeout" ||
      isStreamingTransportError(new Error(ctx.lastRetryError ?? ""));
    if (!transportish) return;

    // 与下方 fbCeiling 同口径：注册表兜底必须按真名查（别名会 miss → 不钳制 → 400）。
    const ceiling =
      this.config.resolveMaxOutputTokens?.(params.model) ??
      lookupRegistry(params.wireModel ?? lookupWireModelAlias(params.model) ?? params.model)?.maxOutputTokens;
    const nonStreamMaxTokens = Math.min(
      ctx.maxTokensOverride ?? params.maxTokens,
      // 非流式无增量，过大容易整体超时；与 stream-handler 的默认上限同源。
      NON_STREAMING_MAX_TOKENS,
      ...(ceiling ? [ceiling] : []),
    );

    log.warn(
      "FALLBACK",
      `S4：流式失败（${lastReason || "transport"}），同模型降级为非流式重试（maxTokens=${nonStreamMaxTokens}）`,
    );
    this.emitTelemetry({
      type: "non_streaming_degrade",
      model: params.model,
      error: ctx.lastRetryError,
      reopenReason: lastReason || undefined,
      provider: provider.name(),
    }, ctx.perCall.agentId);

    let result;
    try {
      result = await provider.sendMessageNonStreaming(
        { ...params, maxTokens: nonStreamMaxTokens },
        signal,
      );
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw toAbortError(err);
      // 降级失败：不抛，让调用方继续 tryFallback。原始根因已在 ctx.lastRetryError 里。
      log.warn("FALLBACK", `S4：非流式降级也失败，回到换模型路径: ${err}`);
      return;
    }

    // 空响应的降级又空 → 判定失败，交回原路径（否则会把"空"当成功收尾）。
    const hasContent = result.content.some(
      (b) => (b.type === "text" && b.text) || b.type === "tool_use",
    );
    if (!hasContent) {
      log.warn("FALLBACK", "S4：非流式降级仍返回空内容，回到换模型路径");
      return;
    }

    // 作废语义广播（第四个重开点，纵深防御）。
    //
    // 这里**当前**推理上是安全的：上面守卫 ③ 已挡掉「本次尝试流出过内容」，而更早尝试
    // 的内容块已被重试路径的 stream_restart 清空。但那份安全依赖「守卫 ③ 的 flag 是
    // per-attempt、且每次重试都广播过作废」这条跨函数的隐式链——链上任一环日后被改动
    // （比如把 flag 提成 per-call、或新增一条不广播的重开路径），这里就会静默开始重复
    // 拼接。清空一个本就为空的累加器是 no-op，代价为零，故显式广播把安全性变成局部可验。
    yield { type: "stream_restart", reason: "non_streaming_degrade" };

    for (const ev of convertToStreamEvents(result)) yield ev;
    // 同模型非流式成功 → 该模型是好的（是 SSE 通道不通），清除可能残留的拉黑态。
    this.availability.markHealthy(params.model, true);
    outcome.degraded = true;
    log.info("FALLBACK", "S4：非流式降级成功产出内容");
  }

  /**
   * 从指定 fallback provider/model 拉流并做完整性校验。
   *
   * 流完整性校验：与主路径（executeWithFallback 的 hasYieldedContent 校验）对齐。
   * 背景（事故复盘 session 20260708-102143）：tryFallback 此前直接透传 fallback 流，
   * 缺了主路径那道空响应校验——fallback provider 返回 0 内容事件（如网关回 text/html
   * 错误页被 openai.ts 拦成 error，或真返回空流）时不会 throw，空流被原样透传给上层，
   * 最终以 stopReason=null 静默收尾，用户界面毫无提示。这里补齐：fallback 流也必须产出
   * 过内容/工具调用，否则 yield error 事件（error 本身即显式失败信号，放行让上层
   * stream-processor 转 throw 展示）。
   */
  private async *streamFromFallback(
    params: SendParams,
    fallbackModel: string,
    fallbackProvider: Provider,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();
    // maxTokens 钳制：切到 fallback 模型时若沿用主模型的 maxTokens，可能超过 fallback
    // 模型的物理输出上限（如主模型 deepseek 384K 降级到 glm 128K），触发网关 400
    // "max_tokens out of range"——与主模型「切模型不重算 maxTokens」是同一类 bug。
    // 用内置注册表解析 fallback 模型上限并钳制（拿不到上限的未知模型不臆测、保持原值）。
    // wireModel 必须跟着 model 一起换：`{...params}` 会把**主模型的**真名原样带过来，
    // 而 provider 的 pickWireModel 优先级里 wireModel 高于 model —— 不重算就等于
    // 「切了 fallback 别名，却仍把主模型的真名发出去」，降级静默失效（发的还是刚失败的模型）。
    // 这里传 undefined 让 provider 侧走别名表兜底翻译 fallbackModel：ModelFallback 拿不到
    // availableModels（构造时只有回调，没有模型列表），交给进程级别名表是唯一正确的解析口。
    const fallbackParams = { ...params, model: fallbackModel, wireModel: undefined };
    // H4：钳制上限优先走 resolveMaxOutputTokens 回调（availableModels > 注册表，与主路径
    // resolveModelMaxOutputTokens 同源），回调缺失才回退到「只查内置注册表」。修前只查注册表，
    // fallback 目标若是注册表外的自定义模型 → fbCeiling=undefined → 不钳制 → 主模型高 maxTokens
    // 原样发给 fallback → 400 → markTerminal 拉黑 fallback 目标。
    // 注：第一分支（resolveMaxOutputTokens 回调，app.ts 注入）内部已走
    // resolveMaxOutputTokensForModel —— 它「先按别名查用户显式声明、注册表兜底按真名查」，
    // 口径正确。第二分支是回调缺失时的兜底（直接 new ModelFallback 的测试路径），
    // 必须自己把别名翻成真名：lookupRegistry 是精确/前缀/家族匹配，喂别名必然 miss
    // → fbCeiling=undefined → 不钳制 → 把主模型的高 maxTokens 原样发给 fallback 吃 400。
    // 这里拿不到 availableModels（ModelFallback 只持有回调），故走进程级别名表。
    const fbCeiling = this.config.resolveMaxOutputTokens?.(fallbackModel)
      ?? lookupRegistry(lookupWireModelAlias(fallbackModel) ?? fallbackModel)?.maxOutputTokens;
    if (fbCeiling && fallbackParams.maxTokens && fallbackParams.maxTokens > fbCeiling) {
      log.info(
        "FALLBACK",
        `fallback 模型 ${fallbackModel} maxTokens ${fallbackParams.maxTokens} 超上限 ${fbCeiling}，已钳制`,
      );
      fallbackParams.maxTokens = fbCeiling;
    }
    let fbYieldedContent = false;
    let fbYieldedError = false;
    for await (const event of fallbackProvider.sendMessageStream(fallbackParams, signal)) {
      // A4 纵深防御：fallback provider 流消费中检查 signal
      if (signal?.aborted) {
        throw new RequestAbortedError("请求已中止");
      }
      if (event.type === "content_block_delta") {
        fbYieldedContent = true;
      } else if (event.type === "error") {
        // fallback 流内已有显式 error（含 openai.ts 的 Content-Type 守卫）→ 透传，
        // 由上层 stream-processor 转 throw 展示；不再叠加"响应为空"掩盖真实原因。
        fbYieldedError = true;
      }
      yield event;
    }
    // fallback 流跑完却既无内容事件、也无显式 error → 判定空响应（伪装成功的空流）。
    if (!fbYieldedContent && !fbYieldedError) {
      log.error("FALLBACK", `fallback 模型 ${fallbackModel} 返回空响应（0 内容事件），判定失败`);
      yield {
        type: "error",
        error: {
          message: `fallback 模型 ${fallbackModel} 返回空响应（0 内容事件），疑似模型不可用或网关返回非流式错误页`,
          type: "empty_response",
          streamLevel: true,
        },
      };
      return;
    }
    // N2（H2 加剧因素修复）：降级流确实产出内容后，标记 fallbackModel 健康，清除其可能残留的
    // terminal 拉黑态。背景：主路径成功时会 markHealthy(params.model)（fallback.ts 阶段2 末尾），
    // 但降级路径此前无此调用——若 fallbackModel 曾被 markTerminal（如主备双模型走同一网关、网关
    // 整体故障双双 terminal），即便本次 streamFromFallback(T) 成功，T 的 availability 仍停在
    // terminal → 下一轮 isAvailable(T)=false 又 tryFallback。仅在确有内容产出时清除，空响应/纯
    // error 不清（那本就是失败信号）。
    if (fbYieldedContent) {
      // force=true：降级流确实产出内容是明确正向信号，强制清除 fallbackModel 可能残留的
      // terminal 态（否则被拉黑的模型即便成功也永远停在 terminal，下轮又被拦）。
      this.availability.markHealthy(fallbackModel, true);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 退避延迟计算（对标 retry-engine 的 getRetryDelay）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 计算重试延迟。
   * 优先级：服务端 Retry-After > rate-limit-reset > 指数退避 + 25% jitter
   */
  private calculateRetryDelay(
    err: unknown,
    attempt: number,
    classified: TerminalError | RetryableError | Error,
    maxDelayMs: number,
  ): number {
    // 实现已抽到 retry-backoff.ts，与子代理路径（agentic-loop.ts）共用同一份。
    // 此前只存在于本类内部 → 子代理走 provider 直连时完全无退避可用（事故
    // 20260730-183103-5e334145：一次 429 即失败）。
    return calculateSharedRetryDelay(err, attempt, classified, {
      maxDelayMs,
      retryBackoffBaseMs: this.config.retryBackoffBaseMs,
      retryBackoffMaxMs: this.config.retryBackoffMaxMs,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // max_tokens 溢出自动恢复
  // ═══════════════════════════════════════════════════════════════

  /**
   * 尝试从错误消息中恢复 max_tokens 溢出。
   * 返回调整后的 maxTokens，或 null（无法恢复）。
   *
   * @param errorMessage 错误消息
   * @param thinkingBudget thinking 预算 token 数（Extended Thinking 场景，需从可用空间中扣除）
   */
  private tryRecoverMaxTokens(
    errorMessage: string,
    model: string,
    thinkingBudget?: number,
  ): number | null {
    // H1：优先用 resolveContextLimit 回调按当前模型实时解析（主模型可切换），
    // 回调缺失或返回空时回退到静态 contextLimit。修前构造从不注入 contextLimit →
    // this.config.contextLimit 恒 undefined → 恒 return null，整套溢出恢复是死代码。
    const contextLimit = this.config.resolveContextLimit?.(model) ?? this.config.contextLimit;
    if (!contextLimit) return null;

    // 匹配: "188059 + 20000 > 200000"
    const sumMatch = errorMessage.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
    if (sumMatch) {
      const inputTokens = parseInt(sumMatch[1], 10);
      return this.computeSafeMaxTokens(inputTokens, contextLimit, thinkingBudget);
    }

    // 匹配: "prompt is too long: 137500 tokens > 135000 maximum"
    const tokenMatch = errorMessage.match(/(\d+)\s*tokens?\s*>\s*(\d+)/i);
    if (tokenMatch) {
      const inputTokens = parseInt(tokenMatch[1], 10);
      return this.computeSafeMaxTokens(inputTokens, contextLimit, thinkingBudget);
    }

    return null;
  }

  /**
   * 计算安全的 maxTokens 值。
   *
   * 对标 claude-code 的 thinking budget 感知：当 Extended Thinking 启用时，
   * thinking 消耗的 token 不计入 output，但仍占用上下文窗口，需要从可用空间中扣除。
   */
  private computeSafeMaxTokens(
    inputTokens: number,
    contextLimit: number,
    thinkingBudget?: number,
  ): number | null {
    const thinkingCost = thinkingBudget ?? 0;
    const available = Math.max(0, contextLimit - inputTokens - thinkingCost - SAFETY_BUFFER);
    const floor = resolveFloorOutputTokens(contextLimit);
    if (available < floor) return null;
    return Math.max(floor, available);
  }

  // ═══════════════════════════════════════════════════════════════
  // Telemetry 埋点
  // ═══════════════════════════════════════════════════════════════

  /**
   * B4：`agentId` 走**显式入参**，绝不缓存到实例字段。
   *
   * `app.ts` 是全进程单实例 ModelFallback，6 个并行子代理共用它——把 agentId 存成
   * `this._currentAgentId` 会重演 B1-a 修掉的那个缺陷：后进入的调用覆盖前一个，
   * 遥测里的 agentId 随机指向某个并发子代理，比没有这个字段更误导。
   *
   * 未传时不写该字段（不是写 undefined）：让主循环事件的 JSON 形状逐字节不变。
   */
  private emitTelemetry(event: RetryTelemetryEvent, agentId?: string): void {
    const stamped = agentId ? { ...event, agentId } : event;
    if (this.config.onTelemetry) {
      try {
        this.config.onTelemetry(stamped);
      } catch {
        // telemetry 不应影响主流程
      }
      // 已有 per-instance 消费方（主循环）→ 不再走全局观察者，避免同一事件写两遍。
      return;
    }
    // B4 / F7：没有 per-instance 回调的漏斗实例（子代理每次调用新建的那些）
    // 走全局观察者，否则它们的重试事件根本没有消费方——"加了 agentId 但落不到轨迹"。
    dispatchRetryTelemetry(stamped);
  }

  // ═══════════════════════════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════════════════════════

  /** 异步睡眠 */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new RequestAbortedError("Request aborted"));
    }

    // 防御性检查：某些环境（如 Bun）中 AbortSignal 可能不支持 addEventListener
    const hasListener = signal && typeof (signal as any).addEventListener === "function";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (hasListener) signal!.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        if (hasListener) signal!.removeEventListener("abort", onAbort);
        reject(new RequestAbortedError("Request aborted"));
      };

      if (hasListener) {
        signal!.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * 带进度报告的异步睡眠。
   *
   * 对标 claude-code 的 withRetry() 中 yield SystemAPIErrorMessage 到 UI 层：
   * - 短延迟（< 15s）：yield 一次进度消息后 sleep
   * - 长延迟（≥ 15s）：拆分为 10s 心跳块，每块 yield 剩余时间
   * 让 TUI 在重试等待期间能向用户展示"正在重试…"等反馈。
   */
  private async *sleepWithProgress(
    delayMs: number,
    attempt: number,
    maxRetries: number,
    category: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // 短延迟：单次 sleep + yield 一条进度消息
    if (delayMs < 15_000) {
      yield {
        type: "system_api_error",
        content: `正在重试 (${attempt}/${maxRetries})…`,
        delayMs,
        attempt,
        maxRetries,
        category,
      };
      await this.sleep(delayMs, signal);
      return;
    }

    // 长延迟（persistent retry 等）：拆分为心跳块
    const heartbeatMs = 10_000;
    let remaining = delayMs;
    let chunkIndex = 0;

    while (remaining > 0) {
      const chunk = Math.min(heartbeatMs, remaining);
      await this.sleep(chunk, signal);
      remaining -= chunk;
      chunkIndex++;

      if (remaining > 0) {
        yield {
          type: "system_api_error",
          content: `等待中… 剩余 ${Math.ceil(remaining / 1000)}s (${attempt}/${maxRetries})`,
          delayMs: remaining,
          attempt,
          maxRetries,
          category,
        };
      }
    }
  }

  /** 检查最近一次调用是否发生了模型降级（上报位，非控制位）。
   *  消费方：`loop.ts:2643` —— 降级发生时 yield tombstone 撤回已推给 UI 的半截
   *  assistant 消息。控制流判据在 per-call 的 `RetryContext.hasFallenBack`。 */
  checkFallbackOccurred(): boolean {
    return this.lastCallFellBack;
  }

  /** 清除降级上报位。
   *
   *  B1-a 说明：方案原文要求删除本方法，理由是「reset() 的存在本身就是状态共享的
   *  证据」。该论断对**控制态**成立（已搬进 per-call，见 RetryContext.hasFallenBack），
   *  但本方法在搬迁后语义已变 —— 它清的是**上报位**，且有真实消费者：
   *  `loop.ts:2648` 在 yield tombstone 之后调 `resetFallbackFlag()` 把信号消费掉，
   *  否则同一轮后续检查会重复 yield tombstone。故保留，不再删除。 */
  reset(): void {
    this.lastCallFellBack = false;
  }
}
