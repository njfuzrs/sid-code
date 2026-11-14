/**
 * 会话状态管理 — 单一真相源
 * 对标 Claude Code 的 SessionState，集中管理：
 * - 按模型分开的 token 用量统计
 * - 成本计算（区分缓存 token 计价）
 * - API 耗时 vs 工具耗时分开追踪
 *
 * 定价来源：统一委托给 cost-tracker.ts 的 resolvePricing()，不维护独立定价表。
 */

import type { Usage, NormalizedCacheUsage } from "../llm/types.ts";
import { normalizeCacheUsage } from "../llm/types.ts";
import {
  inferProviderByModelName,
  isLocalProvider as isLocalProviderName,
} from "../llm/provider-infer.ts";
import { getLogger } from "../debug/logger.ts";
import {
  resolvePricing,
  effectivePricing,
  calculateCostBreakdown,
  FALLBACK_PRICING,
  type PricingModelEntry,
} from "../api/cost-tracker.ts";
// CG-2：/clear 要清的「本任务进展」键由 loop 侧定义，这里只消费常量（不复制字面量——
// 复制会在改名时静默漏清）。两个模块都是纯数据/纯类型，不反向 import 本文件，无循环依赖。
import { MEASURED_PROGRESS_KEY } from "../query/measured-progress.ts";
import { TODO_REWORK_KEY } from "../query/todo-rework.ts";

/** 单个模型的用量统计 */
export interface ModelUsageStats {
  /**
   * 末次输入 token（stock 口径，**provider 原始口径**）：= 最后一次 API 调用的 `usage.inputTokens`。
   * ⚠️ 口径因 provider 而异：Anthropic = 未命中余量（不含命中/写入），OpenAI/DeepSeek = 含命中的全量 prompt。
   * 因此**不要**直接用它展示「当前上下文大小」——对 Anthropic 会严重低估（只剩 cache miss 增量）。
   * 展示当前上下文请用 {@link stockPromptTokens}（已归一化为末次完整输入）。
   * 命中率/计费等 flow 统计请用 {@link cumulativePromptTokens}。
   */
  inputTokens: number;
  /**
   * 末次完整输入 token（stock 口径，**归一化后的 promptTotal**）：每次 API 调用覆盖写入
   * `normalizeCacheUsage(usage, provider).promptTotal`，即末次调用的 uncached + hit + write 之和。
   * - Anthropic：input_tokens（未命中余量）+ cache_read + cache_creation = 真实末次上下文。
   * - OpenAI/DeepSeek：prompt_tokens（本就含命中）= 完整上下文。
   * 两家统一为「末次完整 prompt 大小」，**这才是状态栏「输入」该显示的口径**（反映当前上下文有多大）。
   */
  stockPromptTokens: number;
  /**
   * 累计输入 token（flow 口径）：每次 API 调用的 inputTokens 之和。
   * - Anthropic：每次的未命中余量之和 → 累计未命中。
   * - OpenAI/DeepSeek：每次的 prompt_tokens 之和 → 累计完整输入。
   * 与 cacheRead/cacheCreation（同为 flow 累加）口径一致，供命中率/省钱统计。
   */
  cumulativePromptTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requests: number;
  costUSD: number;
  /** 缓存节省金额（美元）：假设全部按未命中全价 − 实际成本，逐次累加 */
  cacheSavingsUSD: number;
  /** 该模型对应的 provider（"anthropic"/"openai"/...），用于归一化口径区分 */
  provider: string;
  /**
   * P0-4：末次请求的端点 host（如 `api.uniapi.io`、`code.ppchat.vip`）。
   *
   * 为什么必须记到 host 粒度：同一个模型名（claude-sonnet-5）经不同网关的 usage
   * **可信度完全不同** —— 实测某月卡网关的 Anthropic usage 是编造的（三段随机跳动
   * 而总和恒定），把它的"命中"混进总命中率会直接抬高整体数字。只有 provider
   * （都是 "anthropic"）分不开这两者，必须落 host。
   *
   * 只存 host 不存完整 URL：path 与 query 可能带 key 之类的敏感串，而归因只需要 host。
   * 旧数据无此字段（undefined = 未知渠道，按可信处理，避免把历史数据一律打上警示）。
   */
  endpointHost?: string;
  /**
   * 该模型入账用到的**原始计价币种**（`resolvePricing` 返回值，**不是** `effectivePricing` 折算后的）。
   *
   * 用途：让展示层判断「这笔钱是不是按汇率折算出来的估算值」——折算过的金额在 Footer /
   * /cost / /debug 前加 `≈`。判据必须看价格数据本身，不能看模型名：`/deepseek/i` 那种写法
   * 在「别名指向 CNY 价」或「同名模型走美元网关价」两种真实场景里都会给出相反答案（D7）。
   *
   * 只记原始值：`effectivePricing` 折算后会把 `currency` 改写成 `"USD"`（防止二次折算，
   * 见 cost-tracker.ts），拿折算后的值就永远判不出「换过汇」。
   * undefined = 该模型的价没声明币种（隐含 USD，与改造前的假设一致）。
   */
  priceCurrency?: string;
  /**
   * `priceCurrency` 对应的原始换算率（1 单位本币 = 多少 USD），与 {@link priceCurrency} 同源。
   *
   * 只用于展示换算说明（`1 USD = 1/fxToUSD 本币`）。它同时是「真的换过汇」的第二半判据：
   * 声明了非 USD 却没给汇率的价，`effectivePricing` 会**原样当 USD 用、不猜汇率**
   * （见 cost-tracker.ts），那笔钱没经过换算，不该加 `≈`。
   */
  priceFxToUSD?: number;
  /**
   * 作废尝试的次数（P0-2 C 组）：超时/流内错误后重试、响应被丢弃但 prompt 已发出并计费。
   *
   * 与 `requests` 的关系：`requests` 是**总记账次数**（含作废），此字段是其中作废的那部分。
   * 单独留一个计数是为了让「重试烧了多少钱」直接可查 —— 重试是 harness 的行为，
   * 代价却此前完全不可见（实测该会话 101 次作废连接 ≈ 12M token 隐性开销）。
   * 旧快照无此字段（undefined = 0）。
   */
  discardedRequests?: number;
  /**
   * 作废尝试累计烧掉的 prompt token（billable 口径的一部分）。
   * 让"省了多少 / 白烧了多少"能分开看，而不是混在 cumulativePromptTokens 里无从拆解。
   */
  discardedPromptTokens?: number;
  /**
   * 累计推理 / 思考 token（D12）。openai 族是 `outputTokens` 的**子集**（completion 已含
   * reasoning，这里只做「其中」展示，绝不能再加进 outputTokens）；anthropic 族恒 undefined。
   * 旧快照无此字段（undefined → 0）。
   */
  reasoningTokens?: number;
  /**
   * 该模型末次入账时走的完整端点 URL（**已剥 query**，D11）。/cost 要按「模型 + 端点」
   * 取到和计费**同一条**价 —— 只存 host 不够（`resolvePricing` 的复合键匹配要完整 baseURL），
   * 存完整 URL 又会把 key 之类的敏感串带进快照，所以只存 `origin + pathname`。
   * 旧快照无此字段（undefined → 端点未知，/cost 显示时回退 `availableModels` 同名模型的 baseURL）。
   */
  pricingBaseURL?: string;
  /**
   * 该模型末次入账时的价格来源（D11）：`"fallback"`（兜底估算）/ `"local"`（本地 provider）/
   * 其余为 `ModelPricing.source` 原值（如 `"gateway:expr"`）/ `"pricing"`（注册表或用户手写，无 source）。
   * `"fallback"` 是消费方必须亮黄警告的信号 —— 那是「宁可高估」的编造数，混着展示会被人当真。
   * 旧快照无此字段（undefined → 按非 fallback 处理，与历史行为一致）。
   */
  pricingSource?: string;
  /**
   * 该模型「输入·未命中」累计费用（USD，D12）。四段之和恒等于 `costUSD` ——
   * 四段在 `updateUsage` 里由**同一个** `calculateCostBreakdown` 结果拆出，不是两处各算。
   * 字段名与 `CostBreakdown` 同构（uncachedInputUSD/...），读写两头不换名。
   */
  uncachedInputUSD?: number;
  /** 「输入·缓存命中」累计费用（USD，D12）。 */
  cacheHitUSD?: number;
  /** 「输入·缓存写入」累计费用（USD，D12）。 */
  cacheWriteUSD?: number;
  /** 「输出」累计费用（USD，D12，已含推理）。 */
  outputUSD?: number;
  /**
   * 按**高峰价**入账的累计费用（USD，D11）。与 `offpeakCostUSD` 之和恒等于 `costUSD`。
   * 会话跨高峰/空闲时一个模型实际用两档价，不拆的话「单价 × token ≠ 费用」无从解释。
   * 时段判据来自 `calculateCostBreakdown` 的 `tier`（同一行代码算出，见 cost-tracker.ts）。
   */
  peakCostUSD?: number;
  /** 按**空闲折扣价**入账的累计费用（USD，D11）。无分时段政策的模型恒 0。 */
  offpeakCostUSD?: number;
}

