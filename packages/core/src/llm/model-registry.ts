/**
 * 统一模型注册表 — 所有模型参数与定价的**单一事实源**。
 *
 * 设计原则：
 * - 一个模型只在此处定义一次（参数 + 定价合一）
 * - model-params-catalog.ts / cost-tracker.ts / token-estimator.ts 均从此处读取
 * - 支持精确匹配 + 最长前缀 + 路由剥离 + 大小写不敏感 + 家族匹配
 *
 * 数据来源：各厂商官方文档 / API 返回值，更新时间 2026-06
 *
 * ⚠ 依赖约束：本文件曾是**零 import 的纯数据表**，`telemetry/cache-bench-core.ts:15`
 * 的「静态引入不成环」判断引用了这个性质。现在它 import 了 `model-name-normalize.ts` ——
 * 那个模块**自身零 import**（有专门的门禁断言锁住），所以不成环的结论仍然成立。
 * 再往这里加 import 之前，先确认新依赖也是叶子模块，否则要重新核 cache-bench 那条路径。
 */

import { familyBaseName } from "./model-name-normalize.ts";
import type { ModelPricing } from "../api/cost-tracker.ts";

/** 定价（每百万 token，USD） */
/**
 * 注册表定价条目。
 *
 * D1：直接复用 `ModelPricing`，**不再维护一份平行的窄类型**。
 *
 * 原来这里是四个裸数字的独立 interface，与 `api/cost-tracker.ts` 的 `ModelPricing`
 * 结构相同但类型不同。于是给 `ModelPricing` 补了币种/时段/as-of 三个维度之后，
 * 注册表里**填不进去**（类型不认），而注册表恰恰是这些维度最需要落的地方。
 *
 * 用 type alias 而不是 `extends`：两者本就该是同一个东西，
 * 留两个名字只会让下一个人问"该用哪个"。`RegistryPricing` 这个名字保留是为了
 * 不动既有 import（本文件导出它，有外部消费方）。
 */
export type RegistryPricing = ModelPricing;

/**
 * DeepSeek 高峰时段（UTC，半开区间）。
 *
 * 抽成常量而不是在 4 处各写一遍：分时段政策是**厂商级**的，不是模型级的 ——
 * 写 4 遍等于给"下次政策调整只改对其中 3 处"留了个必然会踩的坑。
 * 官方公告口径为 UTC，见各条 pricing 的 `source`。
 *
 * ⚠ 口径差异（deepseek-api.md:134,2238）：官方高峰只算**北京时间周一至周五、
 * 不含中国法定节假日**；周末与法定节假日全天都是空闲价。本常量（以及
 * `cost-tracker.ts` 的时段判定）只按小时判，不看星期与节假日 —— 于是周末 / 节假日
 * 落在这两段小时里的请求会被按高峰价计。偏差方向是**高估**（与「宁可高估触发预算守卫」
 * 的取向一致），所以本次只记下口径差、不改计价逻辑；要精确就得引入节假日日历这一外部数据。
 */
const DEEPSEEK_PEAK_WINDOWS = [
  // 北京时间 09:00–12:00 → UTC 01:00–04:00
  { startHour: 1, endHour: 4 },
  // 北京时间 14:00–18:00 → UTC 06:00–10:00
  { startHour: 6, endHour: 10 },
] as const satisfies ReadonlyArray<{ startHour: number; endHour: number }>;

/**
 * DeepSeek 计价币种换算率（1 CNY = ? USD），as-of 2026-08-21。
 *
 * ## 为什么 DeepSeek 的价存人民币而不是折算好的美元
 *
 * 厂商的计价币种**就是人民币**（官方价目表与账单都是元）。改造前我们存折算后的美元，
 * 而中间那个汇率既没记下来也没有 as-of —— 于是「汇率漂移」与「厂商涨价」
 * 在表里长得一模一样，**无法归因**。本次事故排查时正是卡在这一步：
 * 自报 $0.2234 与账单 ¥7.23 差 4.56 倍，无从判断哪部分是汇率、哪部分是单价。
 *
 * 存原币 + 显式汇率之后，两者各自可查、各自可更新。
 *
 * ⚠ 这是**固定快照**，不是实时汇率。取整数 7.1 而非某天的精确中间价：
 * 精确值会给人"这是实时汇率"的错觉，而它其实和单价一样需要人来更新。
 * 汇率日常波动（±2%）远小于本次事故的量级（456%），不值得引入一个网络依赖。
 */
const DEEPSEEK_CNY_TO_USD = 1 / 7.1;

/** 模型完整参数定义 */
export interface ModelRegistryEntry {
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking?: boolean;

  // ── 协议能力声明（可选，缺省时走 runtime 推断） ──
  systemRole?: "system" | "developer";
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsTemperature?: boolean;
  reasoningEffortValues?: ("low" | "medium" | "high" | "max")[];
  protocolKind?:
    | "deepseek-openai"
    | "deepseek-anthropic"
    | "anthropic-native"
    | "o-series"
    | "glm-openai"
    | "grok-openai"
    | "openai-responses"
    | "unknown";

  /**
   * 多轮工具调用时，是否要求把该轮 assistant 的 reasoning_content 原样回传给 API。
   *
   * - DeepSeek V4（V3.2 起）thinking 模式：`true`——tool-call 轮的 reasoning_content
   *   **必须**回传，否则 API 400（deepseek-api.md:1012/1055/1057）；官方样例（1160-1174 行）
   *   一律 `messages.append(response.choices[0].message)`，含 reasoning_content。
   * - 旧 `deepseek-reasoner`（R1 系，2026/07/24 弃用前）：`false` 或 undefined——
   *   输入携带 reasoning_content 会触发旧协议 400，必须落掉。
   * - 其它模型（无 reasoning_content 概念）：字段无意义，缺省 undefined。
   *
   * 详见 docs/bugfixes/todo/deepseek-reasoning-leak-as-text-任务中断.md 方案⓪。
   */
  requiresReasoningContentForToolCalls?: boolean;

  /**
   * Extended Thinking 模式（Anthropic 协议族专用）。
   *
   * - `"adaptive"`：Opus 4.7+/Sonnet 4.6/Fable 5 — 下发 `thinking:{type:"adaptive"}` + `output_config.effort`
   * - `"always-on"`：Fable 5/Mythos 5 — 自适应始终开启，不可关闭（`thinking:{type:"disabled"}` 返回 400）
   * - undefined（= "manual" 兜底）：旧模型 — 下发 `thinking:{type:"enabled", budget_tokens:N}`
   *
   * [来源: anthropic-api.md:320-323]
   */
  thinkingMode?: "adaptive" | "always-on";

  /**
   * 推理语言漂移倾向：该模型的思考过程（reasoning/thinking）在中文语境下
   * 容易自发漂移到英文，需要更强的语言约束措辞（system-prompt.ts 的「铁律级」
   * 身份指令 + `<internal_en>` 疏导）才能稳定输出中文。
   *
   * 背景（必删-4 根治）：此前 system-prompt.ts 用 `model.includes("deepseek")`
   * 字符串匹配决定走哪套措辞——违反"不按模型名硬编码分档"原则（见 memory
   * `feedback-no-hardcoded-model-tier-rules.md`），模型改名/新版/同类新模型都会漂移。
   * 改为能力标志后，是否需要强约束由注册表数据驱动，新增同类模型只需在此声明。
   *
   * - DeepSeek V4 系（思考模型，中文语境下 reasoning 明显英文漂移）：`true`
   * - 其它模型：缺省 undefined（= false，走标准语言措辞）
   */
  reasoningLanguageDrift?: boolean;

