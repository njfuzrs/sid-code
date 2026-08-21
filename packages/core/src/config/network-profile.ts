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
  /** PR14：fallback attempt 级无进展上限（独立于 watchdog，见 ResolvedLoopTimeouts 同名字段） */
  fallbackStreamTimeoutMs?: number;
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
  /**
   * PR14：`fallback.ts` attempt 级"无内容进展"上限，**与 watchdog 分开的独立一档**。
   *
   * ## 为什么必须拆（这是 PR14 的全部内容）
   *
   * 拆之前 `app.ts` 把 `watchdogNoProgressMs` 同时注入 fallback 的 `streamTimeoutMs`，
   * `fallback.ts` 的兜底常量也 `= NETWORK_DEFAULTS.watchdogNoProgressMs`。于是这两层
   * **同值 720s 且同谓词**（PR2 之后 fallback 那层也读内容进展）——正是 PR10 判定为
   * "病"的那个形态，只不过 PR10 收敛了三档、漏掉了这一对。
   *
   * 同值同谓词的代价已实测过一次：两层几乎同时开枪，先到的那层背全部锅，
   * 而轨迹里 `Counter({'fallback_stream_timeout': 24})` 看似铁证，
   * 实际只是"它比 watchdog 早 70ms"。
   *
   * ## 取值 600s：来自**已解除删失**的新分布，不是拍的
   *
   * PR1/PR2/PR10 合入后重算 50 会话 / 1370 条成功流：
   * `p50=3.9s p95=83.7s p99=294.2s max=507.8s`，其中 `>600s: 0/1370`。
   * 而"无内容进展"间隔（`RetryTelemetry.stream_stall` 的 gapMs）实测最大
   * **293.1s**（origin-deepseek-v4-pro）与 **284.5s**（glm-5.3）。
   *
   * 关键是这份分布**不再被删失**：旧分布 max=296.6s 紧贴 300s 硬顶、296.x 挤了一堆
   * （更长的流全被杀掉、根本没机会以 completed 落盘），新分布 max 已跑到 507.8s
   * 且 296.x 那个聚集消失 —— 说明右尾是真的，不是被截断的。
   *
   * 所以 600s ≈ 观测 idle max 的 2 倍，且落在 480s（档②）与 720s（watchdog）之间，
   * 三档间距各 120s。**§5.A 那组"上限护栏"数字不需要动到**：把谓词改对之后，
   * 值本来就够用（四家竞品都停在 ~300s 作为 idle 门槛）。
   */
  fallbackStreamTimeoutMs: number;
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
 *     档②（contentProgressTimeoutMs 480s）与 fallback 层（600s）都更宽**：
 *     watchdog 是远端观察者，读的是 provider 广播出来的快照，掌握的信息严格少于
 *     provider 自己 —— 信息更少的一层更激进，就会在 provider 还没判定之前先开枪。
 *     ⚠️ 它仍是 `LIFECYCLE_PRESETS` 的 BASE（改它牵动那三档，见下方注释），
 *     但 **PR14 起不再兼任 `fallback.ts` 的流超时** —— 那一层已拆成
 *     `fallbackStreamTimeoutMs`（600s）。此前二者同值 720s 且同谓词，
 *     是 PR10 收敛三档时漏掉的最后一对伪阶梯。
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
  // PR14：fallback attempt 级无进展上限，独立于 watchdog（此前二者同为 720s 同谓词）。
  // 600s 的依据是**已解除删失**的新分布（>600s: 0/1370，实测 idle gap max 293.1s），
  // 详见 ResolvedLoopTimeouts.fallbackStreamTimeoutMs 的注释。
  // 位置刻意在 ② 480s 与 watchdog 720s 之间：provider 内层先判、外层复核后判。
  fallbackStreamTimeoutMs: 600_000,
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
 *   ① 240s < ② 480s < fallback 600s < watchdog 720s < overall 1500s < ③ 5400s
 * 相邻差值均 ≥ 120s，不是同值错开的伪阶梯 —— 数值哨兵与**谓词哨兵**都在
 * `tests/config/timeout-ladder-sentinel.test.ts`（后者更重要：数值哨兵拦不住
 * "三个绝对计时器错开成 240/480/600"这种形态）。
 *
 * PR14 补进这条链的是 `fallback 600s` 与 `watchdog 720s` 之间的分离：
 * 那两层此前同为 720s 且同谓词（PR2 之后 fallback 也读内容进展），
 * 而"档②/overall/档③ 严格递增"这个自检**结构性地看不到它们** ——
 * 因为它们根本没在被检查的那张表里。哨兵已补上这一对。
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
 * PR12：**单模型**的流式超时覆盖（`ModelConfig.streamTimeouts`，按渠道别名 `name` 键）。
 *
 * ## 为什么需要它，而不是把全局默认再抬一档
 *
 * 慢是**模型的属性**，不是全局属性。实测（50 会话 / 1370 条成功流）最长无进展间隔
 * 落在两个模型上：`glm-5.3` 284.5s、`origin-deepseek-v4-pro` 293.1s；
 * 其余模型的 p95 只有 83.7s。全局抬阈值会让**所有**模型的真僵死回收一起变慢 ——
 * 拿"两个慢模型"当理由去放宽"全部模型"，代价与收益的作用面不匹配。
 *
 * 横向对标同一结论：oh-my-pi 的 `compat.streamIdleTimeoutMs` 注释写明是为
 * "Bedrock 推理模型思考中途安静几分钟"加的，解法就是模型目录里的单模型覆盖。
 *
 * ## 为什么不塞进 `ModelCompat`
 *
 * `ModelCompat` 是**纯布尔位**：`normalizeModelCompat` 明文只接受真布尔、
 * 字符串一律丢弃（"两个方向猜错的后果相反"）。塞一个 number 进去会破掉那条不变量，
 * 于是归一化、校验、别名表、跨进程播种四处都要开特例。独立一张表更便宜也更诚实。
 *
 * ## 按**渠道别名**而非模型真名键
 *
 * 与 `ModelCompat` / `supportsThinking` 同一口径：同一个真名接官方端点与公司网关时，
 * 慢的往往是网关那条（排队 + 缓冲），不是模型本身。按真名键会把两条渠道一起放宽。
 */