/**
 * 用量统计的可持久化快照（写入会话 JSONL 的 usage_stats metadata，resume 时回灌）。
 * 覆盖 Footer 状态栏展示所需全部维度——恢复对话后 token/费用/缓存节省不再从 0 起。
 */
export interface UsageSnapshot {
  totalCostUSD: number;
  sideCostUSD: number;
  totalAPIDuration: number;
  totalToolDuration: number;
  modelUsage: Record<string, ModelUsageStats>;
}

/**
 * D13：逐次入账明细的一行（环形缓冲 `requestLog` 的元素，不落盘）。
 * 只存 /cost 轮次分析需要的字段；`seq` 是进程内单调序号，「最贵的第 N 次」按它报。
 */
export interface RequestLogEntry {
  seq: number;
  /** 入账时刻（Date.now()，ms）。仅供排序，不用于展示。 */
  at: number;
  model: string;
  promptTokens: number;
  cacheHit: number;
  cacheWrite: number;
  outputTokens: number;
  costUSD: number;
  /** 是否作废重试的尝试（P0-2 C 组）：钱花了、响应没进上下文。 */
  discarded: boolean;
}

/** 会话状态 */
export class SessionState {
  /**
   * 本进程当前会话 id。**不再 readonly**：`/clear` 对齐 CC（`regenerateSessionId`）
   * 会经 {@link rotate} 换成新 id —— 一次 /clear = 结束旧会话 + 开新会话。
   * 外部只读，只允许 rotate 改它（setter 私有化靠约定：全仓仅 rotate 写）。
   */
  sessionId: string;
  readonly cwd: string;
  /** 会话起点（duration_ms 的基准）。rotate 时随新会话重置。 */
  startTime: number;
  /** /clear 换会话时记录上一个会话 id（血缘追溯，对齐 CC parentSessionId）。 */
  parentSessionId: string | undefined;

  /** 总花费（美元） */
  totalCostUSD: number = 0;
  /**
   * 辅助调用（side call）花费（美元）——标题生成/记忆召回/bash分类/摘要压缩/缓存预热等
   * 不经主循环的影子调用。与 totalCostUSD 分开累加，避免污染 traj 的 total/side 分离语义。
   * 展示层（TUI 费用列 / /cost）和 quota 守卫读 totalCostUSD + sideCostUSD = 真实总花费。
   * 注意：辅助调用的 token 不并入 modelUsage，避免污染 stock 口径（"当前上下文大小"展示）。
   */
  sideCostUSD: number = 0;
  /** API 调用总耗时（毫秒） */
  totalAPIDuration: number = 0;
  /** 工具执行总耗时（毫秒） */
  totalToolDuration: number = 0;
  /** 按模型分开的用量统计 */
  modelUsage: Record<string, ModelUsageStats> = {};
  /**
   * D13：逐次入账明细的**有界**环形缓冲（最近 REQUEST_LOG_CAP 条）。
   *
   * 为什么必须有界：长会话上千次请求，无界数组是内存泄漏。为什么放内存不放盘：
   * /cost 打开时读它算 p50/p95/max，命令面板首帧不能被磁盘 IO 卡住（resume 会话
   * 从 events.jsonl 跨文件拼历史明细的方案已否决，见 Agent Note）。resume 后只有
   * 本进程的明细，/cost 显示时写明「本次启动后 N 次」。
   */
  private requestLog: RequestLogEntry[] = [];
  /** D13：入账序号（跨 /clear 不重置也无妨，明细只用于排序与计数）。 */
  private requestSeq = 0;
  /** D13：环形缓冲上限。500 次 ≈ p95 足够稳定的长会话规模（本仓实测取证会话 31 次）。 */
  private static readonly REQUEST_LOG_CAP = 500;
  /** 入账观察者（兼容旧接口：覆盖式单槽位），见 setCostChangeListener */
  private costChangeListener: ((effectiveCostUSD: number) => void) | null = null;
  /**
   * 追加式入账订阅者，见 addCostChangeListener。
   *
   * 为什么需要第二个通道：单槽位已被账本落盘占用，UI 想「每笔入账都刷新」就只能
   * 再调一次 setCostChangeListener —— 那会把账本监听器挤掉，账本静默停止落盘。
   * 两个消费方必须共存，且一个抛错不能牵连另一个（账本写盘失败不该阻断界面刷新，
   * 反之亦然），所以各自独立 try/catch。
   */
  private costChangeSubscribers = new Set<(effectiveCostUSD: number) => void>();
  /** 入账版本号：每次 updateUsage / addSideCost +1。账本判脏用它而非成本（零成本 provider 也要落行）。 */
  private usageVersion = 0;
  /** 会话级别的临时数据存储（用于命令间共享状态） */
  private sessionData = new Map<string, any>();
  /** 用户配置的模型列表（携带定价 + provider 信息），用于定价/inferProvider 优先使用 */
  private availableModels: PricingModelEntry[] = [];
  /**
   * 缺口7：会话累计轮次（**不随用户消息重置**）。
   *
   * 根因：`LoopState.turnCount` 由 `createInitialLoopState` 在每条用户消息（每次
   * `queryLoop` 调用）时新建 → 每条消息从 0 重数，而 `AfterModel.data.index` 是会话
   * 累计。两个口径此前都以 `turn` 之名落进 events.jsonl，导致跨消息会话里"这条假设
   * 存活了多久""登记发生在会话哪个阶段"这类问题**无法回答且不会报错**——只会静静
   * 给出错误结论（设计文档 §2.3 初稿把 44 轮写成 52 轮，就是直接把两个计数器相减）。
   *
   * 埋点侧的正确做法是同时落两个字段：`turn`（消息内，保留兼容）+ `absoluteTurn`
   * （本字段）+ `promptSeq`（第几条用户消息），让 `turn=3` 可还原到具体哪条消息。
   */
  private absoluteTurnCount = 0;
  /** 缺口7：第几条用户消息（每次 queryLoop 启动 +1，从 1 开始）。 */
  private promptSeq = 0;

  constructor(sessionId: string, cwd?: string) {
    this.sessionId = sessionId;
    this.cwd = cwd ?? process.cwd();
    this.startTime = Date.now();
  }