  /**
   * 是否接受图片输入（vision）。**按模型声明，不按 provider**：同一个 OpenAI 兼容
   * provider 下，`deepseek-flash` 支持图片而 `deepseek-v4-pro` 不支持（deepseek-api.md:1831）。
   *
   * 此前能力挂在 provider 上（`OpenAIProvider.capabilities().vision` 写死 false），
   * 于是支持图片的模型走 OpenAI 兼容路径时图片被一律降级成「你看不到」的文字说明——
   * 用户看到的是「当前 provider 不支持图片回传」，真因是我们没发。
   *
   * - `true`：Read 读到的图片会以 `image_url` 内容块发给模型
   * - 缺省 undefined（= false）：降级为文字说明（宁可让模型知道「看不到」，也不冒 400）
   *
   * 用户侧出口：`availableModels[].compat.supportsVision`（网关私有模型名匹配不到时用）。
   */
  supportsVision?: boolean;

  // ── 定价（可选，USD/百万 token） ──
  pricing?: RegistryPricing;
}

const REGISTRY: Record<string, ModelRegistryEntry> = {
  // ══════════════════════════════════════════════════════════════════
  // Anthropic Claude
  // ══════════════════════════════════════════════════════════════════
  // ── 5.5 / 5.1 一代（2026-10 核对，anthropic-api.md:966-1000）──────────
  // ⚠ 文档自注：`claude-fable-5-1`、`claude-sonnet-5-5` 两个 ID 是按命名规则推断的
  // （anthropic-api.md:960,966,968 带 `*`），`claude-opus-5-5` / `claude-haiku-5-5` 在正文
  // 代码里真实出现过。推断 ID 若与线上不符，只是精确键 miss，不会借错别的模型的值。
  //
  // thinkingMode：Opus 5.5 / Sonnet 5.5 / Fable 5.1 传 `disabled` 均 400（anthropic-api.md:388-390），
  // 所以标 always-on；Haiku 5.5 不在该矩阵里（只在 969 行写「自适应」），按 adaptive 处理。
  //
  // 窗口 1M / 输出 128k：anthropic-api.md:966-969。
  "claude-opus-5-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "always-on",
    // 输入/输出 anthropic-api.md:967；缓存 5m 写 $5 / 读 $0.20（anthropic-api.md:1000）
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  "claude-sonnet-5-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "always-on",
    // 输入/输出 anthropic-api.md:968；缓存 5m 写 $2.50 / 读 $0.20（anthropic-api.md:1000）
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  // Haiku 5.5 按 prompt 长度分档计价（以 100K 为界，anthropic-api.md:972-980）：
  // >100K 时输入/输出/缓存全部 ×5。本结构表达不了分档，这里存 ≤100K 档 ——
  // 长 prompt 会被**低估 5 倍**，用它跑长会话时成本数字要打折看。
  "claude-haiku-5-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "adaptive",
    // 「输入只支持文本和图片」（anthropic-api.md:982）
    supportsVision: true,
    pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  "claude-fable-5-1": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "always-on",
    // 输入/输出 anthropic-api.md:966；5m 写 $12.50（anthropic-api.md:1000）。
    // 文档没给 Fable 5.1 的缓存读价，故不写 cacheRead（调用方按 input×0.1 近似）。
    pricing: { input: 10, output: 50, cacheWrite: 12.5 },
  },
  "claude-fable-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "always-on",
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
  "claude-mythos-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "always-on",
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
  "claude-opus-4-8": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "adaptive",
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  "claude-opus-4-7": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "adaptive",
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  "claude-opus-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "adaptive",
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  // ⚠ 已退役（Anthropic 自营平台请求会失败，部分合作平台仍可用；文档未给日期）：
  // anthropic-api.md:1008。条目保留：删掉后历史会话的成本估算会落到 FALLBACK 高估。
  "claude-opus-4-20250514": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  "claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    thinkingMode: "adaptive",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  "claude-sonnet-4-5-20250514": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  // ⚠ 已退役（同上，anthropic-api.md:1008）。保留理由同 claude-opus-4-20250514。
  "claude-sonnet-4-20250514": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  "claude-haiku-4-20250514": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    protocolKind: "anthropic-native",
    pricing: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 },
  },
  // ⚠ 2025-10-28 已退役（anthropic-api.md:1013），替代 claude-sonnet-4-6。保留供历史会话计价。
  "claude-3-5-sonnet-20241022": {
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    protocolKind: "anthropic-native",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  // ⚠ 已退役（Haiku 3.5，anthropic-api.md:1008；文档未给日期）。保留供历史会话计价。
  "claude-3-5-haiku-20241022": {
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    protocolKind: "anthropic-native",
    pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
  // ⚠ 2026-01-05 已退役（anthropic-api.md:1014），替代 claude-opus-4-8。保留供历史会话计价。
  "claude-3-opus-20240229": {
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    supportsThinking: false,
    protocolKind: "anthropic-native",
    pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },

  // ══════════════════════════════════════════════════════════════════
  // DeepSeek
  // ══════════════════════════════════════════════════════════════════
  // DeepSeek V4（V3.2 起）：thinking 模式支持工具调用，tool-call 轮必须回传 reasoning_content。
  //
  // ── D1（2026-08-21 事故修复）：单价已按 2026-08-16 16:00 UTC 生效的新政策更新 ──
  //
  // 旧值（`input: 0.435 / output: 0.87 / cacheRead: 0.0036`）是 08-16 涨价**之前**的价，
  // 涨价后一直没人发现，直到用户拿 DeepSeek 开放平台账单来对：我们自报 $0.2234、
  // 官方 ¥7.23，差 4.56 倍，其中 3.21 倍就是这张表过期造成的。
  //
  // 新政策有两个我们原来表达不了的维度，现在靠 `peakWindows` / `offPeakMultiplier` 表达：
  //   · 分高峰 / 空闲两档，空闲价恰为高峰价的一半（`offPeakMultiplier: 0.5`）；
  //   · 高峰时段 = 01:00–04:00 与 06:00–10:00 UTC，其余为空闲。
  // `input`/`output`/`cacheRead` 存**高峰价**（保守：宁可高估触发预算守卫，不低估放任烧钱）。
  //
  // ⚠️ 涨幅最大的是**缓存命中**（V4-Pro 命中价 0.003625 → 0.044，12.1x）。
  // 这一条最容易被忽略，因为"命中几乎免费"曾经是对的 —— 而本仓的 cache 命中率目标是
  // >70%，命中量占输入的大头，所以命中价涨 12 倍对我们的影响**大于**输出价涨 4.6 倍。
  // 别照着旧印象做容量假设。
  //
  // `cacheWrite: 0` 保留：DeepSeek 无缓存写入计费概念（不是"免费"，是这个维度不存在）。
  "deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    requiresReasoningContentForToolCalls: true,
    reasoningLanguageDrift: true,
    // 图像理解：**不支持**（deepseek-api.md:106,1831,2232）。显式 false 而不是缺省：
    // Anthropic 路径只在 === false 时才不发图，缺省会让 /anthropic 端点照发图片吃 400。
    supportsVision: false,
    pricing: {
      // 高峰价，人民币（deepseek-api.md:115,117,119；V4-Pro 计费不变，见 138 行）
      input: 9,
      output: 27,
      cacheRead: 0.3,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-10-10",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  "deepseek-v4-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    requiresReasoningContentForToolCalls: true,
    reasoningLanguageDrift: true,
    // 图像理解：支持（deepseek-api.md:106,1831,2231）
    supportsVision: true,
    pricing: {
      // 高峰价，人民币（deepseek-api.md:115,117,119；空闲价为其一半，由 offPeakMultiplier 派生）
      input: 2,
      output: 8,
      cacheRead: 0.04,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-10-10",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  "DeepSeek-V4-Flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    requiresReasoningContentForToolCalls: true,
    reasoningLanguageDrift: true,
    // 图像理解：支持（deepseek-api.md:106,1831,2231）
    supportsVision: true,
    pricing: {
      // 高峰价，人民币（deepseek-api.md:115,117,119；空闲价为其一半，由 offPeakMultiplier 派生）
      input: 2,
      output: 8,
      cacheRead: 0.04,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-10-10",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  "DeepSeek-V4-Pro": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    requiresReasoningContentForToolCalls: true,
    reasoningLanguageDrift: true,
    // 与 `deepseek-v4-pro` 同一个模型、大小写不同的另一个键（注册表按精确名分开登记，
    // 见 lookupRegistryExact 注释）。**两条必须同步改** —— 只改一条的后果是
    // 用户按哪种写法配模型名，决定了他拿到新价还是旧价。
    // 图像理解：**不支持**（deepseek-api.md:106,1831,2232）。显式 false 而不是缺省：
    // Anthropic 路径只在 === false 时才不发图，缺省会让 /anthropic 端点照发图片吃 400。
    supportsVision: false,
    pricing: {
      // 高峰价，人民币（deepseek-api.md:115,117,119；V4-Pro 计费不变，见 138 行）
      input: 9,
      output: 27,
      cacheRead: 0.3,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-10-10",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  // ── V4.1-Flash（2026-09-10 发布并降价，deepseek-api.md:17,138）──────────
  // 官方现行主名是 `deepseek-flash`（deepseek-api.md:53,56）；`deepseek-v4-flash` /
  // `DeepSeek-V4-Flash` 已是路由到它的别名，按 Flash 价计费（deepseek-api.md:132,2233），
  // 所以上面两条与这里同值。四条 Flash 键**必须同步改**，理由同 DeepSeek-V4-Pro 注释。
  //
  // 窗口 / 输出：文档写 1M（1048576）/ 384K（393216）（deepseek-api.md:98-99,2231）。
  // 这里沿用既有 V4 条目的 1_000_000 / 384_000 取整口径，让同一模型的四个键数值一致，
  // 且比文档精确值略保守（低估窗口 ≈4.6% 只会早压缩，不会撞 400）。
  "deepseek-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    // 「支持非思考与思考模式（默认）」（deepseek-api.md:97）
    supportsThinking: true,
    requiresReasoningContentForToolCalls: true,
    reasoningLanguageDrift: true,
    // 图像理解：支持（deepseek-api.md:106,1831,2231）
    supportsVision: true,
    pricing: {
      // 高峰价，人民币（deepseek-api.md:115,117,119；空闲价为其一半，由 offPeakMultiplier 派生）
      input: 2,
      output: 8,
      cacheRead: 0.04,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-10-10",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  // `deepseek-v4-1-flash` **不是官方 ID**（官方枚举只有 deepseek-flash / deepseek-v4-pro，
  // deepseek-api.md:2236），而是网关常用拼法：用户真实配置里是 `origin-deepseek-v4-1-flash`，
  // 查找时剥掉 `origin-` 前缀后剩这个名字。没有这条时它精确 miss，模糊层又因
  // `deepseek-v4-1-flash` 不以任何键为「变体后缀」开头而落空 → 计价落 FALLBACK、vision 判 false。
  // 值与 deepseek-flash 完全相同（同一个底层模型 V4.1-Flash）。
  "deepseek-v4-1-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    requiresReasoningContentForToolCalls: true,
    reasoningLanguageDrift: true,
    supportsVision: true,
    pricing: {
      // 高峰价，人民币（deepseek-api.md:115,117,119）
      input: 2,
      output: 8,
      cacheRead: 0.04,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-10-10",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  // ⚠ `deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 停用**，官方页面不再列出
  // （deepseek-api.md:22,57,2236）。条目保留只为历史会话的成本估算不落 FALLBACK 高估；
  // 价格刻意**停在停用前的 V4-Flash 价**（¥3/¥9/¥0.1，asOf 2026-08-21）——停用后不会再有
  // 新调用按 09-10 的 Flash 降价计费，把它们改成新价反而会让历史账对不上。
  "deepseek-chat": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: false,
    pricing: {
      // 高峰价，人民币（空闲价为其一半，由 offPeakMultiplier 派生）
      input: 3,
      output: 9,
      cacheRead: 0.1,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-08-21",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  // 旧 deepseek-reasoner（R1 系）：输入携带 reasoning_content 会触发旧协议 400，保持不回传（缺省 false）。
  "deepseek-reasoner": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    requiresReasoningContentForToolCalls: false,
    reasoningLanguageDrift: true,
    pricing: {
      // 高峰价，人民币（空闲价为其一半，由 offPeakMultiplier 派生）
      input: 3,
      output: 9,
      cacheRead: 0.1,
      cacheWrite: 0,
      currency: "CNY",
      fxToUSD: DEEPSEEK_CNY_TO_USD,
      peakWindows: DEEPSEEK_PEAK_WINDOWS,
      offPeakMultiplier: 0.5,
      asOf: "2026-08-21",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // OpenAI / GPT
  // ══════════════════════════════════════════════════════════════════
  // GPT-6 系（openai-api.md:860-863，2026-10-10 核对）。窗口 1.05M / 输出 128K。
  // protocolKind=openai-responses：GPT-6 在 Chat Completions 上基本不能调工具
  // （astra 只能走 Responses、6.1-sol 完全不支持、6-sol/luna 仅 effort:none 可用；
  // openai-api.md:47,860-863），sid-code 是工具密集型，必须走 Responses。
  // supportsThinking 沿用 GPT-5.6 族的写法（false），避免同一 Responses 路径上出现两套分支；
  // 推理档位由 Responses 的 reasoning.effort 承载，不靠这个位。
  // 长上下文：输入 >272K 时整单 2× 输入 / 1.5× 输出（openai-api.md:878），本表不表达分层。
  "gpt-6-astra": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    // 不支持 temperature/top_p（openai-api.md:111,860）
    supportsTemperature: false,
    // patch 计费 1.2 倍率表明列（openai-api.md:350,352）
    supportsVision: true,
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
  // 6.1-sol / 6-sol / 6-luna：图像计费表未列出（openai-api.md:350 明写「未验证」），
  // 所以 supportsVision 不写（三态的「不知道」），OpenAI 兼容路径默认不发图。
  "gpt-6.1-sol": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    // 缓存读是 0.05× 输入（openai-api.md:293,861），不是通常的 0.1×
    pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  "gpt-6-sol": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  "gpt-6-luna": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  // 注：`gpt-5.3-codex` 有价（$1.75 / $0.175 / $14，openai-api.md:872），但文档该行
  // 上下文 / 最大输出为「—」。contextWindow 是必填字段，不凭记忆补，故**不登记**；
  // 它会走采集缓存 / 模糊层。
  //
  // GPT-5.6 族（2026-07-09 GA，三档：luna 轻量 / terra 均衡 / sol 旗舰）。
  // 三者 contextWindow、maxOutputTokens、能力位完全一致，只有价格与推理质量不同。
  // `gpt-5.6` 裸名是别名，官方路由到 sol。
  //
  // ⚠ contextWindow=1_050_000 但官方另有 **max input 922_000** 的独立限制——超过即返回
  // "input exceeds the context window"（实测 900k 过、990k 拒）。sid-code 目前无「输入上限」
  // 字段来表达这个差异，故此处如实填窗口值；真正的输入裁剪由 auto-compact 的完成缓冲区兜底。
  // [官方: developers.openai.com/api/docs/models/gpt-5.6-sol；实测: 自建网关夹逼]
  //
  // pricing 为**官方标准价**（USD/1M）。网关渠道价（luna 实采 0.17/1.02）由 gateway-pricing.ts
  // 按渠道名精确命中并优先于此——此处仅作渠道 miss 时的兜底，勿用渠道价覆盖。
  // 注：官方对 >272K 输入的请求按 2x input / 1.5x output 计价，本表不表达该分层。
  //
  // ── 2026-10-10 回源核价（openai-api.md:864-866）──
  // sol 当前是**促销价**（$4/$20，「至少到 2026-11-21」，openai-api.md:864），促销结束后
  // 要再核一次；terra / luna 也比旧值低。缓存写 = 1.25× 输入（openai-api.md:877）。
  //
  // vision：图像 token 计费表把 gpt-5.6-* 列在 patch 计费 1.2 倍率档（openai-api.md:349-350），
  // 即官方明确接受图片输入。
  "gpt-5.6": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  },
  "gpt-5.6-sol": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  },
  "gpt-5.6-terra": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  "gpt-5.6-luna": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  },
  // vision：gpt-5.5、gpt-5.4 系、gpt-5.2 在图像 patch 计费 1.2 倍率档（openai-api.md:350）
  "gpt-5.5": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  },
  "gpt-5.5-pro": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    pricing: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
  },
  "gpt-5.4": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  },
  "gpt-5.4-mini": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  },
  "gpt-5.4-nano": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  },
  "gpt-5.4-pro": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    pricing: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
  },
  "gpt-5.2": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    protocolKind: "openai-responses",
    supportsVision: true,
    pricing: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  },
  // gpt-4.1：窗口 1,047,576 / 输出 32,768、价格 $2/$0.50/$8（openai-api.md:873）。
  // 旧值 maxOutputTokens 128_000 高估 4 倍，按它下发 max_tokens 会被拒；>128K 输入走长上下文限额。
  // tile 计费 85+170/块（openai-api.md:354）→ 接受图片。别名目前无下线日期（openai-api.md:897）。
  "gpt-4.1": {
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsThinking: false,
    supportsVision: true,
    pricing: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  },
  // vision：patch 计费 1.62 倍率（openai-api.md:350）。价格本轮文档未复核（openai-api.md:880），保持原值。
  "gpt-4.1-mini": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    supportsVision: true,
    pricing: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
  },
  // ⚠ 计划 **2026-10-23 下线**（openai-api.md:892）。vision：patch 计费 2.46 倍率（openai-api.md:350）。
  "gpt-4.1-nano": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    supportsVision: true,
    pricing: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  },
  // vision：gpt-4o / gpt-4o-mini 在 tile 计费表（openai-api.md:354）。价格本轮未复核（openai-api.md:880）。
  "gpt-4o": {
    supportsVision: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  },
  "gpt-4o-mini": {
    supportsVision: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  },

  // ── O-Series ─────────────────────────────────────────────────────
  // ⚠ `o3-2025-04-16` 计划 **2026-12-11 下线**（openai-api.md:874,894）。
  // 价格 $2/$0.50/$8（openai-api.md:874）：缓存读旧值 0 是漏填。tile 计费（openai-api.md:354）→ vision。
  o3: {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
    supportsVision: true,
    pricing: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  },
  // ⚠ 计划 **2026-12-11 下线**（openai-api.md:894）。价格本轮未复核（openai-api.md:880）。
  "o3-pro": {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
    pricing: { input: 20, output: 80, cacheRead: 0, cacheWrite: 0 },
  },
  // ⚠ 计划 **2026-10-23 下线**（openai-api.md:892）。
  "o3-mini": {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
  },
  // ⚠ 计划 **2026-10-23 下线**（openai-api.md:875,892）。
  // 价格 $1.10/$0.275/$4.40（openai-api.md:875）；vision：patch 计费 1.72 倍率（openai-api.md:350）。
  "o4-mini": {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
    supportsVision: true,
    pricing: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  },
  // ⚠ 计划 **2026-10-23 下线**（openai-api.md:892）。tile 计费（openai-api.md:354）→ vision。
  o1: {
    supportsVision: true,
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
  },

  // ══════════════════════════════════════════════════════════════════
  // Google Gemini
  // ══════════════════════════════════════════════════════════════════
  "gemini-3.5-flash": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  },
  "gemini-3.1-pro-preview": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  },
  "gemini-3.1-flash-lite": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  },
  "gemini-3.1-flash-preview": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  "gemini-3.1-flash-image": {
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    supportsThinking: false,
    pricing: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  "gemini-3-flash-preview": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  // ⚠ gemini-2.5-pro / -flash / -flash-lite 计划 **2026-10-16 停用**（gemini-api.md:643-645,684-685），
  // 替代 3.5-flash / 3.1-flash-lite。条目保留供历史会话计价。
  // 2.5-pro 是分层价（>200K 输入 $2.50/$15，gemini-api.md:643），本表只存 ≤200K 档。
  "gemini-2.5-pro": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  "gemini-2.5-flash": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  },
  "gemini-2.5-flash-lite": {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  },

  // ══════════════════════════════════════════════════════════════════
  // Kimi (Moonshot)
  // ══════════════════════════════════════════════════════════════════
  // 价格取国际站美元价（kimi-api.md:375-378），与本节既有条目同口径。
  // 当前在售只有 4 个模型：k3 / k2.7-code / k2.7-code-highspeed / k2.6（kimi-api.md:37,356）。
  // vision：文档只写了 image_url 内容块的格式约束（kimi-api.md:165-172），没逐个模型说明，故不标。
  //
  // kimi-k3：窗口 1,048,576；max_completion_tokens 默认 131072（kimi-api.md:87）；始终思考。
  // 缓存写只有 K3 计费（kimi-api.md:389），取 5m 档 $3（kimi-api.md:375）。K3 不分段计价（380 行）。
  "kimi-k3": {
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  },
  // k2.7-code：262,144 / 默认 32768（kimi-api.md:88,92）；$0.95/$4/$0.19（kimi-api.md:376）
  "kimi-k2.7-code": {
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    supportsThinking: true,
    pricing: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  },
  // highspeed 与 k2.7-code 同一模型、参数一致（kimi-api.md:89），但**价格是 2 倍**：
  // $1.90/$8/$0.38（kimi-api.md:377）。旧值照抄了 k2.7-code 的价，低估一半。
  "kimi-k2.7-code-highspeed": {
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    supportsThinking: true,
    pricing: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
  },
  "kimi-k2.6": {
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    supportsThinking: true,
    pricing: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  },
  // ⚠ kimi-k2.5 与 moonshot-v1-* 全系 **2026-08 全平台下线**，调用返回 404（kimi-api.md:37,99）。
  // 以下 4 条保留只为历史会话的成本估算不落 FALLBACK 高估。
  "kimi-k2.5": {
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    supportsThinking: true,
    pricing: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  },
  "moonshot-v1-8k": {
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    pricing: { input: 0.2, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
  "moonshot-v1-32k": {
    contextWindow: 32_768,
    maxOutputTokens: 16_384,
    pricing: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
  },
  "moonshot-v1-128k": {
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    pricing: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0 },
  },

  // ══════════════════════════════════════════════════════════════════
  // 通义千问 Qwen
  // ══════════════════════════════════════════════════════════════════
  "qwen3.7-max": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 1.68, output: 5.04, cacheRead: 0.336, cacheWrite: 0 },
  },
  "qwen3.7-plus": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 },
  },
  "qwen3.6-plus": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 },
  },
  "qwen3.6-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "qwen3.5-plus": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 },
  },
  "qwen3.5-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "qwen-plus": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 },
  },
  "qwen-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "qwen3-coder-plus": {
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    supportsThinking: false,
    pricing: { input: 0.84, output: 3.36, cacheRead: 0.168, cacheWrite: 0 },
  },
  "qwen3-coder-flash": {
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    supportsThinking: false,
    pricing: { input: 0.21, output: 0.84, cacheRead: 0.042, cacheWrite: 0 },
  },
  "qwen-vl-plus": { contextWindow: 131_072, maxOutputTokens: 32_768, supportsThinking: true },
  "qwen-long": { contextWindow: 10_000_000, maxOutputTokens: 6_000 },

  // ══════════════════════════════════════════════════════════════════
  // 智谱 GLM
  // ══════════════════════════════════════════════════════════════════
  // 智谱 GLM（OpenAI 兼容端点）。protocolKind=glm-openai：有 thinking 开关；仅 GLM-5.2 支持
  // reasoning_effort（含 max）。tool_choice 仅 auto（openai.ts applyToolChoice 对 glm 降级）。
  // [来源: glm-api.md:144-147,189-201,276]
  //
  // vision：文本模型 user content 只接受 string，数组（含 image_url）只有视觉模型接受
  // （glm-api.md:190）→ 文本模型一律显式 false；视觉模型（glm-5.3-flash/flashx、glm-5v-turbo、
  // glm-4.6v）显式 true（glm-api.md:126,141）。新增条目文档没给价，均不写 pricing。
  //
  // GLM-5.3 系：1M / 128K（glm-api.md:125-126；max_tokens 上限 131072，glm-api.md:172）；
  // **强制思考**，reasoning_effort 只有 low/high/max（glm-api.md:209,225）。
  "glm-5.3": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    reasoningEffortValues: ["low", "high", "max"],
    // 「仅文本模态」（glm-api.md:125）
    supportsVision: false,
  },
  "glm-5.3-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    reasoningEffortValues: ["low", "high", "max"],
    // 「原生多模态（归在视觉模型下）」（glm-api.md:126）
    supportsVision: true,
  },
  "glm-5.3-flashx": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    reasoningEffortValues: ["low", "high", "max"],
    supportsVision: true,
  },
  // 视觉模型：glm-5v-turbo 200K/128K、glm-4.6v 128K/32K（glm-api.md:141；4.6v 输出上限 32768，174 行）。
  // 文档没说它们的思考能力，supportsThinking 不写。
  "glm-5v-turbo": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    protocolKind: "glm-openai",
    supportsVision: true,
  },
  "glm-4.6v": {
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    protocolKind: "glm-openai",
    supportsVision: true,
  },
  "glm-5.2": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
    reasoningEffortValues: ["low", "medium", "high", "max"],
    pricing: { input: 1.4, output: 4.2, cacheRead: 0.7, cacheWrite: 0 },
  },
  "glm-5.1": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
    pricing: { input: 0.7, output: 2.1, cacheRead: 0.35, cacheWrite: 0 },
  },
  "glm-5": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
    pricing: { input: 0.7, output: 2.1, cacheRead: 0.35, cacheWrite: 0 },
  },
  "glm-5-turbo": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
    pricing: { input: 0.42, output: 1.26, cacheRead: 0.21, cacheWrite: 0 },
  },
  "glm-4.7": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
    pricing: { input: 0.28, output: 0.84, cacheRead: 0.14, cacheWrite: 0 },
  },
  "glm-4.7-flashx": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
  },
  "glm-4.7-flash": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  "glm-4.6": {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
  },
  // ⚠ glm-4.5 已不在模型概览与接口枚举中（glm-api.md:140），新接入不要用；保留供历史会话计价。
  "glm-4.5": {
    contextWindow: 128_000,
    maxOutputTokens: 96_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
  },
  "glm-4.5-air": {
    contextWindow: 128_000,
    maxOutputTokens: 96_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
  },
  "glm-4.5-flash": {
    contextWindow: 128_000,
    maxOutputTokens: 96_000,
    supportsThinking: true,
    protocolKind: "glm-openai",
    supportsVision: false,
  },
  "glm-4-flash-250414": {
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    supportsThinking: false,
    supportsVision: false,
  },

  // ══════════════════════════════════════════════════════════════════
  // xAI Grok
  // ══════════════════════════════════════════════════════════════════
  // xAI Grok（OpenAI 兼容端点）。protocolKind=grok-openai：无 thinking 开关；reasoning_effort
  // 无 max（max→high）；推理模型用 max_completion_tokens。[来源: grok-api.md:30,32,157,277,487]
  //
  // 2026-10-10 回源（grok-api.md:79-90）：
  //   · vision：「全部为文本 + 图片输入、文本输出」（grok-api.md:90）→ 全系 true（图片只收 jpg/png，34 行）。
  //   · maxOutputTokens 128_000 = max_completion_tokens 默认值（grok-api.md:29）。
  //   · 长上下文：prompt（含缓存）≥200K 时**整单**约 2× 计价（grok-api.md:27,77），本表不表达分层。
  //   · effort：4.6/4.7 还有 `xhigh`、4.3 还有 `none`/`xhigh`（grok-api.md:28,81-84），
  //     但 reasoningEffortValues 的类型只有 low/medium/high/max，表达不了这两档，只登记交集。
  //     4.5+ 不可关推理，传 none 会报错（grok-api.md:28,382）。
  //
  // grok-4.7 / 4.6：500K，$2.00 / 缓存 $0.50 / $6.00（grok-api.md:81-82）。
  "grok-4.7": {
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "grok-openai",
    maxTokensField: "max_completion_tokens",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsVision: true,
    pricing: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  },
  "grok-4.6": {
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "grok-openai",
    maxTokensField: "max_completion_tokens",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsVision: true,
    pricing: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  },
  // grok-4.5：500K，$2.00 / 缓存 **$0.30** / $6.00；effort low/medium/high（grok-api.md:83）。
  "grok-4.5": {
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "grok-openai",
    maxTokensField: "max_completion_tokens",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsVision: true,
    pricing: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
  },
  // grok-4.3：1M，$1.25/$0.20/$2.50（grok-api.md:84），仍在售未退役（grok-api.md:25）。
  "grok-4.3": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "grok-openai",
    maxTokensField: "max_completion_tokens",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsVision: true,
    pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  },
  "grok-build-0.1": {
    contextWindow: 262_144,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "grok-openai",
    maxTokensField: "max_completion_tokens",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsVision: true,
    pricing: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  },
  "grok-4.20-0309-reasoning": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    protocolKind: "grok-openai",
    maxTokensField: "max_completion_tokens",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsVision: true,
    pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  },
  "grok-4.20-0309-non-reasoning": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    supportsVision: true,
    pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  },

  // ══════════════════════════════════════════════════════════════════
  // Embedding
  // ══════════════════════════════════════════════════════════════════
  "text-embedding-v4": {
    contextWindow: 8_192,
    maxOutputTokens: 0,
    pricing: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  "text-embedding-3-small": {
    contextWindow: 8_191,
    maxOutputTokens: 0,
    pricing: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  "text-embedding-3-large": {
    contextWindow: 8_191,
    maxOutputTokens: 0,
    pricing: { input: 0.13, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  "text-embedding-ada-002": {
    contextWindow: 8_191,
    maxOutputTokens: 0,
    pricing: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
};

/**
 * 已知供应商路由前缀白名单（连字符式，非 "/" 分隔）。
 *
 * 网关/聚合服务常给同一底层模型加供应商前缀（阿里百炼 `ali-`、火山方舟 `volc-` /
 * `volcengine-`、硅基流动 `siliconflow-`、腾讯 `hunyuan-`/`tencent-` 等）。这些前缀不在
 * 注册表 key 中，导致定价/参数匹配全部落空。此处**显式白名单**精确剥离，绝不按通用
 * "-" 拆分——否则会误伤 `claude-`、`gpt-`、`glm-`、`grok-` 等本就以连字符构成的正规名。
 *
 * 新增网关前缀时在此追加即可（保持全小写，含末尾连字符）。
 *
 * ⚠ **必须与 `model-name-normalize.ts` 的 `ROUTE_PREFIX_RE` 同步**（那份是
 * `ali|tx|volc|origin|hw|az`）。两份不同步就是「采集侧认、注册表侧不认」的静默 miss：
 * 采集缓存能按剥离后的名命中，注册表却查不到 → 定价落 FALLBACK、`supportsVision` 判不知道。
 * 实测漂移形态：此前这里缺 `origin-`，用户真实配置 `origin-deepseek-v4-1-flash` /
 * `origin-deepseek-v4-pro` 在注册表一侧全部返回 null。
 */
const ROUTE_PREFIXES = [
  // 与 model-name-normalize.ts ROUTE_PREFIX_RE 对齐的四个（此前缺失）
  "origin-",
  "tx-",
  "hw-",
  "az-",
  "ali-",
  "aliyun-",
  "bailian-",
  "dashscope-",
  "volc-",
  "volcengine-",
  "siliconflow-",
  "hunyuan-",
  "tencent-",
] as const;

/**
 * **精确**查找：只做「注册表里确实有这个键」的匹配，绝不猜。
 *
 * 层级仅两级，都不越过「同一个模型」的边界：
 *   1. 精确键；
 *   2. 大小写不敏感（注册表里 `deepseek-v4-pro` 与 `DeepSeek-V4-Pro` 是分开登记的两个键，
 *      但它们指的确实是同一个模型，大小写差异不构成「猜」）。
 *
 * ── 为什么必须把它从 lookupRegistry 里拆出来（2026-08-20）────────────
 *
 * 拆分的维度是**匹配精度**，不是数据来源。原先 `lookupRegistry` 是一个六级瀑布
 * （精确 + 最长前缀 + 路由剥离 + 供应商前缀剥离 + 大小写 + 家族），任何一级命中就返回；
 * 而调用链把它整个排在采集缓存（`lookupCapability`，~3000 条、刻意只做精确匹配）**之前**。
 * 于是「一个 90 条、带模糊匹配的手写表」压在「一个数千条、精确匹配的采集表」上面 ——
 * 谨慎的那一方被排到了激进的那一方后面。
 *
 * 实测受害形态：`glm-5.3` 在注册表里不存在，但它 startsWith `glm-5`（200K）→ 前缀命中 →
 * 直接 return，采集到的真实 1M 窗口**永远看不到**（低估 5 倍）。同一个模型在探针门禁上
 * 二次受害：门禁 `if (lookupRegistry(x)) return` 把「猜到」当成「知道」，于是它的 effort
 * 档位永远探不到。
 *
 * 正确的优先级是：**所有精确匹配排在所有模糊匹配之前，无论数据来自哪一层**。
 *   用户配置 → 别名解析 → 本函数（registry 精确）→ lookupCapability（采集精确）
 *   → lookupRegistryFuzzy（registry 模糊）→ 兜底
 * 两条理由都成立且不矛盾：精确的手写表比第三方采集准；第三方**精确命中**比手写表**猜的**准。
 *
 * 用它做布尔判定（「这个模型我们确实知道吗」）是安全的 —— 这正是
 * `gateway-pricing.ts::isBareVendorName` 当年不得不绕开 `lookupRegistry` 的原因，
 * 那条踩坑记录现在由本函数在类型层面兜住，不必每个调用点各自绕。
 */
export function lookupRegistryExact(model: string): ModelRegistryEntry | null {
  if (REGISTRY[model]) return REGISTRY[model];
  const lower = model.toLowerCase();
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (key.toLowerCase() === lower) return entry;
  }
  return null;
}

/**
 * **模糊**查找：精确层全部 miss 之后的最后近似，会跨模型借值。
 *
 * 匹配策略（精度从高到低）：最长前缀 → 剥离 "/" 路由前缀 → 剥离供应商连字符前缀
 * → 大小写不敏感 → 版本感知借用（同主版本、只向下）→ 家族匹配。
 *
 * ⚠ 定位很重要：它在新链路里排在**采集缓存之后**，所以只服务「三层数据全 miss」的模型
 * （实测三源 + 归一化后剩 8 个厂商变体后缀）。它的边界条件错了不再直接产出 5 倍失真 ——
 * 这正是「不打补丁」与「打补丁」的区别：让 D1–D3 承担主责，本函数退化成低频兜底。
 *
 * 行为与拆分前的 `lookupRegistry` 等价（回归锁在 model-registry.test.ts），
 * 唯一新增的是版本感知那一级。
 */
export function lookupRegistryFuzzy(model: string): ModelRegistryEntry | null {
  // 1. 最长前缀匹配（覆盖 deepseek-v4-flash-maxthink 等变体）
  let best: ModelRegistryEntry | null = null;
  let bestLen = 0;
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (isVariantSuffixOf(model, key) && key.length > bestLen) {
      best = entry;
      bestLen = key.length;
    }
  }
  if (best) return best;

  // 1.5 版本感知借用（同主版本、只向下）——必须在**前缀匹配之后、路由剥离之前**。
  // 位置的理由：前缀命中是「同一个模型的变体后缀」（`gpt-5.4-mini-xxx` → `gpt-5.4-mini` 的
  // 400K），比跨版本借用可信 —— 反过来先跑版本借用会让它退到 `gpt-5.4` 的 1050K，
  // 把一个 mini 模型按满血款估算。而它必须先于路由剥离，否则 `z-ai/glm-5.3` 这类形态
  // 在剥离后的递归里会走完整条链路，版本借用反而拿不到机会（见下方第二处调用点）。
  const versioned = lookupVersionAware(model);
  if (versioned) return versioned;

  // 2. 剥离路由前缀后重试（如 "kim/kimi-k2.6" → "kimi-k2.6"）
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) {
    const bare = model.slice(slashIdx + 1);
    if (REGISTRY[bare]) return REGISTRY[bare];
    for (const [key, entry] of Object.entries(REGISTRY)) {
      // 与上面第 1 级同一条边界约束：必须是变体后缀形态。裸 startsWith 会让
      // `z-ai/glm-5.3` 剥离后命中 `glm-5`，版本借用又一次拿不到机会 ——
      // 这正是「修 A 漏 B」那个陷阱的实体：两处前缀循环必须同步改，漏一处
      // 带 vendor 前缀的三种形态（z-ai/ zai/ openrouter/）就会全部绕过修复。
      if (isVariantSuffixOf(bare, key) && key.length > bestLen) {
        best = entry;
        bestLen = key.length;
      }
    }
    if (best) return best;
    // ⚠ 剥离后**也要**走一次版本感知：`z-ai/glm-5.3` / `openrouter/glm-5.3` 这类带 vendor
    // 前缀的形态在上面那次调用里 miss（整串不以任何 registry 键开头）。
    // 只改一处的话这三种形态会绕过整个修复 —— 实测它们当前全部错配到 glm-5 的 200K。
    const bareVersioned = lookupVersionAware(bare);
    if (bareVersioned) return bareVersioned;
  }

  // 3.5 剥离已知供应商路由前缀后重试（如 "ali-deepseek-v4-pro" → "deepseek-v4-pro"）
  // 某些网关/聚合服务给模型名加连字符供应商前缀（阿里百炼 ali-、火山 volc- 等），
  // 这些前缀不在注册表 key 里 → 前缀匹配(startsWith)与家族匹配全部 miss → 费用误落
  // FALLBACK 高估数倍，且 calculateSavings 遇 pricing=null 直接返回 0（"省钱恒 $0"）。
  // 用白名单精确剥离，绝不盲目按 "-" 拆分（否则会误伤 claude-/gpt-/glm- 等本就以连字符
  // 构成的正规模型名）。剥离后递归复用完整匹配策略；bare 每次严格变短，必然终止。
  //
  // ⚠ 定位：前缀剥离已降为**最后兜底**。渠道精确价由 gateway-pricing.ts 提供，
  // resolvePricing 的网关查询（步骤 3）先于本函数（步骤 4）——网关采到 "ali-deepseek-v4-pro"
  // 的渠道精确价即命中返回，根本走不到这里的剥离。仅当网关缓存 + 用户配置都 miss（缓存过期/
  // 冷门渠道名）时，才靠剥离退到官方价，聊胜于 FALLBACK。剥离**会抹平渠道差价**（把 ali-/tx-
  // 都套成官方价），是「查无此模型」的下策兜底，不是精确计费路径。
  for (const prefix of ROUTE_PREFIXES) {
    if (model.startsWith(prefix) && model.length > prefix.length) {
      // 递归进**完整**链路（精确 + 模糊）：剥掉 `ali-` 之后剩下的可能是一个精确键。
      const rest = model.slice(prefix.length);
      const hit = lookupRegistryExact(rest) ?? lookupRegistryFuzzy(rest);
      if (hit) return hit;
    }
  }

  // 4. 大小写不敏感匹配
  const lower = model.toLowerCase();
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (key.toLowerCase() === lower) return entry;
  }

  // 5. 家族匹配（剥离尾部日期/批次后缀后精确匹配家族基名）
  // 例如 "claude-sonnet-4-20260101" 的家族基名 = "claude-sonnet-4"
  // 匹配表中 "claude-sonnet-4-20250514" 的家族基名 = "claude-sonnet-4"（精确相等）
  // 但不会误匹配 "claude-sonnet-4-6"（其家族基名仍是 "claude-sonnet-4-6"，不等）
  //
  // ⚠ 判据来自 `model-name-normalize.ts` 的 `familyBaseName`，**不再在这里内联正则**。
  // 此前这里是 `/-\d{4,}.*$/`（4 位起），与查询侧 `normalizeCandidates` 的日期规则
  // （恰好 6 或 8 位）实质不同 —— 同一个模型名在两条链路上被判成不同的家族，
  // 且分叉不报错，只会静默借错窗口。见该模块头部「为什么家族基名也归这里」。
  const modelBase = familyBaseName(model);
  if (modelBase.length > 0 && modelBase !== model) {
    // 仅当 familyBase 确实剥离了尾部时才做家族匹配
    bestLen = 0;
    for (const [key, entry] of Object.entries(REGISTRY)) {
      const keyBase = familyBaseName(key);
      if (keyBase === modelBase && keyBase.length > bestLen) {
        best = entry;
        bestLen = keyBase.length;
      }
    }
  }
  return best;
}

