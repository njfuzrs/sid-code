/**
 * 网络超时/重试统一配置
 *
 * 背景：超时阈值此前分散在 openai.ts/anthropic.ts/loop.ts 等文件的 15+ 个独立环境
 * 变量里，且默认值只按官方直连 API 的延迟分布校准，未考虑经公司网关/代理转发场景下
 * 排队+鉴权带来的额外延迟——结果是网关抖动时看门狗把仍在正常排队的连接强杀。
 *
 * 设计原则（2026-07 与用户对齐，长期不变）：
 *   1. **只有一套默认值**，不区分 direct/gateway、不按模型分档。理由：
 *      - 两套规则 = 两套需要各自维护的真相，出问题难排查（网关判定错一次就走错档）。
 *      - 单套值只要放得足够宽，直连场景顶多"多等一会才判超时"，无功能性损害；
 *        网关场景则直接被这套宽松阈值兜住，用户无感。
 *      - 按模型名硬编码分档（deepseek/default）会随模型迭代漂移出隐患，见 memory
 *        `feedback-no-hardcoded-model-tier-rules.md`。一套够宽的值对所有模型都成立。
 *   2. 默认值按"保活优先"校准：宁可多等，也不无声杀死任务。真正卡死的连接由重试
 *      兜底，且重试全程在 TUI 可见（见 loop.ts 的 timeout_retry / app.ts 的展示），
 *      不会再表现为"死循环"。
 *
 * 优先级链（从高到低）：
 *   1. 环境变量（SID_CODE_*，保留向后兼容，供运维/测试注入）
 *   2. settings.json 的 network.* 具体字段
 *   3. 统一默认值表 DEFAULTS
 *
 * 本文件不依赖 Config 类型（故意）：resolveLoopTimeouts 接受扁平的 LoopTimeoutInputs
 * 而非整个 Config 对象，避免与 config.ts（Config.network 字段引用本文件的类型）之间
 * 产生双向类型依赖。
 */

/** settings.json network 配置块的运行时形状（与 settings/types.ts 的 Zod schema 对应） */
export interface NetworkTimeoutSettings {
  headerTimeoutMs?: number;
  watchdogNoProgressMs?: number;
  watchdogCheckIntervalMs?: number;
  watchdogHeaderGraceMs?: number;
  maxTurnDurationMs?: number;
  maxSessionDurationMs?: number;
  maxTimeoutRetries?: number;
  maxRetriesPerCall?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  // ── Provider 层流式三档（P0-4：此前只认 env，settings.json 无字段位）──
  idleTimeoutMs?: number;
  contentProgressTimeoutMs?: number;
  fetchAbsoluteTimeoutMs?: number;
  overallTimeoutMs?: number;
}

export interface ResolvedLoopTimeouts {
  headerTimeoutMs: number;
  watchdogCheckIntervalMs: number;
  watchdogNoProgressMs: number;
  watchdogHeaderGraceMs: number;
  maxTurnDurationMs: number;
  maxSessionDurationMs: number;
  maxTimeoutRetries: number;
  maxRetriesPerCall: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
}