  /**
   * 缺口7：递增会话累计轮次并返回新值（queryLoop 每轮 turnCount++ 时同步调用）。
   *
   * 与 `LoopState.turnCount++` 严格同点调用，保证两个计数器同步推进——否则
   * absoluteTurn 会漂移，而漂移的绝对轮次比没有绝对轮次更糟（前者会被当真）。
   */
  nextAbsoluteTurn(): number {
    this.absoluteTurnCount += 1;
    return this.absoluteTurnCount;
  }

  /** 缺口7：读当前会话累计轮次（不递增），供埋点补齐 absoluteTurn。 */
  getAbsoluteTurn(): number {
    return this.absoluteTurnCount;
  }

  /**
   * 缺口7：递增用户消息序号并返回新值（queryLoop 启动时调用一次）。
   *
   * resume 场景刻意**不**回灌：resume 后 promptSeq 从 1 重数，但 events.jsonl 里
   * session_id 相同、时间戳单调，离线分析仍可按"文件内出现顺序 + promptSeq 回绕点"
   * 切分。回灌反而要引入一份新的持久化状态，成本高于收益。
   */
  nextPromptSeq(): number {
    this.promptSeq += 1;
    return this.promptSeq;
  }

  /** 缺口7：读当前用户消息序号（不递增）。 */
  getPromptSeq(): number {
    return this.promptSeq;
  }

  /** 注入用户配置的模型列表（含 pricing/provider），供定价解析和 provider 推断优先使用 */
  setAvailableModels(models: PricingModelEntry[]): void {
    this.availableModels = models;
  }

  /** 获取会话数据 */
  get(key: string): any {
    return this.sessionData.get(key);
  }

  /** 设置会话数据 */
  set(key: string, value: any): void {
    this.sessionData.set(key, value);
  }

  /** 删除会话数据 */
  delete(key: string): boolean {
    return this.sessionData.delete(key);
  }

  /** 检查会话数据是否存在 */
  has(key: string): boolean {
    return this.sessionData.has(key);
  }

  /**
   * 更新 API 调用的用量统计。
   *
   * @param discarded 本次 usage 是否来自**被作废的尝试**（超时/流内错误后重试，
   *   响应被丢弃但 prompt 已发到服务端、厂商已计费）。
   *
   *   两个口径必须并存、不能合并（P0-2 C 组）：
   *   - **billable**（含作废重发）= 对账官方账单用 → `cumulativePromptTokens` / `costUSD`
   *     / cache 累加值 / `requests`，这些照常累加；
   *   - **effective**（仅末次成功）= 看"当前上下文有多大"用 → `inputTokens` /
   *     `stockPromptTokens`，作废尝试**不得**覆盖它们。
   *
   *   混在一起的后果是双向的：作废量不记 → 费用低估 26.2%、costLimit 守卫晚触发；
   *   作废量覆盖 stock → 状态栏"当前上下文"跳成一个已经不存在的值。
   */
  updateUsage(
    model: string,
    usage: Usage,
    durationMs: number,
    provider?: string,
    baseURL?: string,
    discarded = false,
    /**
     * G6：本次 usage 覆盖的真实 API 请求数。主循环每请求调一次，恒为 1；
     * 子代理 usage-sink 在结束时一次性传入累计 usage，必须同时传真实请求数，
     * 否则一个跑了 30 轮的子代理在 ⟳ / /stats / SessionEnd 里只算 1 次。
     */
    requestCount = 1,
    /**
     * 计价时刻 —— 分时段定价的输入，缺省「现在」。
     *
     * 存在的唯一目的是**可测性**：`/cost` 的时段占比（`peakShare`）此前无法断言
     * 「全程空闲 → 0」，因为测试跑在墙钟上，无法让本会话的所有请求都落进空闲窗口。
     * 加了这个参数，测试就能把两次入账分别钉在高峰/空闲时刻。
     *
     * 生产调用点**一律不传**（行为与改动前逐位相同）。与
     * `calculateCostBreakdown` 的同名参数（api/cost-tracker.ts）是同一个语义。
     */
    at?: Date,
  ): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    // 初始化模型统计
    if (!this.modelUsage[model]) {
      this.modelUsage[model] = {
        inputTokens: 0,
        stockPromptTokens: 0,
        cumulativePromptTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        requests: 0,
        costUSD: 0,
        cacheSavingsUSD: 0,
        provider: prov,
      };
    }

    const stats = this.modelUsage[model];
    stats.provider = prov; // 末次 provider 覆盖（同模型 provider 稳定，覆盖无害）
    // P0-4：记末次端点 host，供账本按渠道标注可信度（只取 host，不留 path/query）
    const host = SessionState.hostOf(baseURL);
    if (host) stats.endpointHost = host;

    // D7：记**原始**计价币种与换算率，供展示层判断金额是否按汇率折算过（`≈` 前缀的判据）。
    // 必须取 `resolvePricing` 的原始值：`effectivePricing` 折算后会把 currency 改写成 "USD"
    // （防二次折算，见 cost-tracker.ts），拿折算后的值永远判不出「换过汇」。
    // 与 calculateCost 内部的解析重复一次是刻意的：那个函数是公开的重算入口
    // （trace 对账也走它），把「记录展示字段」塞进去会污染纯计算职责。
    const rawPricing = resolvePricing(model, this.availableModels, baseURL);
    if (rawPricing?.currency) stats.priceCurrency = rawPricing.currency;
    if (typeof rawPricing?.fxToUSD === "number") stats.priceFxToUSD = rawPricing.fxToUSD;