/**
 * 兼容包装：**精确优先，再模糊**，行为与拆分前的六级瀑布等价。
 *
 * ⚠ 新代码不要用它。它存在的唯一理由是那批「窗口无关」的调用点（协议判定、纯展示）——
 * 对它们而言拆 exact/fuzzy 没有语义收益，改动只增加 diff 面。
 *
 * 需要「这个模型我们确实知道吗」的布尔判定，一律用 `lookupRegistryExact`；
 * 需要窗口 / 输出上限 / 价格，一律显式写成
 * `lookupRegistryExact(x) → lookupCapability(x) → lookupRegistryFuzzy(x)` 三段，
 * 让「采集精确数据」有机会插在中间 —— 那才是本次拆分的全部意义。
 */
export function lookupRegistry(model: string): ModelRegistryEntry | null {
  return lookupRegistryExact(model) ?? lookupRegistryFuzzy(model);
}

/**
 * 版本感知借用：`glm-5.3` 在表里没有时，借**同主版本、版本号不高于它**的最近条目。
 *
 * ── 三条约束，每条都对应一个具体的错值 ────────────────────────────────
 *
 * 1. **同主版本才借**。`kimi-k3` 不得借 `kimi-k2.6` —— 跨主版本是重新设计的模型，
 *    实测借了会把 kimi-k3 的 1M 窗口缩成 262K。
 * 2. **只向下借，不向上借**。`glm-5.1` 不得借 `glm-5.2` 的 1M（5.1 真实窗口 200K，
 *    向上借就是高估）。取「≤ 目标版本的最大已知版本」。
 * 3. **只借同一个前缀家族**。`glm-` 与 `gpt-` 各自成族，靠「去掉版本号后的前缀相等」判定，
 *    不做任何跨厂商联想。
 *
 * ── 为什么它排在最后一层（这个定位是本次修复改过来的）──────────────
 *
 * 旧方案让版本感知承担主要修复责任，于是它的每一个边界条件都是生产风险。
 * D1（加 models.dev 镜像）之后 `glm-5.3` 在**采集精确**那一层就命中 1M，
 * 根本走不到这里。所以它的实际受益面只剩：三层数据全 miss 的模型、以及完全离线
 * 且快照过期的场景。保留它是为了「猜也要猜得有约束」，不是为了修 glm-5.3。
 *
 * 变体后缀（`glm-5.3-air`）能借，是因为前缀家族判定天然把后缀归进同一族。
 */