/**
 * 统一默认值表（唯一真相源）。按"保活优先 + 覆盖网关排队"校准：
 *   - headerTimeoutMs 300s：网关鉴权+排队后首字节可达 2-4 分钟属正常，给足余量。
 *   - watchdogNoProgressMs 720s：外层复核层的"无进展"上限。**必须比 provider 层的
 *     档②（contentProgressTimeoutMs 480s）更宽**：watchdog 是远端观察者，读的是
 *     provider 广播出来的快照，掌握的信息严格少于 provider 自己 —— 信息更少的一层
 *     更激进，就会在 provider 还没判定之前先开枪，且开的枪归因更差
 *     （只写 `WatchdogKill`，不写哪一档、哪个阈值）。
 *     ⚠️ 这个值同时是 `fallback.ts` 流超时（`app.ts` 注入 `streamTimeoutMs`）与
 *     `LIFECYCLE_PRESETS` 的 BASE，改它牵动三处，见下方两条注释。
 *   - maxTurnDurationMs 90min：档③单轮硬顶（覆盖任何未知挂起根因，不感知进展）。
 *     **必须与上面的放宽同批次抬**，否则 `fallback.ts` 的 S3 判据
 *     （`remaining <= effectiveDelayMs + MIN_USEFUL_ATTEMPT_MS` → 停止重试）
 *     会先把重试预算判死：最坏路径是 3 个 attempt 各跑满 720s + 2 次退避各 120s
 *     ≈ 2400s，撞破旧的 30min 硬顶 —— 等于"为了保成功放宽了超时，
 *     却把保成功的另一半（重试）关掉了"。这条有 memory 记录
 *     （`censored-distribution-cannot-justify-its-own-cap`）。
 *   - maxTimeoutRetries 10 + 指数退避：网关抖动/厂商限流往往需要几十秒到数分钟才恢复，
 *     旧值 4 次 + 30s 上限约 1 分钟就把机会耗尽。现按"保任务成功"取 10 次，配合下面
 *     放宽的退避基数/上限，名义累计退避约 12+ 分钟，足够扛过短时限流与网关抖动。
 *   - retryBackoffBaseMs 5s / retryBackoffMaxMs 120s：退避基数从 2s 抬到 5s（首次重试就
 *     给足恢复窗口，避免"几秒就重试一次"打在仍未恢复的服务上），上限从 30s 抬到 120s
 *     （指数退避到第 5-6 次即封顶 2 分钟）。注意 fallback.ts 的 STREAM_RETRY/CONNECTION_RETRY
 *     两阶段各有 maxDelayMs，已同步放宽到 120s，否则会架空这里的上限。
 *   - watchdogCheckIntervalMs 5s / watchdogHeaderGraceMs 15s：检查频率与首字节余量，
 *     不是"能否容忍慢"的核心变量，取稳健值即可。
 *
 * 任何一项都可经环境变量或 settings.json 覆盖（见 resolveLoopTimeouts）。
 */
export const DEFAULTS: Readonly<ResolvedLoopTimeouts> = {
  headerTimeoutMs: 300_000,
  watchdogNoProgressMs: 720_000,
  watchdogCheckIntervalMs: 5_000,
  watchdogHeaderGraceMs: 15_000,
  maxTurnDurationMs: 90 * 60_000,
  // ─── 会话级硬顶：默认关闭（0 = 不限时）───
  //
  // 语义：单次用户输入触发的**连续自动执行**总时长上限（tuiAgentLoop 内一整轮
  // onUserInput / headless 一次 -p / SDK 一次 run），不是整场会话。跑满即 abort
  // 本轮，用户必须再敲一句"继续"才能接着做。
  //
  // 为什么默认关掉（2026-08-04，与用户对齐）：
  //   1. **它与"无人值守跑长任务"直接冲突**。这个硬顶唯一的作用是"逼人回到键盘前"，
  //      而长任务恰恰要求人不在场也能一路跑完。人在场时本就有 ESC 可随时掐，
  //      不需要定时器代劳；人不在场时它反而是唯一会无理由掐断任务的东西。
  //   2. **它兜的底早已被更精准的防线兜住**，不是唯一的"挂死保险"：
  //      - maxTurnDurationMs（档③单轮硬顶）覆盖任何单次挂起根因；
  //      - watchdogNoProgressMs / headerTimeoutMs 覆盖连接与流层静默；
  //      - maxTimeoutRetries / maxRetriesPerCall 给重试封顶，退避风暴打不起来。
  //      真正卡死的连接由上面这几层判定并重试，全程在 TUI 可见。会话硬顶按**挂钟**
  //      掐掉的，反而多半是"正在正常干活、只是干得久"的健康任务——尤其经公司网关
  //      转发时模型响应本就慢，多轮叠加很容易撞线。
  //   3. 按本文件顶部"保活优先"原则（宁可多等，也不无声杀死任务），一个只看总时长、
  //      不看有无进展的闸门与该原则相悖：它无法区分"卡死 60 分钟"与"顺利干了 60 分钟"。
  //
  // 保留代码、只翻默认值（同 loop-detection / hypothesis / bare-ellipsis 的既有范式）：
  // 需要为 CI / 批处理设兜底时，`SID_CODE_MAX_SESSION_DURATION_MS=7200000` 或
  // settings.json 的 `network.maxSessionDurationMs` 即可重开，三条执行路径同时生效。
  // 注意 0 是显式合法值（走 readEnvNonNegative），不是"未设置"。
  maxSessionDurationMs: 0,
  maxTimeoutRetries: 10,
  // 单次 LLM 调用（executeWithFallback 一次）内"连接阶段重试 + 流式阶段重试"的共享总上界
  // （不确定-2/3）。此前两阶段各自独立计数（各 maxRetries 次），最坏可叠加成
  // connMaxRetries + streamMaxRetries 次；再乘以 loop 层 maxTimeoutRetries 与 fallback 切换，
  // 三层名义上界相乘可达数十次。这里给单次调用兜一个硬顶，防退避风暴无限放大。
  // 取 maxTimeoutRetries 同量级（略高，容纳两阶段正常各自重试），可经 env/settings 覆盖。
  maxRetriesPerCall: 12,
  retryBackoffBaseMs: 5_000,
  retryBackoffMaxMs: 120_000,
};