    // 累加 token
    // ⚠️ usage.inputTokens 是"本次 API 调用时的 prompt 总长度"（含全部历史），
    // 累加会 N² 过计数。inputTokens 取最后一次（stock，provider 原始口径）；
    // stockPromptTokens 取最后一次的归一化完整输入（uncached+hit+write，跨 provider 统一，给上下文占比展示）；
    // cumulativePromptTokens 累加（flow，给命中率/省钱统计，与 cacheRead 累加口径一致）。
    // 校准记录见 evals/eval-judge.ts gradeCost 注释。
    // 作废尝试（discarded）**不覆盖 stock 口径**：它记录的是"当前上下文有多大"，
    // 而作废的那次响应已经不存在于上下文里。覆盖会让状态栏显示一个幽灵值。
    // flow 口径（下面三行累加）照记 —— 钱是真花了。
    if (!discarded) {
      stats.inputTokens = usage.inputTokens;
      stats.stockPromptTokens = normalizeCacheUsage(usage, prov).promptTotal;
    } else {
      // 作废量单独留痕，让"重试白烧了多少"可直接查（否则混进 cumulative 后无从拆解）。
      stats.discardedRequests = (stats.discardedRequests ?? 0) + 1;
      stats.discardedPromptTokens = (stats.discardedPromptTokens ?? 0) + usage.inputTokens;
    }
    stats.cumulativePromptTokens += usage.inputTokens;
    stats.outputTokens += usage.outputTokens;
    stats.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    stats.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    // D12：推理 token 累加（openai 族是 output 的子集，anthropic 恒 undefined→0）。
    stats.reasoningTokens = (stats.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    stats.requests += Math.max(1, Math.floor(requestCount));

    // 计算本次成本（带 provider 口径 + 端点精确价）—— PR-B/D12：四段与总额**同源**入账。
    // calculateCostBreakdown 是全仓唯一计价公式，这里直接用它的四段累进 ModelUsageStats，
    // 「四段之和 === costUSD」由同一行代码保证，不是两处各算后碰巧相等。
    // fallback 告警此前住在 calculateCost 的 fallback 分支里，改走 breakdown 后在这里补：
    // source 字段就是判据，不需要再 resolvePricing 一次。
    // `at` 只透传不参与其它判断：tier 判定与四段计价必须用**同一个时刻**，
    // 否则「四段之和 === costUSD」这条等式会在跨时段边界的请求上破掉。
    const b = calculateCostBreakdown(model, usage, this.availableModels, prov, baseURL, at);
    if (b.source === "fallback") this.warnUnknownPricing(model);
    // totalUSD 由 calculateCostBreakdown 内部求和，这里不再加一遍（加一遍会双计）。
    const cost = b.totalUSD;
    stats.costUSD += cost;
    // D12：四段字段名与 CostBreakdown 完全同构（uncachedInputUSD/...），读写两头不用换名。
    stats.uncachedInputUSD = (stats.uncachedInputUSD ?? 0) + b.uncachedInputUSD;
    stats.cacheHitUSD = (stats.cacheHitUSD ?? 0) + b.cacheHitUSD;
    stats.cacheWriteUSD = (stats.cacheWriteUSD ?? 0) + b.cacheWriteUSD;
    stats.outputUSD = (stats.outputUSD ?? 0) + b.outputUSD;
    // D11：按时段拆分（tier 与计价同一个 priceTierAt，见 cost-tracker.ts）。
    // "none"（无分时段政策）归 peak 桶 —— 该模型只有一档价，peak 桶就是它的全额。
    if (b.tier === "offpeak") {
      stats.offpeakCostUSD = (stats.offpeakCostUSD ?? 0) + cost;
    } else {
      stats.peakCostUSD = (stats.peakCostUSD ?? 0) + cost;
    }
    // D11：记端点（剥 query，见 sanitizedBaseURL）与价格来源，/cost 按「模型 + 端点」
    // 取到和计费同一条价。会话中途 /model 切换后，这里的端点跟着换。
    // pricingSource 直接取 breakdown.source：它已经是细粒度值（`gateway:expr` / `pricing` /
    // `fallback` / `local`），CostBreakdown 上没有第二个来源字段可回退。
    if (baseURL) stats.pricingBaseURL = SessionState.sanitizedBaseURL(baseURL);
    stats.pricingSource = b.source;

    // D13：逐次明细环形缓冲（有界）。/cost 的轮次分析（p50/p95/max/最贵几次）从这里取数，
    // 不从 events.jsonl 读 —— 命令面板首帧不能被磁盘 IO 卡住。作废尝试也记（discarded 标记），
    // 「重试白烧的那次最贵」本身就是要展示的结论之一。
    this.requestSeq += 1;
    this.requestLog.push({
      seq: this.requestSeq,
      at: Date.now(),
      model,
      promptTokens: usage.inputTokens,
      cacheHit: usage.cacheReadInputTokens ?? 0,
      cacheWrite: usage.cacheCreationInputTokens ?? 0,
      outputTokens: usage.outputTokens,
      costUSD: cost,
      discarded,
    });
    if (this.requestLog.length > SessionState.REQUEST_LOG_CAP) {
      // splice 而不是 shift：一次裁掉超出部分，均摊 O(1)。
      this.requestLog.splice(0, this.requestLog.length - SessionState.REQUEST_LOG_CAP);
    }

    // 累加缓存节省（全价假设 − 实际）
    stats.cacheSavingsUSD += this.calculateSavings(model, usage, prov, baseURL);

    // 更新全局统计
    this.totalCostUSD += cost;
    this.totalAPIDuration += durationMs;
    this.notifyCostChanged();
    // G2：返回本次入账金额，供 usage-sink 落 SubagentCost 事件（与状态栏同一个数，不重算）。
    return cost;
  }

  /** 累加工具执行耗时 */
  addToolDuration(durationMs: number): void {
    this.totalToolDuration += durationMs;
  }

  /**
   * 重置累计计数器（/clear 时调用）。
   * 清空 totalCostUSD、totalAPIDuration、totalToolDuration 和所有 modelUsage，
   * 使状态栏的 token/费用/缓存命中等统计归零，与清空的对话上下文保持一致。
   */
  resetCounters(): void {
    this.totalCostUSD = 0;
    this.sideCostUSD = 0;
    this.totalAPIDuration = 0;
    this.totalToolDuration = 0;
    this.modelUsage = {};
    // D13：逐次明细随计数器一起清（/clear 开新会话，旧会话的轮次分析不该残留）。
    this.requestLog = [];
  }

  /**
   * /clear：切换到一个新会话（对齐 CC `regenerateSessionId({ setCurrentAsParent: true })`）。
   *
   * 只做「身份 + 会话级计数」的切换：新 id、父 id、起点时间、用量计数器、轮次序号。
   * 必须在旧会话 SessionEnd **之后**调用 —— SessionEnd 的 stats 读的正是这些旧值，
   * 先换再收尾会把旧会话的成本记成 0（这正是 rotate 之前「往旧文件落归零快照」的病）。
   *
   * sessionData 中与 reminder 去重相关的键由 resetReminderDedupKeys 单独清，
   * 其余 sessionData 是命令间共享的临时状态，不随会话切换丢弃（与改动前一致）。
   */
  rotate(newSessionId: string): void {
    this.parentSessionId = this.sessionId;
    this.sessionId = newSessionId;
    this.startTime = Date.now();
    this.resetCounters();
    this.absoluteTurnCount = 0;
    this.promptSeq = 0;
  }

  /**
   * 重置 reminder 通道的跨轮去重/基线键（/clear 时调用）。
   *
   * 这些键挂在 sessionData 上是**故意的**——它们必须跨用户消息存活，否则每条新消息
   * 都会重建、去重形同白做（见 loop.ts 里 announcedDeferredTools / lastSeenPermissionMode
   * 的注释，都踩过"挂 LoopState 导致每条消息归零"的坑）。
   *
   * 但"跨消息"不等于"跨 /clear"：`/clear` 清空了对话历史，模型对之前播报过的
   * 延迟工具列表、权限模式提醒完全失忆，而去重键还记着"已经告诉过它了" →
   * 新一轮对话里**永远不再播报**，延迟工具机制在 /clear 后彻底失效。
   * 这与 compact 路径的 deferredToolsPendingAfterCompact 是同一类问题，
   * compact 已处理，/clear 此前漏了（2026-07-30 重复注入根因修复时发现）。
   *
   * `resetCounters()` 只动用量统计、不碰 sessionData，故单独一个方法；
   * 两处 /clear 分支（斜杠命令结构化结果 / 旧 switch 分支）都必须调用。
   */
  resetReminderDedupKeys(): void {
    this.sessionData.delete("announcedDeferredTools");
    this.sessionData.delete("lastSeenPermissionMode");
    this.sessionData.delete("lastSeenContextPressureLevel");
  }

  /**
   * /clear：清「本任务进展」类状态（CG-2 / 台账 H4）。
   *
   * 与 `resetReminderDedupKeys` 分开命名，因为清的语义不同：
   * 那三个键是「已经告诉过模型什么」（播报/去重基线），这两个是「这个任务做到哪了」。
   * 共同点同样成立——都必须跨用户消息存活（挂 LoopState 会每条消息归零），
   * 但都**不能跨 /clear**：新的对话对旧任务完全失忆，旧进展留着只是假信号。
   *
   * 为什么必须清：`filesChanged` / `metrics` 记的是**上一个任务**的落盘事实。
   * /clear 之后模型看到的第一条 work-log 就是「已落盘改动 N 个文件（…）」
   * → 把旧任务的成果当成本次进展，于是不再动手。台账实测 4 会话 / 6 条。
   *
   * 键名只消费 query 侧的常量、不复制字面量：复制会在常量改名时静默漏清
   * （CG-5 把 /clear 重置改成从登记表派生时，这两个键会一并收编）。
   */
  resetTaskProgressKeys(): void {
    this.sessionData.delete(MEASURED_PROGRESS_KEY);
    this.sessionData.delete(TODO_REWORK_KEY);
  }