const _perModelStreamTimeouts = new Map<string, PerModelStreamTimeouts>();

/**
 * 单模型可覆盖的流式超时项。刻意**只开档①/档②/overall 三项**：
 *
 * - `fetchAbsoluteTimeoutMs` 不开：它已默认关闭且谓词与档③重合（PR7 的结论），
 *   给一个"应当关掉的层"加单模型旋钮等于给它续命。
 * - 档③ `maxTurnDurationMs` 不开：它是**整轮**硬顶（跨模型、跨 fallback 切换、
 *   含重试与退避），一轮里可能用过多个模型 —— "这一轮属于哪个模型"没有唯一答案，
 *   按模型覆盖一个整轮预算在语义上就讲不通。
 */
export interface PerModelStreamTimeouts {
  idleTimeoutMs?: number;
  contentProgressTimeoutMs?: number;
  overallTimeoutMs?: number;
}

/** `PerModelStreamTimeouts` 的全部合法键（归一化与校验共用，避免两处手写清单漂移）。 */
export const PER_MODEL_STREAM_TIMEOUT_KEYS: readonly (keyof PerModelStreamTimeouts)[] = [
  "idleTimeoutMs",
  "contentProgressTimeoutMs",
  "overallTimeoutMs",
];

/** snake_case → camelCase 别名（settings.json 两种风格都要认，同 COMPAT_KEY_ALIASES 的理由）。 */
const PER_MODEL_KEY_ALIASES: Record<string, keyof PerModelStreamTimeouts> = {
  idle_timeout_ms: "idleTimeoutMs",
  content_progress_timeout_ms: "contentProgressTimeoutMs",
  overall_timeout_ms: "overallTimeoutMs",
};

/**
 * 把用户手写的 `streamTimeouts` 对象归一化，非法内容一律丢弃（不抛）。
 *
 * **必须容错到不抛**：本函数在 `loadConfig` 链上，抛出即整个进程起不来 ——
 * 用户把一个值写成字符串就完全无法启动，比"该字段不生效"严重得多。
 * 与 `normalizeModelCompat` 同一口径：就地容错。
 *
 * 只认**有限正数**：0 与负数不是"关闭"（关闭一个 idle 闸门没有合理用例，
 * 那会退回半开连接永久挂起的 0 层状态），是配错；`NaN`/`Infinity` 传给定时器
 * 会得到未定义行为。返回 `undefined` 表示"没有任何有效声明"。
 */
export function normalizePerModelStreamTimeouts(raw: unknown): PerModelStreamTimeouts | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: PerModelStreamTimeouts = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const key =
      PER_MODEL_KEY_ALIASES[rawKey] ??
      ((PER_MODEL_STREAM_TIMEOUT_KEYS as readonly string[]).includes(rawKey)
        ? (rawKey as keyof PerModelStreamTimeouts)
        : undefined);
    if (!key) continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 注册 per-model 流式超时表。由 `resolveCurrentModelConfig` 那条咽喉调用
 * （与 `setModelCompat` 同一处），幂等、可重复调。
 *
 * 传 `undefined` 或空列表即**清空** —— 与 `setModelCompat` 同一条硬要求：
 * 切到"没有任何覆盖"的状态时必须真清掉，否则上一份配置的覆盖残留，
 * 会让新配置按旧阈值跑且不报错。
 */
export function registerPerModelStreamTimeouts(
  models?: readonly { name?: string; streamTimeouts?: unknown }[],
): void {
  _perModelStreamTimeouts.clear();
  if (!models) return;
  for (const m of models) {
    if (!m?.name) continue;
    // 归一化在**注册时**做（同 setModelCompat 的口径）：`streamTimeouts` 声明为 unknown，
    // 因为它可能来自用户手写 settings.json（snake_case、字符串数字、负数都可能），
    // schema 的 `.passthrough()` 不会把这些挡住。查询侧因此永远拿到干净的形状。
    const t = normalizePerModelStreamTimeouts(m.streamTimeouts);
    if (!t) continue;
    // 同名重复以**首条**为准（同 setModelCompat：`/model` 按 name 也是选中第一条，
    // 两处口径必须一致，否则"选中的那条"与"生效的覆盖"会来自不同条目）。
    if (!_perModelStreamTimeouts.has(m.name)) {
      _perModelStreamTimeouts.set(m.name, t);
    }
  }
}