/**
 * Provider 层流式超时默认值（parseSSE 字节级看门狗 + fetch 生命周期硬顶）。
 *
 * 设计原则同上：**不按模型名分档**（原 openai.ts 按 /deepseek/i 分 90/180s、120/300s，
 * 直接违反本文件顶部原则，见 memory `feedback-no-hardcoded-model-tier-rules.md`）。
 * 一套够宽的值对所有模型成立：慢模型（deepseek/qwen/kimi/glm 长文思考）不会被误杀，
 * 快模型顶多"多等一会才判超时"，真卡死由重试兜底且全程可见。
 *
 * ═══ 三档阶梯：每一档的**谓词**（判什么），不只是数值 ═══
 *
 * P0-4 的核心判断：**同值只是症状，同谓词才是病。** 改造前六个阈值默认全是 300s，
 * 而其中三个（fallback 无进展上限 / watchdog / fetchAbsolute）**谓词完全相同**
 * ——都是"从某个起点起的绝对计时"。三份同谓词的副本，可靠性等于一层，
 * 而归因难度是一层的三倍（实测形态：看得见的那层背了全部锅，隐身的两层继续开枪）。
 * 防御纵深的前提是各层守**不同的失效模式**。
 *
 * 真正的三档如下（谓词互不相同，作用域逐级放大）：
 *
 *   ① 字节级 idle（`idleTimeoutMs`）
 *      谓词：reader 连**一个字节**都收不到 → 真半开 TCP。
 *      作用域：parseSSE 单次 `reader.read()`。
 *      任何 keep-alive / ping / 空行都会续命它 —— 因为那些都证明 TCP 还活着。
 *
 *   ② 事件级无进展（`contentProgressTimeoutMs`）
 *      谓词：**有字节但无有效内容**（keep-alive / ping 不续命，判据即
 *      `isContentProgress`）。作用域：一次 attempt。
 *      注意 `reasoning_content` 计入内容进展（`openai.ts` 的
 *      `hasContent || hasToolCalls || hasReasoning || finishReason`）——
 *      所以健康的长思考流只要还在吐 thinking token 就永不触发本档。
 *
 *   ③ 单轮硬顶（`DEFAULTS.maxTurnDurationMs`，不在本表）
 *      谓词：任何未知挂起根因的兜底，**不感知进展**。作用域：整轮
 *      （含多次 attempt + 退避）。它是唯一有资格做"绝对计时"的一档。
 *
 * `overallTimeoutMs` 是 ② 在**请求级**的软兜底（lifecycle Layer 3，不因事件重置），
 * 定位在 ② 与 ③ 之间：覆盖"持续吐有效内容但永不结束"这个 ② 与 ③ 都漏的窄缝。
 *
 * `fetchAbsoluteTimeoutMs` 是**第四个**、且谓词与 ③ 完全重合 →
 * **默认关闭**（见该字段注释）。
 *
 * 数值取向（保活优先，与本文件顶部原则一致；严格递增便于"哪一档开的枪"一眼可辨）：
 *   ① 240s < ② 480s < overall 1500s < ③ 5400s
 * 三档差值均 ≥ 120s，不是同值错开的伪阶梯 —— 数值哨兵与**谓词哨兵**都在
 * `tests/config/timeout-ladder-sentinel.test.ts`（后者更重要：数值哨兵拦不住
 * "三个绝对计时器错开成 240/480/600"这种形态）。
 */