function lookupVersionAware(model: string): ModelRegistryEntry | null {
  const target = parseFamilyVersion(model);
  if (!target) return null;

  let best: { entry: ModelRegistryEntry; major: number; minor: number } | null = null;
  for (const [key, entry] of Object.entries(REGISTRY)) {
    const cand = parseFamilyVersion(key);
    if (!cand) continue;
    if (cand.family !== target.family) continue;
    if (cand.vprefix !== target.vprefix) continue; // 约束 3：同一条版本序列（k3 与 3 不是）
    if (cand.major !== target.major) continue; // 约束 1：跨主版本禁借
    // 约束 2：只向下借。同主版本内按 minor 比较，等于也可以（那是变体后缀借基础名的情形）。
    if (cand.minor > target.minor) continue;
    if (!best || cand.minor > best.minor) best = { entry, major: cand.major, minor: cand.minor };
  }
  if (!best) return null;

  // ⚠ 只投影窗口 / 输出上限，**不带 protocolKind / pricing / 任何协议能力声明**。
  //
  // 这不是疏忽可以省的字段，是这一层"猜"与前缀/家族匹配那两层"知道"之间的边界。
  // `classifyProtocolFamily`（dialect/classify.ts）的设计前提是「注册表声明 = 精确」，
  // 未注册的 gpt-5.x 系模型**必须**落 unknown、交给 shouldUseResponsesAPI 按协议事实裁决——
  // 若这里把借来的 `gpt-5.6` 整条 entry（含 protocolKind: "openai-responses"）返回，
  // `gpt-5.9-unreleased` 会被误判成走 Responses API，那是「按模型名硬编码分档」的老路
  // 复发，且复发在一个连测试都锁着"不能这样"的地方。
  // 窗口 / 输出上限则是模型固有的数值容量，借用的风险已经被上面三条版本约束兜住。
  return { contextWindow: best.entry.contextWindow, maxOutputTokens: best.entry.maxOutputTokens };
}