/** 查询某渠道别名的 per-model 覆盖（无覆盖返回 undefined）。 */
export function lookupPerModelStreamTimeouts(
  modelName: string | undefined,
): PerModelStreamTimeouts | undefined {
  if (!modelName || _perModelStreamTimeouts.size === 0) return undefined;
  return _perModelStreamTimeouts.get(modelName);
}

/** 清空 per-model 覆盖（仅测试用，避免用例间串味）。 */
export function __resetPerModelStreamTimeoutsForTest(): void {
  _perModelStreamTimeouts.clear();
}

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
 * **调用方 options > env override > per-model > settings.network > 统一默认值**
 * （五层；settings 层由 `registerNetworkTimeoutSettings` 注入，
 * per-model 层由 `registerPerModelStreamTimeouts` 注入，见各自注释）。
 *
 * ## 顺序判据：范围越窄越优先，env 例外（PR12）
 *
 *   - `opts.timeouts`（调用方显式传）：最强。代码当场决定，没有更上层可申诉。
 *   - env：**唯一的例外**，压过所有配置文件。理由是它是运维/测试的一次性注入 ——
 *     "临时压到毫秒级复现一个 bug"必须做得到，多个现存测试正依赖这条。
 *   - per-model（`availableModels[].streamTimeouts`）：比全局窄，所以压过全局。
 *     ⚠️ 这一层曾被我排在 settings.network **之后**，理由是"用户的全局声明不该被
 *     模型级建议否决" —— 那是**错的**：per-model 同样是用户写在同一个 settings.json
 *     里的显式声明，不是我们的建议。而且排在全局之后会让它几乎永不生效
 *     （只要用户碰过一次全局 `network.idleTimeoutMs`，per-model 就彻底失效且不报错），
 *     等于把这一层做成死配置。这个错误是 PR13 那条对照用例抓出来的。
 *   - `settings.network.*`：用户对全局的显式声明。
 *   - 默认值：最后。
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
  /**
   * PR12：本次请求走的**渠道别名**（`ModelConfig.name`），用于查 per-model 覆盖。
   * 不传 = 不查 per-model（行为与 PR12 之前逐字节相同）。
   */
  modelName?: string;
  /**
   * PR12：调用方显式指定的超时（最高优先级，压过 env / settings / per-model）。
   * 供 side-call 等"我知道自己该多快"的路径直接指定，不必绕 env。
   */
  timeouts?: PerModelStreamTimeouts;
}): ProviderStreamTimeouts {
  const kind = opts?.providerKind ?? "openai";
  const n = opts?.network ?? _providerStreamSettings;
  const perModel = lookupPerModelStreamTimeouts(opts?.modelName);
  const explicit = opts?.timeouts;
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
    // PR12：五层链 —— 调用方 options > env > per-model > settings.network > 默认值。
    // 顺序判据见函数头注释（范围越窄越优先，env 是唯一例外）。
    idleTimeoutMs:
      explicit?.idleTimeoutMs ??
      readEnvMs("SID_CODE_IDLE_TIMEOUT_MS") ??
      perModel?.idleTimeoutMs ??
      n?.idleTimeoutMs ??
      PROVIDER_STREAM_DEFAULTS.idleTimeoutMs,
    contentProgressTimeoutMs:
      explicit?.contentProgressTimeoutMs ??
      readEnvMs(contentProgressEnv) ??
      perModel?.contentProgressTimeoutMs ??
      n?.contentProgressTimeoutMs ??
      PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs,
    // fetchAbsolute 刻意**不接** per-model / explicit：它已默认关闭且谓词与档③重合，
    // 给一个应当关掉的层加旋钮等于给它续命（见 PerModelStreamTimeouts 的注释）。
    fetchAbsoluteTimeoutMs:
      typeof fetchAbsRaw === "number" && fetchAbsRaw > 0 ? fetchAbsRaw : undefined,
    overallTimeoutMs:
      explicit?.overallTimeoutMs ??
      readEnvMs(overallEnv) ??
      perModel?.overallTimeoutMs ??
      n?.overallTimeoutMs ??
      PROVIDER_STREAM_DEFAULTS.overallTimeoutMs,
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
    // PR14：独立解析，**不再回落 watchdogNoProgressMs**。
    // 回落会让"用户只调了 watchdog"变成"两层一起动"，同值同谓词的老形态就回来了。
    fallbackStreamTimeoutMs:
      readEnvMs("SID_CODE_FALLBACK_STREAM_TIMEOUT_MS") ??
      n?.fallbackStreamTimeoutMs ??
      DEFAULTS.fallbackStreamTimeoutMs,
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