export interface ProviderStreamTimeouts {
  /** 档①：字节级 idle —— reader 收不到任何字节（真半开 TCP） */
  idleTimeoutMs: number;
  /** 档②：事件级无进展 —— 有字节但无有效内容（keep-alive 不续命） */
  contentProgressTimeoutMs: number;
  /**
   * 冗余的第四层：整个 fetch 生命周期的绝对上限（`AbortSignal.timeout`）。
   * **默认 undefined = 不装这个 signal**，仅在用户显式配置时启用。
   *
   * ## 为什么默认关闭（2026-08-18，横向对标六个开源项目后定案）
   *
   * 三条理由，每条都是"确定成本"而收益近零：
   *
   * 1. **它声称的职责已被双重覆盖。** 注释原话是"打破 SSE 半开、reader 永不 settle
   *    的 hang"。但半开时正是**零字节到达** —— 那本就是档① 的领地，且档① 的归因是
   *    `idle_timeout`（说得出是哪一层、哪个阈值）；而"任何未知挂起根因"的兜底是
   *    档③ `maxTurnDurationMs`（已实测有生产调用方 `query/loop.ts`，非伪配置）。
   * 2. **它是唯一把 deadline 委托给 runtime 的一层**，runtime 的 abort
   *    **不携带可归因的 reason** —— 于是它抛出的 `DOMException("TimeoutError")`
   *    既非 `RetryableError` 也非 `TerminalError`，命中 fallback 的 fail-fast
   *    零重试分支。实测：一条**一直有进展**的流被它掐断后，一次重试都没有。
   * 3. **它不写任何事件**（不经 `emitTimeoutFired`），所以轨迹里查不到是它开的枪。
   *    这正是排查一整轮被带偏的成因：`Counter({'fallback_stream_timeout': 24})`
   *    看似铁证，实则结构性地只能看到三个闸门中的一个。
   *
   * 保留配置入口（env / settings.json）而非删代码：与 loop-detection /
   * hypothesis / maxSessionDurationMs 的既有范式一致（翻默认值、留旋钮）。
   * 一旦用户显式开启，归因必须是对的 —— 所以 `classifyError` 仍把
   * `TimeoutError` 归成 `RetryableError("timeout")`（见 `llm/errors.ts`）。
   */
  fetchAbsoluteTimeoutMs?: number;
  /** ② 的请求级软兜底（lifecycle Layer 3，不因事件重置） */
  overallTimeoutMs: number;
}

export const PROVIDER_STREAM_DEFAULTS: Readonly<ProviderStreamTimeouts> = {
  // 档①：最短。零字节到达是最明确的故障信号，没必要等太久。
  idleTimeoutMs: 240_000,
  // 档②：居中。它要容忍"网关缓冲 + 模型 prefill"这段有字节无内容的正常等待。
  contentProgressTimeoutMs: 480_000,
  // 第四层：默认关闭（理由见类型注释）。undefined ≠ 0：0 会被 readEnvMs 当非法值。
  fetchAbsoluteTimeoutMs: undefined,
  // ② 的请求级软兜底：观测 max 成功流 296s 的 5 倍。这份分布被 300s 硬顶**删失**过
  // （max 距硬顶只差 3.8s，更长的流全被杀了、根本没机会以 completed 落盘），
  // 所以取值的第一目的是**解除删失**，等未删失的新分布跑出来再回头校准。
  overallTimeoutMs: 1_500_000,
};