/**
 * 从模型名里切出「家族前缀 + 版本字母前缀 + 主版本 + 次版本」。
 *
 * 形态：
 *   `glm-5.3`     → `{family:"glm", vprefix:"", major:5, minor:3}`
 *   `glm-5`       → minor 0
 *   `glm-5.3-air` → 同 `glm-5.3`（变体后缀不参与版本比较，家族仍是 glm）
 *   `kimi-k3`     → `{family:"kimi", vprefix:"k", major:3, minor:0}`
 *
 * `vprefix` 存在的理由：`kimi-k3` 的版本号带一个字母前缀，不认它就等于这一族根本不参与
 * 版本借用 —— 那么「`kimi-k3` 不得借 `kimi-k2.6`」这条判据就是靠"没解析出来"侥幸成立的，
 * 而不是靠跨主版本约束。认了它才是真的在执行那条约束（k3 vs k2 主版本不同 → 拒借）。
 * 比较时 `vprefix` 必须相等：`text-embedding-3-large`（无前缀）与 `text-embedding-v4`
 * （前缀 v）不是同一条版本序列。
 *
 * ── 两类刻意不认的形态（认了就会产生新的跨档误配）─────────────────
 *
 * 1. **版本段后面又跟数字段**：`claude-sonnet-4-6`、`claude-sonnet-4-20250514`。
 *    这类多段/日期版本一律返回 null，交给既有的家族匹配层处理。
 *    实测反例：若把 `claude-sonnet-4-20260101` 认成「major 4 / minor 0」，它会借到
 *    `claude-sonnet-4-6` 的 1M，而正确答案是家族匹配到 `claude-sonnet-4-20250514` 的 200K
 *    （既有回归测试锁着这一条）。
 * 2. **`gpt-4o` / `o3-mini` 这种数字后面直接跟字母的**：版本与后缀无法切开，返回 null。
 */