  /**
   * 累加辅助调用花费（影子调用：标题生成/记忆召回/bash分类/摘要压缩/缓存预热等）。
   * 只累加费用，不并入 modelUsage（避免污染 stock 口径的"当前上下文大小"展示）。
   * 由 side-call-sink 在每次 recordSideCall 时回调。
   */
  addSideCost(costUSD: number): void {
    this.sideCostUSD += costUSD;
    this.notifyCostChanged();
  }

  /**
   * 入账观察者（20261020 ce7ea52e 发现 8）：每次 updateUsage / addSideCost 之后同步回调一次。
   *
   * 为什么挂在这里而不是 query loop 的 AfterModel：账本要的是「钱已经记进 SessionState」
   * 这个时刻，主循环、子代理 usage-sink、side-call 三条入账路都汇到这两个方法；挂在任一
   * 消费侧都只覆盖一条路。
   *
   * ⚠️ 这是**覆盖式单槽位**：第二次调用会挤掉前一个监听器。多消费方共存（账本落盘 + UI
   * 推送）必须用 {@link addCostChangeListener}，不要再调本方法。
   */
  setCostChangeListener(fn: ((effectiveCostUSD: number) => void) | null): void {
    this.costChangeListener = fn;
  }

  /**
   * 追加一个入账订阅者，返回反注册函数（D1）。
   *
   * 与覆盖式 {@link setCostChangeListener} 并存而不是取代它：账本落盘那条线已按单槽位
   * 接线并有源码断言锁着，改语义的收益为零、牵连却按跨层算。新增消费方一律走这里。
   *
   * 为什么需要它（D1 根因）：辅助调用（后台记忆 fork / 标题生成 / SessionEnd 前收尾）
   * 只走 `addSideCost`，而 UI 的费用列此前只在「工具结束 / 一轮结束 / 中断」这五个固定
   * 时机重新读值。一轮结束之后才入账的辅助费用于是永远推不到 Footer —— 实测一次会话
   * Footer 少报 43%（$0.0856 vs 真实 $0.1501），且用户不再输入就永不更新。
   *
   * 返回的反注册函数是幂等的：重复调用无害，退出路径不必判重。
   */
  addCostChangeListener(fn: (effectiveCostUSD: number) => void): () => void {
    this.costChangeSubscribers.add(fn);
    return () => {
      this.costChangeSubscribers.delete(fn);
    };
  }

  /** 入账版本号（单调递增，rotate 不清零也无妨：判脏只比较是否相等）。 */
  getUsageVersion(): number {
    return this.usageVersion;
  }

  private notifyCostChanged(): void {
    this.usageVersion++;
    const cost = this.getEffectiveTotalCostUSD();
    const fn = this.costChangeListener;
    if (fn) {
      try {
        fn(cost);
      } catch {
        /* 观察者异常不影响入账 */
      }
    }
    // 追加订阅者：逐个独立 try/catch —— 账本落盘抛错不该阻断 UI 刷新，反之亦然。
    // 不允许遍历时增删（回调里反注册自己）：Set 的 delete 在 for...of 中是安全的，
    // 但为免受回调里 add 影响迭代，先拷一份。
    for (const sub of [...this.costChangeSubscribers]) {
      try {
        sub(cost);
      } catch {
        /* 单个订阅者异常不影响其他订阅者与入账 */
      }
    }
  }

  /**
   * 序列化当前用量统计为可持久化快照（用于会话落盘 + resume 恢复）。
   *
   * 覆盖 Footer 状态栏展示所需的全部维度：
   * - 各模型的 modelUsage（token 三口径 / cache / cost / cacheSavings / provider）——
   *   getTotalUsage / getStockPromptTokens / getTotalCacheSavings 全部从这里派生。
   * - 全局 totalCostUSD / sideCostUSD——getEffectiveTotalCostUSD（费用列）从这里派生。
   * - totalAPIDuration / totalToolDuration——供耗时展示恢复。
   *
   * 注意：不含 sessionData（临时数据）、availableModels（启动时注入）、
   * warnedUnknownModels（去重集，无需跨会话保留）——这些要么会被重新注入，要么无展示意义。
   */
  serializeUsageSnapshot(): UsageSnapshot {
    return {
      totalCostUSD: this.totalCostUSD,
      sideCostUSD: this.sideCostUSD,
      totalAPIDuration: this.totalAPIDuration,
      totalToolDuration: this.totalToolDuration,
      modelUsage: JSON.parse(JSON.stringify(this.modelUsage)) as Record<string, ModelUsageStats>,
    };
  }

  /**
   * 从持久化快照回灌用量统计（resume 恢复路径调用）。
   *
   * 直接覆盖当前累计值——resume 时 SessionState 是全新零值实例，覆盖等价于「继续之前的
   * 累计」。回灌后后续 updateUsage 会在此基础上继续累加，Footer 展示连续不断档。
   *
   * 容错：快照缺字段/类型不符时按零值兜底，绝不因脏快照抛错阻断恢复。
   */
  hydrateUsage(snapshot: UsageSnapshot | undefined | null): void {
    if (!snapshot || typeof snapshot !== "object") return;
    this.totalCostUSD = typeof snapshot.totalCostUSD === "number" ? snapshot.totalCostUSD : 0;
    this.sideCostUSD = typeof snapshot.sideCostUSD === "number" ? snapshot.sideCostUSD : 0;
    this.totalAPIDuration =
      typeof snapshot.totalAPIDuration === "number" ? snapshot.totalAPIDuration : 0;
    this.totalToolDuration =
      typeof snapshot.totalToolDuration === "number" ? snapshot.totalToolDuration : 0;
    const restored: Record<string, ModelUsageStats> = {};
    const src = snapshot.modelUsage;
    if (src && typeof src === "object") {
      for (const [model, s] of Object.entries(src)) {
        if (!s || typeof s !== "object") continue;
        restored[model] = {
          inputTokens: Number((s as ModelUsageStats).inputTokens) || 0,
          stockPromptTokens: Number((s as ModelUsageStats).stockPromptTokens) || 0,
          cumulativePromptTokens: Number((s as ModelUsageStats).cumulativePromptTokens) || 0,
          outputTokens: Number((s as ModelUsageStats).outputTokens) || 0,
          cacheReadInputTokens: Number((s as ModelUsageStats).cacheReadInputTokens) || 0,
          cacheCreationInputTokens: Number((s as ModelUsageStats).cacheCreationInputTokens) || 0,
          requests: Number((s as ModelUsageStats).requests) || 0,
          // 作废量必须与 requests 一起回灌：`serializeUsageSnapshot` 是整个 modelUsage
          // 深拷贝，盘上**本来就有**这两个字段，此前只是回灌时漏读。漏读的后果不是
          // "少个调试字段"——状态栏的白烧后缀 `⟳ 12 ✘3` 与 `⟳ 12` 同源于一次 resume，
          // 分子归零而分母（requests）连续，就成了"重试白烧凭空消失"，
          // 而这正是 requests 相对 absoluteTurn 被选中的理由（口径跨 resume 一致）。
          discardedRequests: Number((s as ModelUsageStats).discardedRequests) || 0,
          discardedPromptTokens: Number((s as ModelUsageStats).discardedPromptTokens) || 0,
          costUSD: Number((s as ModelUsageStats).costUSD) || 0,
          cacheSavingsUSD: Number((s as ModelUsageStats).cacheSavingsUSD) || 0,
          // D7：币种/汇率必须一起回灌 —— 漏了它 resume 后 `≈$` 判据无声丢失，
          // 同一笔换算过的钱在重启前后写法不一致（旧快照无这两个字段时保持 undefined）。
          priceCurrency:
            typeof (s as ModelUsageStats).priceCurrency === "string"
              ? (s as ModelUsageStats).priceCurrency
              : undefined,
          priceFxToUSD:
            typeof (s as ModelUsageStats).priceFxToUSD === "number"
              ? (s as ModelUsageStats).priceFxToUSD
              : undefined,
          // D12：推理 token / 四段费用必须一起回灌 —— 漏了它 resume 后「其中推理」
          // 和费用拆分整段静默归零，而总费用（costUSD）连续，四段之和 ≠ 总费用的
          // 自相矛盾正是 D12 要消灭的。旧快照（PR-B 之前）无这些字段 → 0，
          // /cost 显示时按「无拆分」处理（见 cost-report.ts 的 carriedBreakdown 标记）。
          reasoningTokens: Number((s as ModelUsageStats).reasoningTokens) || 0,
          uncachedInputUSD: Number((s as ModelUsageStats).uncachedInputUSD) || 0,
          cacheHitUSD: Number((s as ModelUsageStats).cacheHitUSD) || 0,
          cacheWriteUSD: Number((s as ModelUsageStats).cacheWriteUSD) || 0,
          outputUSD: Number((s as ModelUsageStats).outputUSD) || 0,
          // D11：时段拆分同上；peak + offpeak 之和 === costUSD 的等式跨 resume 必须成立。
          peakCostUSD: Number((s as ModelUsageStats).peakCostUSD) || 0,
          offpeakCostUSD: Number((s as ModelUsageStats).offpeakCostUSD) || 0,
          // D11：端点与价格来源。旧快照无 → undefined（端点未知，/cost 按 availableModels 回退）。
          pricingBaseURL:
            typeof (s as ModelUsageStats).pricingBaseURL === "string"
              ? (s as ModelUsageStats).pricingBaseURL
              : undefined,
          pricingSource:
            typeof (s as ModelUsageStats).pricingSource === "string"
              ? (s as ModelUsageStats).pricingSource
              : undefined,
          provider:
            typeof (s as ModelUsageStats).provider === "string"
              ? (s as ModelUsageStats).provider
              : "",
        };
      }
    }
    this.modelUsage = restored;
  }