/** 指数退避 + ±15% jitter（避免多次重试同时撞线的惊群效应），封顶 maxMs。 */
export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const capped = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  return Math.round(capped * (0.85 + Math.random() * 0.3));
}

function readEnvMs(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Side-call 超时子表（配置-4）：warmup/compact/collapse/recall/title 五类轻量旁路调用的硬超时。
 *
 * 与主循环/provider 超时不同：这些是"锦上添花、失败即静默降级"的旁路（缓存预热、
 * 上下文压缩、分段折叠、记忆召回、标题生成），语义各异故**保留分档**（不强行统一到一个值），
 * 但收敛此前散落多个文件、各自 IIFE `Number(process.env)` 的重复解析——统一走 readEnvMs
 * 校验 + 单一默认值表，消除"多份重复 + 数值各异又与 LIFECYCLE_PRESETS.sideCall 概念重叠"的碎裂。
 *
 * env 命名保留向后兼容：SID_CODE_WARMUP_TIMEOUT_MS / _COMPACT_TIMEOUT_MS /
 * _COLLAPSE_SEGMENT_TIMEOUT_MS / _RECALL_TIMEOUT_MS / _TITLE_TIMEOUT_MS。
 */
export interface SideCallTimeouts {
  /** 缓存预热（会话启动，最短） */
  warmupMs: number;
  /** auto-compact LLM 摘要（最长，摘要不应超过 1 分钟） */
  compactMs: number;
  /** context-collapse 单段摘要 */
  collapseSegmentMs: number;
  /** 记忆召回初筛（轻量） */
  recallMs: number;
  /** 会话标题生成（非流式，与 recall 同档——生成前须显式关闭 thinking，否则思考模型
   *  可能超时；见 app.ts upgradeSessionTitle 的 thinking:{enabled:false}） */
  titleMs: number;
  /** 网关定价采集 GET /api/pricing（后台 fire-and-forget，失败静默回退旧缓存/注册表） */
  gatewayPricingMs: number;
}

export const SIDE_CALL_DEFAULTS: Readonly<SideCallTimeouts> = {
  warmupMs: 10_000,
  compactMs: 60_000,
  collapseSegmentMs: 45_000,
  recallMs: 15_000,
  titleMs: 15_000,
  gatewayPricingMs: 15_000,
};

/** 解析 side-call 超时子表：env override（readEnvMs 校验）> 统一默认值。 */
export function resolveSideCallTimeouts(): SideCallTimeouts {
  return {
    warmupMs: readEnvMs("SID_CODE_WARMUP_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.warmupMs,
    compactMs: readEnvMs("SID_CODE_COMPACT_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.compactMs,
    collapseSegmentMs:
      readEnvMs("SID_CODE_COLLAPSE_SEGMENT_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.collapseSegmentMs,
    recallMs: readEnvMs("SID_CODE_RECALL_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.recallMs,
    titleMs: readEnvMs("SID_CODE_TITLE_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.titleMs,
    gatewayPricingMs:
      readEnvMs("SID_CODE_GATEWAY_PRICING_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.gatewayPricingMs,
  };
}

/**
 * settings.json 的 `network.*` 快照（进程级），供 **provider 内部**的流式超时解析消费。
 *
 * ## 为什么需要这个中转（P0-4 的连带工程约束）
 *
 * `resolveProviderStreamTimeouts` 的调用方是 `openai.ts` / `anthropic.ts` 内部 ——
 * Provider 实例只持有 `baseURL` / `apiKey`，**读不到 settings**，所以它原本只有
 * "env > 默认值"两层。而 §4.6 要修的正是"用户改 settings.json 调不动这四项"。
 *
 * 两种修法里选了注册快照：
 *   - ✗ 让 network-profile 直接 `getSettings()`：本文件刻意不依赖 Config/settings
 *     （见文件顶部注释：避免与 config.ts 的双向类型依赖），且会给 provider 热路径
 *     引入一次磁盘读（虽有缓存，但缓存失效时机不受本文件控制）。
 *   - ✓ 由已经持有 `config.network` 的启动路径注册一次，provider 侧只读内存。
 *
 * 未注册时行为**逐字节不变**（回退 env > 默认），所以直接 `new OpenAIProvider()`
 * 的测试与 SDK 用法不受影响。
 */
let _providerStreamSettings: NetworkTimeoutSettings | undefined;

/**
 * 注册 settings.json 的 network 块，让 provider 内部的流式超时解析能读到它。
 * 由启动路径（`app.ts` 的各入口）调用一次；重复调用以最后一次为准。
 */
export function registerNetworkTimeoutSettings(network: NetworkTimeoutSettings | undefined): void {
  _providerStreamSettings = network;
}

/** 清空已注册的 network 快照（仅测试用，避免用例间串味） */
export function __resetNetworkTimeoutSettingsForTest(): void {
  _providerStreamSettings = undefined;
}

/**
 * 面向 provider 内部（openai/anthropic）的流式看门狗解析：
 * **env override > settings.network > 统一默认值**（三层，settings 层由
 * `registerNetworkTimeoutSettings` 注入，见其注释）。
 *
 * 统一入口替代此前散落在 openai.ts/anthropic.ts 的 `Number(process.env.X)`/`parseInt` 就地解析
 * （配置-3）。所有 env 都走 readEnvMs 校验（非法值静默回退默认，而非把 NaN 传给定时器）。
 *
 * env 命名保留向后兼容（运维/测试注入）：
 *   - SID_CODE_IDLE_TIMEOUT_MS：字节级 idle（openai parseSSE）
 *   - SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS：字节级 content progress（openai parseSSE）
 *   - SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS：anthropic lifecycle content progress
 *   - SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS：fetch 生命周期硬顶（两 provider 共用）
 *   - SID_CODE_OPENAI_OVERALL_TIMEOUT_MS / SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS：lifecycle overall
 */
export function resolveProviderStreamTimeouts(opts?: {
  /** anthropic 与 openai 的 content-progress / overall 用不同 env 名，用此区分 */
  providerKind?: "openai" | "anthropic";
  /**
   * 显式传入的 settings.network 块（优先于注册快照）。
   * 供已持有 config 的调用方（如 `query/stream-processor.ts`）直连，不必依赖注册时序。
   */
  network?: NetworkTimeoutSettings;
}): ProviderStreamTimeouts {
  const kind = opts?.providerKind ?? "openai";
  const n = opts?.network ?? _providerStreamSettings;
  const contentProgressEnv =
    kind === "anthropic"
      ? "SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS"
      : "SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS";
  const overallEnv =
    kind === "anthropic"
      ? "SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS"
      : "SID_CODE_OPENAI_OVERALL_TIMEOUT_MS";
  // fetch 绝对硬顶：默认 undefined（关闭）。用 readEnvNonNegative 而非 readEnvMs ——
  // 0 是「显式关闭」的合法值（与 maxSessionDurationMs 同范式），走 readEnvMs 会把它
  // 当非法值静默回退，用户就没法用 =0 表达关闭意图。解析出 0 也归一成 undefined：
  // 消费侧只需判 undefined 一种"不装 signal"的形态，不必到处再判 0。
  const fetchAbsRaw =
    readEnvNonNegative("SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS") ??
    n?.fetchAbsoluteTimeoutMs ??
    PROVIDER_STREAM_DEFAULTS.fetchAbsoluteTimeoutMs;
  return {
    idleTimeoutMs:
      readEnvMs("SID_CODE_IDLE_TIMEOUT_MS") ??
      n?.idleTimeoutMs ??
      PROVIDER_STREAM_DEFAULTS.idleTimeoutMs,
    contentProgressTimeoutMs:
      readEnvMs(contentProgressEnv) ??
      n?.contentProgressTimeoutMs ??
      PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs,
    fetchAbsoluteTimeoutMs:
      typeof fetchAbsRaw === "number" && fetchAbsRaw > 0 ? fetchAbsRaw : undefined,
    overallTimeoutMs:
      readEnvMs(overallEnv) ?? n?.overallTimeoutMs ?? PROVIDER_STREAM_DEFAULTS.overallTimeoutMs,
  };
}

function readEnvNonNegative(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** resolveLoopTimeouts 的输入——只取 network 覆盖块，不耦合整个 Config 类型。 */
export interface LoopTimeoutInputs {
  network?: NetworkTimeoutSettings;
}

/**
 * 面向 loop.ts：三层优先级 env override > settings.network 具体字段 > 统一默认值。
 * loop.ts 调用时传入 config.network 即可，无需整个 Config。
 */
export function resolveLoopTimeouts(input: LoopTimeoutInputs): ResolvedLoopTimeouts {
  const n = input.network;
  return {
    headerTimeoutMs:
      readEnvMs("SID_CODE_RESPONSE_HEADER_TIMEOUT_MS") ??
      n?.headerTimeoutMs ??
      DEFAULTS.headerTimeoutMs,
    watchdogCheckIntervalMs:
      readEnvMs("SID_CODE_WATCHDOG_CHECK_INTERVAL_MS") ??
      n?.watchdogCheckIntervalMs ??
      DEFAULTS.watchdogCheckIntervalMs,
    watchdogNoProgressMs:
      readEnvMs("SID_CODE_WATCHDOG_NO_PROGRESS_MS") ??
      n?.watchdogNoProgressMs ??
      DEFAULTS.watchdogNoProgressMs,
    watchdogHeaderGraceMs:
      readEnvNonNegative("SID_CODE_WATCHDOG_HEADER_GRACE_MS") ??
      n?.watchdogHeaderGraceMs ??
      DEFAULTS.watchdogHeaderGraceMs,
    maxTurnDurationMs:
      readEnvMs("SID_CODE_MAX_TURN_DURATION_MS") ??
      n?.maxTurnDurationMs ??
      DEFAULTS.maxTurnDurationMs,
    // 用 nonNegative 而非 readEnvMs：0 是「关闭会话硬顶」的显式合法值（默认即 0），
    // 走 readEnvMs 会把 0 当非法值静默回退到默认，导致 `=0` 无法表达关闭意图。
    maxSessionDurationMs:
      readEnvNonNegative("SID_CODE_MAX_SESSION_DURATION_MS") ??
      n?.maxSessionDurationMs ??
      DEFAULTS.maxSessionDurationMs,
    maxTimeoutRetries:
      readEnvNonNegative("SID_CODE_MAX_TIMEOUT_RETRIES") ??
      n?.maxTimeoutRetries ??
      DEFAULTS.maxTimeoutRetries,
    maxRetriesPerCall:
      readEnvNonNegative("SID_CODE_MAX_RETRIES_PER_CALL") ??
      n?.maxRetriesPerCall ??
      DEFAULTS.maxRetriesPerCall,
    retryBackoffBaseMs:
      readEnvNonNegative("SID_CODE_RETRY_BACKOFF_BASE_MS") ??
      n?.retryBackoffBaseMs ??
      DEFAULTS.retryBackoffBaseMs,
    retryBackoffMaxMs:
      readEnvMs("SID_CODE_RETRY_BACKOFF_MAX_MS") ??
      n?.retryBackoffMaxMs ??
      DEFAULTS.retryBackoffMaxMs,
  };
}

/**
 * 面向 openai.ts/anthropic.ts 内部：Provider 实例只有 this.baseURL，读不到 settings.network，
 * 因此只支持 "env override > 统一默认值" 两层。header 超时与 loop 层用同一套值，
 * 保证 provider 的 fetch 级 header 超时 与 看门狗的 header 兜底阈值一致（不会一个先杀另一个）。
 */
export function resolveHeaderTimeoutMs(): number {
  return readEnvMs("SID_CODE_RESPONSE_HEADER_TIMEOUT_MS") ?? DEFAULTS.headerTimeoutMs;
}