function parseFamilyVersion(
  model: string,
): { family: string; vprefix: string; major: number; minor: number } | null {
  // 家族段：字母开头的连字符分段；版本段：可选单字母前缀 + 数字[.数字]；
  // 尾部：要么结束，要么是 `-` 接一个**非数字**开头的变体后缀。
  const m =
    /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-([a-z]?)(\d{1,3})(?:\.(\d{1,3}))?(-(?!\d).*)?$/.exec(
      model.toLowerCase(),
    );
  if (!m) return null;
  const major = Number(m[3]);
  const minor = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { family: m[1]!, vprefix: m[2] ?? "", major, minor };
}

/**
 * `model` 是否是 `key` 的**变体后缀形态**（`deepseek-v4-flash-maxthink` vs `deepseek-v4-flash`）。
 *
 * ⚠ 这是给最长前缀匹配加的边界约束，不是可有可无的收紧。裸 `startsWith` 会让
 * `glm-5.3` 命中 `glm-5`（余部 `.3`）—— 一个**更高版本**被当成"某个已知模型的变体"，
 * 直接套上 200K，而它真实是 1M。这正是本次要修的 5 倍低估形态，也是版本感知借用
 * （lookupVersionAware）拿不到执行机会的原因：前缀层先返回了。
 *
 * 要求余部为空或以 `-` 开头，即只承认「同一模型名 + 连字符变体后缀」。
 * `.` / 直接接数字这类"看起来像同一个前缀"的形态一律不算。
 */
function isVariantSuffixOf(model: string, key: string): boolean {
  if (!model.startsWith(key)) return false;
  const rest = model.slice(key.length);
  return rest.length === 0 || rest.startsWith("-");
}

/** 获取完整注册表（只读用途，如 /model discover 展示） */
export function getRegistryEntries(): ReadonlyArray<[string, ModelRegistryEntry]> {
  return Object.entries(REGISTRY);
}