  /**
   * 获取真实总花费 = 主循环 + 辅助调用。
   * 用于 TUI 费用列展示、/cost 命令、quota/costLimit 守卫。
   */
  getEffectiveTotalCostUSD(): number {
    return this.totalCostUSD + this.sideCostUSD;
  }

  /**
   * 本会话入账用到的价格里，是否发生过「非 USD 币种 → USD」的汇率折算（D7）。
   *
   * 展示层用它决定金额前写 `≈$` 还是 `$`。判据只看**价格数据本身**，与模型名无关：
   * - 内置注册表里 DeepSeek 是 CNY 计价（`fxToUSD` 折算过）→ 该加 `≈`；
   * - 网关 `billing_expr` 给的价已经是 USD（没折算）→ 不该加 `≈`；
   * 两者模型名可能完全相同，按名字判必然有一边是错的（旧实现 `/deepseek/i.test(model)`
   * 就踩在这上面：同名模型走美元网关价时也标 ≈）。
   *
   * 声明了非 USD 却**没有** `fxToUSD` 的价不算折算：`effectivePricing` 对这种情况
   * 不猜汇率、原样当 USD 用（见 cost-tracker.ts），那笔钱没经过换算，加 `≈` 反而是误导。
   */
  isCostFxConverted(): boolean {
    return Object.values(this.modelUsage).some(
      (s) =>
        typeof s.priceCurrency === "string" &&
        s.priceCurrency !== "USD" &&
        typeof s.priceFxToUSD === "number" &&
        s.priceFxToUSD > 0,
    );
  }

  /**
   * 本会话真正折算过的币种及其换算率（按币种去重），供 /cost 写换算说明。
   *
   * 只收 {@link isCostFxConverted} 认定的那批（判据同源），返回 `perUSD` 是本币/USD
   * 的比值（即展示用的「1 USD = perUSD ¥」），由 `1 / fxToUSD` 派生。
   */
  getCurrencyConversions(): Array<{ currency: string; perUSD: number }> {
    const byCurrency = new Map<string, number>();
    for (const s of Object.values(this.modelUsage)) {
      if (
        typeof s.priceCurrency === "string" &&
        s.priceCurrency !== "USD" &&
        typeof s.priceFxToUSD === "number" &&
        s.priceFxToUSD > 0
      ) {
        byCurrency.set(s.priceCurrency, 1 / s.priceFxToUSD);
      }
    }
    return [...byCurrency].map(([currency, perUSD]) => ({ currency, perUSD }));
  }

  /**
   * 计算单次 API 调用的成本（方案 §2.3 口径修复 / D20 公式合并）。
   *
   * **修复前的 bug**：旧实现用 `regularInput = inputTokens − cacheRead − cacheCreation`，
   * 对 Anthropic 会重复扣减——Anthropic 的 inputTokens 本就是未命中余量，再减一次导致
   * regularInput 偏小、费用算低。
   *
   * **现在**：公式唯一实现在 `cost-tracker.ts` 的 {@link calculateCostBreakdown}
   * （归一化为互斥三段后分别计价，不做减法），本函数只负责
   * ① 按模型推断 provider；② 未知模型按模型去重告警；③ 返回合计。
   *
   * 为什么不再自己乘一遍（D20）：`calculateUSDCost`（轨迹重算 / digest 对账）走的是另一条
   * 入口，两份等价公式在本地方案上已经分叉 —— 同一个 ollama 会话，界面上是 $0、
   * 轨迹重算却按兜底价算出非零费用。判据只留一份才不会再次漂移。
   *
   * PR-B 起：公式本体收口到 cost-tracker.ts 的 {@link calculateCostBreakdown}（全仓唯一一份），
   * 本方法保留为**公开重算入口**（trace 对账 / calculateSavings 走它），
   * 委托 breakdown 并对 fallback 价记 WARN（告警按模型去重，与 updateUsage 路径互不重复）。
   *
   * @param model 模型名
   * @param usage 原始用量
   * @param provider provider 名（"anthropic"/"openai"/...）。不传时按模型名推断（claude* → anthropic）。
   */
  calculateCost(
    model: string,
    usage: Usage,
    provider?: string,
    baseURL?: string,
    /** D1：计价时刻（分时段定价输入）。缺省"现在"；重算历史会话须传那次请求的时刻。 */
    at?: Date,
  ): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    const breakdown = calculateCostBreakdown(model, usage, this.availableModels, prov, baseURL, at);
    // P1-4：未知模型不静默归零（否则换个模型名费用立刻变 0，costLimit 守卫被绕过，
    // 用户以为"免费"实际在烧钱）。记 WARN 一次（按模型去重），用保守兜底价估算成本，
    // 宁可高估也不归零，让预算守卫继续生效。
    // 判据取自计价结果的 source —— 不再自己 resolvePricing 一次（那会是第二份「有没有价」的判定）。
    if (breakdown.source === "fallback") this.warnUnknownPricing(model);
    return breakdown.totalUSD;
  }

  /**
   * 计算单次调用的缓存节省金额（美元）= 假设全部按未命中全价 − 实际成本。
   * 全价假设：把 promptTotal 全部当未命中输入计价。
   *
   * P2-2（2026-08-08）：pricing 缺失时**不再返回 0**，改用与 {@link calculateCost}
   * 同源的 FALLBACK_PRICING 估算。旧行为造成一个必然出现的自相矛盾状态：
   * calculateCost 在 pricing=null 时用兜底价估出**非零成本**，而这里直接 return 0
   * ——于是账本里出现"成本非零、节省恒零"的行，看起来像"缓存完全没省钱"，
   * 实际只是两个函数对同一个未知模型给了不同答案。实测 349 会话里 81 个
   * savingsUSD=0，这是其中一条独立成因（另外三条：本地 provider、无命中时数学恒 0、
   * Math.max 钳位，都是正确行为，只有这条是缺陷）。
   */
  calculateSavings(
    model: string,
    usage: Usage,
    provider?: string,
    baseURL?: string,
    /** D1：计价时刻。**必须与同一次调用的 calculateCost 传同一个值** —— 见下方注释。 */
    at?: Date,
  ): number {
    const prov = provider ?? SessionState.inferProvider(model, this.availableModels);
    // 本地 provider 无费用 → 无"节省"概念，恒 0（判据收口在 cost-tracker，D20）
    if (isLocalProviderName(prov)) return 0;
    // D1：全价假设必须与实际成本走**同一份生效价**。
    //
    // 不折算的后果是本函数末尾那个减法两边口径不同：`hypothetical` 用高峰价、
    // `actual`（走 calculateCost）用空闲价，于是空闲时段的"节省"里混进了一半的
    // 时段折扣 —— 那不是缓存省下来的钱，把它算进 savingsUSD 就是虚报缓存收益。
    const rawPricing = resolvePricing(model, this.availableModels, baseURL);
    const pricing = rawPricing ? effectivePricing(rawPricing, at) : null;
    const n = normalizeCacheUsage(usage, prov);
    // pricing 缺失时与 calculateCost 走同一套兜底价（该函数会记 WARN，此处不重复告警）。
    // 引用 cost-tracker 导出的唯一一份常量 —— 两处各写一份兜底价，改一处不会带着另一处走。
    const inputPrice = pricing?.input ?? FALLBACK_PRICING.input;
    const outputPrice = pricing?.output ?? FALLBACK_PRICING.output;
    // 全价成本：promptTotal 全按未命中输入 + 输出
    const hypothetical =
      (n.promptTotal / 1_000_000) * inputPrice + (n.outputTokens / 1_000_000) * outputPrice;
    // 传同一个 `at`：两边必须是同一时刻的价，否则减法两边口径不同（见上方注释）。
    const actual = this.calculateCost(model, usage, prov, baseURL, at);
    return Math.max(0, hypothetical - actual);
  }

  /**
   * 按模型名推断 provider，供 calculateCost 在调用方未显式传 provider 时兜底。
   *
   * 优先级：
   *   1. availableModels 中同名模型的 provider 字段（权威，用户配置）
   *   2. 内置启发式：模型名 claude* → "anthropic"；其余 → "openai"
   *   注：ollama 无缓存字段，归一化后 hit/write 恒 0，归到哪类都不影响结果。
   */
  /**
   * 从 baseURL 提取 host（P0-4）。非法/空 URL 返回 undefined。
   *
   * 只取 host：path 与 query 可能带 key 之类的敏感串，而渠道归因只需要 host。
   * 不抛错 —— 用量记账绝不能因为一个畸形 URL 而中断。
   */
  static hostOf(baseURL?: string): string | undefined {
    if (!baseURL || baseURL.trim() === "") return undefined;
    try {
      return new URL(baseURL).host || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 剥掉 query 串的 baseURL（D11）。非法 URL 返回 undefined。
   *
   * 与 {@link hostOf} 的分工：host 只够「渠道归因」，而 /cost 要按「模型 + 端点」重新
   * `resolvePricing` 取到和计费**同一条**价，复合键匹配需要完整 URL（origin + pathname）。
   * 只剥 query 不剥 path：path 参与端点身份（`/v1` 与无路径是不同部署），query 只装
   * key 之类的敏感串，必须丢。
   */
  static sanitizedBaseURL(baseURL?: string): string | undefined {
    if (!baseURL || baseURL.trim() === "") return undefined;
    try {
      const u = new URL(baseURL);
      return `${u.origin}${u.pathname}` || undefined;
    } catch {
      return undefined;
    }
  }

  static inferProvider(model: string, availableModels?: PricingModelEntry[]): string {
    // D6：唯一实现在 llm/provider-infer.ts（配置 provider > 真名锚定匹配）。
    // 空名保持旧语义 "openai"（本函数的调用方都是计价/归一化，从不传空名，防御而已）。
    const p = inferProviderByModelName(model, availableModels);
    return p === "unknown" ? "openai" : p;
  }

  /**
   * 判定是否本地推理 provider（不产生 API 费用）。
   *
   * 仅凭模型名无法识别（ollama 跑 llama3 等会被 inferProvider 归为 "openai"），
   * 必须依赖显式传入的 provider 名。本地 provider 计费/节省恒 0，避免 FALLBACK_PRICING
   * 把免费的本地推理算成真金白银、误触 costLimit。
   *
   * PR-B/D20：实现收口到 cost-tracker.ts 的 `isLocalPricingProvider`（calculateUSDCost
   * 那条轨迹重算路径也要同一个判断），本方法保留为兼容委托——`cache-usage.test.ts`
   * 等既有调用方不感知。
   */
  static isLocalProvider(provider: string | undefined): boolean {
    // D20：判据唯一实现在 llm/provider-infer.ts，计价（calculateCostBreakdown）
    // 与展示/节省（本文件）共用同一份，避免「界面免费、重算收费」再次分叉。
    return isLocalProviderName(provider);
  }

  /**
   * 汇总全会话的归一化缓存视图（跨所有模型累加三段）。
   * 供 Footer 命中率列、会话摘要、SessionEnd 账本使用——单一事实源。
   */
  getNormalizedCacheUsage(): NormalizedCacheUsage {
    const total: NormalizedCacheUsage = {
      cacheHitTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      promptTotal: 0,
    };
    for (const stats of Object.values(this.modelUsage)) {
      const n = normalizeCacheUsage(
        {
          // ⚠️ 必须用 cumulativePromptTokens（flow）而非 inputTokens（stock）。
          // 命中数 cacheReadInputTokens 是累加值；若输入用末次值，
          // OpenAI/DeepSeek 口径 uncached = max(0, input − hit) 会被钳到 0
          // （多轮后累加命中可达 80k+ 远超末次输入 ~18k），命中率虚高、省钱失真。
          inputTokens: stats.cumulativePromptTokens,
          outputTokens: stats.outputTokens,
          cacheReadInputTokens: stats.cacheReadInputTokens,
          cacheCreationInputTokens: stats.cacheCreationInputTokens,
        },
        stats.provider,
      );
      total.cacheHitTokens += n.cacheHitTokens;
      total.cacheWriteTokens += n.cacheWriteTokens;
      total.uncachedInputTokens += n.uncachedInputTokens;
      total.outputTokens += n.outputTokens;
      total.promptTotal += n.promptTotal;
    }
    return total;
  }

  /**
   * 全会话缓存命中率（0-100 整数），`undefined` = 没有缓存命中可算。
   *
   * **状态栏（Footer ⚡）的唯一取数源**。D18 之前 Footer 走的是另一套算法：
   * 拿全会话合计 `usage` 配「当前模型」推断出的 provider 去 `normalizeCacheUsage`，
   * 单模型会话看不出来，但只要会话里换过模型、或主模型与子代理协议族不同，
   * anthropic 的 `inputTokens`（未命中余量）就会被当成 openai 的 `prompt_tokens`（含命中）
   * 去减，反之亦然——命中率直接算错，而且和 /cost 是两个数。
   *
   * `undefined`（而不是 0）用于区分「无缓存数据」和「命中率确实是 0%」：
   * 前者不渲染 ⚡ 列（避免对无缓存模型显示 0% 误导），后者如实显示。
   */
  getCacheHitRate(): number | undefined {
    const view = this.getNormalizedCacheUsage();
    if (view.cacheHitTokens <= 0 || view.promptTotal <= 0) return undefined;
    return Math.round((view.cacheHitTokens / view.promptTotal) * 100);
  }

  /** 全会话累计缓存节省金额（美元） */
  getTotalCacheSavings(): number {
    let sum = 0;
    for (const stats of Object.values(this.modelUsage)) {
      sum += stats.cacheSavingsUSD;
    }
    return sum;
  }

  /** 已告警过的未知模型（按模型名去重，避免每次调用刷屏） */
  private warnedUnknownModels = new Set<string>();

  /** 对未知定价模型记一次 WARN（去重） */
  private warnUnknownPricing(model: string): void {
    if (this.warnedUnknownModels.has(model)) return;
    this.warnedUnknownModels.add(model);
    getLogger().warn(
      "SESSION",
      `模型 "${model}" 不在定价表中，已用保守兜底价（input $${FALLBACK_PRICING.input}/M、output $${FALLBACK_PRICING.output}/M）估算成本。` +
        `如需精确计费，请在定价表或 availableModels 配置中补充该模型价格。`,
    );
  }

  /**
   * D13：逐次入账明细的只读视图（/cost 的轮次分析从这里取数）。
   *
   * 返回浅拷贝数组而不是内部引用：消费方排序/切片不会改动环形缓冲；
   * entry 本身是纯数据，浅拷贝足够。不落盘（serializeUsageSnapshot 不含），
   * resume 后只有本进程的部分——/cost 显示时写明「本进程 N 次」。
   */
  getRequestLog(): RequestLogEntry[] {
    return [...this.requestLog];
  }

  /**
   * 用户配置的模型列表（含 pricing/provider）。D11：/cost 的单价显示要按
   * 「模型 + 端点」重新 resolvePricing 取到和计费同一条价，计价复用的
   * 就是这份列表 —— 展示侧必须用同一份，否则两处各查各的。
   */
  getAvailableModels(): PricingModelEntry[] {
    return this.availableModels;
  }

  /**
   * 获取汇总的 Usage（兼容旧接口）。
   *
   * DISP-1 FIX：inputTokens 改为 flow 累计口径（cumulativePromptTokens），
   * 与 cacheReadInputTokens 累加口径一致，确保 deriveCacheMetrics 的命中率计算分母正确。
   * 此前用 stock 末次值（stats.inputTokens = 每次覆盖仅保留末次），导致分子（flow 累计）≫ 分母（stock 末次），
   * 命中率经常 >100% 甚至飙升到几千 %。
   */
  getTotalUsage(): Usage {
    const total: Usage = { inputTokens: 0, outputTokens: 0 };
    for (const stats of Object.values(this.modelUsage)) {
      total.inputTokens += stats.cumulativePromptTokens;
      total.outputTokens += stats.outputTokens;
      total.cacheCreationInputTokens =
        (total.cacheCreationInputTokens ?? 0) + stats.cacheCreationInputTokens;
      total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + stats.cacheReadInputTokens;
    }
    return total;
  }

  /**
   * 累计输入 prompt token（flow 口径，各模型 cumulativePromptTokens 之和）。
   * DISP-1：与逐次累加的 totalCostUSD 口径可比（"花了多少钱 ↔ 累计喂了多少 token"）。
   * getTotalUsage().inputTokens 现也已改为 flow 累计口径，与此方法一致。
   */
  getCumulativePromptTokens(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.cumulativePromptTokens;
    }
    return total;
  }

  /**
   * 获取末次输入 token（stock 口径，**provider 原始口径**，各模型 stats.inputTokens 之和）。
   *
   * ⚠️ 口径因 provider 而异（Anthropic=未命中余量 / OpenAI=含命中全量），**不适合直接展示当前上下文**。
   * 展示状态栏「输入 = 当前上下文大小」请用 {@link getStockPromptTokens}（已归一化为末次完整输入）。
   * 本方法保留供需要 provider 原始 inputTokens 的场景（调试/对比）使用。
   *
   * 多模型会话场景：各模型 stock 值简单求和，实践中绝大多数会话只有单一模型。
   */
  getStockInputTokens(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.inputTokens;
    }
    return total;
  }

  /**
   * 获取末次完整输入 token（stock 口径，**归一化 promptTotal**，各模型 stats.stockPromptTokens 之和）。
   *
   * 每次 API 调用覆盖写入 `normalizeCacheUsage(usage, provider).promptTotal`，即末次完整 prompt 大小：
   * - **Anthropic**：input_tokens（未命中余量）+ cache_read + cache_creation = 真实末次上下文。
   * - **OpenAI/DeepSeek**：prompt_tokens（本就含命中）= 完整上下文。
   *
   * 两家统一为「末次完整输入」，是**状态栏「输入」展示的正确口径**（反映当前上下文有多大）。
   * 修复了此前直接用 stats.inputTokens 在 Anthropic 下只显示 cache miss 增量、严重低估上下文的问题。
   *
   * 多模型会话场景：各模型 stock 值简单求和，实践中绝大多数会话只有单一模型。
   */
  getStockPromptTokens(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.stockPromptTokens;
    }
    return total;
  }

  /**
   * 会话累计 API 调用次数（各模型 `requests` 之和）。
   *
   * 口径 = **实际发出的 HTTP 请求数**，所以它**包含**：
   * - 作废重试（`updateUsage` 的 `stats.requests += 1` 落在 `if (!discarded)` **之外**，
   *   见本文件 updateUsage——prompt 已发到服务端、厂商已计费，就得算一次调用）；
   * - 子代理调用（usage-sink 同样走 updateUsage，按 `SubAgentResult.apiRequests`
   *   累加真实请求数——G6 之前一个子代理只 +1，实测 52 vs 真实 103）；
   * - maxTurns 强制总结轮（loop.ts 收尾那次）。
   *
   * **不包含** side-call（标题生成 / 记忆召回 / bash 分类等影子调用）——那些只经
   * `addSideCost`，自有 `side-call-sink` 的计数口径，混进来会让"调用次数"与
   * `total_api_calls` 对不上。
   *
   * 为什么要这个 getter 而不是各处自己 reduce：本仓此前有 3 处逐字抄了同一个
   * `Object.values(modelUsage).reduce((s, m) => s + m.requests, 0)`
   * （SessionEnd 统计 / 崩溃快照 / /stats 面板），任一处漏改就产生"同一会话不同
   * 口径"的漂移。收口到一处后新增消费方（状态栏）不再引入第 4 份实现。
   */
  getTotalRequests(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.requests;
    }
    return total;
  }

  /**
   * 会话累计**作废**的 API 调用次数（各模型 `discardedRequests` 之和）。
   *
   * 作废 = 超时 / 流内错误后重试，响应被丢弃但 prompt 已完整发出并计费（详见
   * `ModelUsageStats.discardedRequests`）。它是 {@link getTotalRequests} 的**子集**，
   * 不是另一批调用——所以状态栏写成 `⟳ 12 ✘3`（12 次里有 3 次白烧），
   * 不是 `12 + 3`。
   *
   * 旧快照无该字段（undefined → 0），对应"这部分历史无从还原"，而不是"真的零白烧"。
   */
  getDiscardedRequests(): number {
    let total = 0;
    for (const stats of Object.values(this.modelUsage)) {
      total += stats.discardedRequests ?? 0;
    }
    return total;
  }

  /** 获取会话运行时长（毫秒） */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** 格式化耗时为可读字符串 */
  static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}m${remainSeconds}s`;
  }
}
