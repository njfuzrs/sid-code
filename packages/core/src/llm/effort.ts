/**
 * 统一 Effort 标度 + 能力感知映射层
 *
 * 这是「一个旋钮，处处生效」的工程地基：用户面对的永远是 4 档 + auto（与底层模型无关），
 * 由本模块的「能力描述符」把统一档位翻译成各 provider / 协议的线格式。
 *
 * 设计要点（对标 claude-code src/utils/effort.ts，并扩展多协议矩阵）：
 * - 统一内部标度 low/medium/high/max + undefined(=auto，跟随模型默认、不显式下发)。
 * - 每个模型/协议一份 {@link EffortCapability}，其 {@link EffortCapability.applyToSendParams}
 *   是「档位 → 线格式」的**唯一翻译处**——上层（命令、状态栏、loop）只认统一档位，永不碰协议细节。
 * - 新增 provider 零侵入：只加一条 capability 分支，不动上层。
 *
 * 协议映射矩阵（详见方案 §2.3）：
 *   1. DeepSeek（OpenAI 兼容，主力）：thinking→请求体 thinking.type；effort→reasoning_effort（仅 high/max）。
 *   2. DeepSeek（Anthropic 兼容端点）：thinking 开关有效但 budget 被服务端忽略；effort 需 output_config.effort。
 *   3. Anthropic 原生 Claude：thinking + effort→budget_tokens（low=2K/medium=10K/high=20K/max=50K）。
 *   4. OpenAI o-series：无显式开关（内置推理）；effort→reasoning_effort（low/medium/high，无 max）。
 *   5. Ollama / 未知兼容端点：兜底，全部 no-op（不下发任何字段，避免 400）。
 */

import type { SendParams } from "./types.ts";
import { lookupCatalog } from "./model-params-catalog.ts";
import { lookupCapability } from "./model-capabilities.ts";
import { lookupModelCompat, type ModelCompat } from "./model-compat.ts";

// ─────────────────────────────────────────────────────────────
// 1. 统一内部标度（与协议无关）
// ─────────────────────────────────────────────────────────────

/** 统一推理强度档位（用户面对的永远是这 5 档 + auto，对齐 claude-code low/medium/high/xhigh/max） */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** undefined = auto（跟随模型默认，不显式下发 effort 参数） */
export type EffortSetting = EffortLevel | undefined;

/**
 * 线格式档位（各 provider 的 reasoning_effort / output_config.effort 实际认可的值）。
 *
 * ⚠ 历史注释曾断言「没有任何 provider 的线格式认 xhigh」——GPT-5.6 族起该断言不再成立：
 * `reasoning.effort` 原生接受 none/low/medium/high/xhigh/max（`minimal` 反而被拒）。
 * 故 xhigh 进入本类型，由各 applier 自行决定钳制或原样透传。
 * [实测: 自建网关 /v1/responses，luna xhigh→reasoning_tokens=9、max→18；
 *  官方: developers.openai.com/api/docs/models/gpt-5.6-sol]
 */
type WireEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 不含 xhigh 的线格式子集（绝大多数 provider 的实际可用值域）。
 * 两个 clamp 函数的返回类型收窄到此，避免把 xhigh 漏给不认它的 provider
 * （SendParams.reasoningEffort 亦不含 xhigh，类型层直接挡住）。
 */
type WireEffortNoXhigh = Exclude<WireEffort, "xhigh">;

/**
 * 把统一档位钳到「支持 max 但不支持 xhigh 的线格式」（DeepSeek/GLM/Anthropic-adaptive 用）：
 * xhigh → max（视为最高档），其余原样。
 */
function clampToMaxWire(effort: EffortLevel): WireEffortNoXhigh {
  return effort === "xhigh" ? "max" : effort;
}

/**
 * 把统一档位钳到「无 max 的线格式」（o-series/Grok 用）：
 * max 与 xhigh 均 → high，其余原样。
 */
function clampToHighWire(effort: EffortLevel): WireEffortNoXhigh {
  return effort === "max" || effort === "xhigh" ? "high" : effort;
}

/** 思考开关三态。undefined = auto（跟随模型/provider 默认） */
export type ThinkingSetting = "on" | "off" | undefined;

/** 判断字符串是否为合法档位 */
export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * Anthropic 原生 Claude 的「档位 → thinking budget_tokens」映射。
 * 复用 thinking.ts 的预算思路（simple 2K / medium 10K / complex 50K），补 high=20K 这一档，
 * 使 4 档与 budget 一一对应。
 */
const ANTHROPIC_EFFORT_BUDGET: Record<EffortLevel, number> = {
  low: 2_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 50_000,
};

// ─────────────────────────────────────────────────────────────
// 2. 能力描述符
// ─────────────────────────────────────────────────────────────

export interface EffortCapability {
  /** 支持档位切换；false → 状态栏不显示 effort 列 */
  supportsEffort: boolean;
  /** 支持 max；false 时选 max 自动降 high（在 resolveAppliedEffort 钳制） */
  supportsMaxEffort: boolean;
  /** 支持显式思考开关；false → 不显示 thinking 列 */
  supportsThinkingToggle: boolean;
  /** thinking 默认是否开（影响 auto 态展示与下发） */
  thinkingDefaultOn: boolean;
  /** auto 态下状态栏展示用的默认档位（对标 cc getDisplayedEffortLevel 的兜底） */
  defaultEffort: EffortLevel;
  /**
   * 把统一档位翻译成该模型的线格式，原地 patch 进 SendParams。
   * 这是协议差异的唯一收口点——上层永远不碰协议细节。
   *
   * @param params   目标 SendParams（原地修改）
   * @param effort   解析后的最终档位；undefined = auto（不显式下发 effort）
   * @param thinking 解析后的最终开关（已是明确 boolean，无 auto）
   */
  applyToSendParams(params: SendParams, effort: EffortSetting, thinking: boolean): void;
}

/** 协议种类（resolveEffortCapability 内部判定结果） */
type CapabilityKind =
  | "deepseek-openai"
  | "deepseek-anthropic"
  | "anthropic-native"
  | "o-series"
  | "glm-openai"
  | "grok-openai"
  | "openai-responses"
  | "unknown";

// ─────────────────────────────────────────────────────────────
// 3. 各协议的 applyToSendParams 实现矩阵
// ─────────────────────────────────────────────────────────────

/**
 * 规则 1：DeepSeek（OpenAI 兼容端点，主力路径）。
 * - thinking → params.thinking（openai.ts applyDeepSeekThinking 转请求体 thinking.type）。
 * - effort   → params.reasoningEffort，DeepSeek 仅 high/max：low/medium→high，max→max。
 */
function applyDeepSeekOpenAI(params: SendParams, effort: EffortSetting, thinking: boolean): void {
  // budgetTokens 在 DeepSeek OpenAI 端点无对应字段，置 0；强度走 reasoningEffort。
  params.thinking = { enabled: thinking, budgetTokens: 0 };
  // 思考关闭时不下发 effort（与 openai.ts 的 thinkingDisabled 规避一致，避冲突）。
  // DeepSeek 仅认 high/max：xhigh 与 max 同视为 max，low/medium 视为 high。
  if (thinking && effort !== undefined) {
    params.reasoningEffort = clampToMaxWire(effort) === "max" ? "max" : "high";
  }
}

/**
 * 规则 2：DeepSeek（Anthropic 兼容端点）。
 * - thinking 开关有效（budget 被服务端忽略，仍按 anthropic.ts 既有形态下发 enabled）。
 * - effort   走 output_config.effort（由 anthropic.ts S7 补丁消费）：low/medium→high，max→max。
 */
function applyDeepSeekAnthropic(
  params: SendParams,
  effort: EffortSetting,
  thinking: boolean,
): void {
  params.thinking = { enabled: thinking, budgetTokens: 0 };
  if (thinking && effort !== undefined) {
    params.outputConfig = { effort: clampToMaxWire(effort) === "max" ? "max" : "high" };
  }
}

/**
 * 规则 3：Anthropic 原生 Claude。
 *
 * 根据 thinkingMode 分两条路径：
 * - adaptive（Opus 4.7+/Sonnet 4.6/Fable 5）→ `thinking:{type:"adaptive"}` + `output_config.effort`
 * - always-on（Fable 5/Mythos 5）→ 同 adaptive 但不允许关闭思考
 * - manual（旧模型，thinkingMode 为 undefined）→ `thinking:{type:"enabled", budget_tokens:N}`
 *
 * [来源: anthropic-api.md:316-323,325-332]
 */
function applyAnthropicNative(params: SendParams, effort: EffortSetting, thinking: boolean): void {
  const catalogEntry = lookupCatalog(params.model || "");
  const thinkingMode = catalogEntry?.thinkingMode;

  // §12 P2-1：思考 token 上限（env / settings）。null 表示未设。
  const maxThinking = getMaxThinkingTokensOverride(params.maxThinkingTokens);

  if (thinkingMode === "always-on" || thinkingMode === "adaptive") {
    // ── adaptive / always-on 路径 ──
    // always-on 模型不可关闭思考（关也按低 effort 下发），avoid 400
    const effectiveThinking = thinkingMode === "always-on" ? true : thinking;

    if (!effectiveThinking) {
      // adaptive 模型显式关闭思考：不下发 thinking 参数（省略 = 不思考）
      params.thinking = { enabled: false, budgetTokens: 0 };
      return;
    }

    // auto（effort=undefined）→ 走模型默认（Opus 4.8 默认 high）
    let effectiveEffort: EffortLevel = effort ?? "high";
    // §12 P2-1：adaptive 模型 budget 由服务端定，客户端无法硬钳——改为按上限把 effort 降档间接压低。
    // 仅当降档结果比用户档位更低时才生效（不上调），并在 outputConfig 打标记供 UI/日志诚实告知。
    if (maxThinking !== null) {
      const capped = mapThinkingCapToEffort(maxThinking);
      if (
        capped !== null &&
        ANTHROPIC_EFFORT_BUDGET[capped] < ANTHROPIC_EFFORT_BUDGET[effectiveEffort]
      ) {
        effectiveEffort = capped;
        params.thinkingBudgetCapped = {
          requestedMax: maxThinking,
          mappedEffort: capped,
          mode: "adaptive",
        };
      }
    }
    // Anthropic adaptive 线格式官方档位为 low/medium/high/max，不含 xhigh：
    // xhigh 钳到 max，避免未知档位触发 400。
    const level: WireEffort = clampToMaxWire(effectiveEffort);
    // 标记为 adaptive 模式：anthropic.ts 据此下发 {type:"adaptive"} 而非 {type:"enabled"}
    params.thinking = { enabled: true, budgetTokens: 0 };
    params.outputConfig = { effort: level, thinkingType: "adaptive" };
  } else {
    // ── manual 路径（旧模型：Opus 4-20250514/Sonnet 4.5/Haiku 4.5 等）──
    if (!thinking) {
      params.thinking = { enabled: false, budgetTokens: 0 };
      return;
    }
    // auto（effort=undefined）兜底用 medium 预算，保证开思考时有合理预算。
    const level: EffortLevel = effort ?? "medium";
    let budget = ANTHROPIC_EFFORT_BUDGET[level];
    // §12 P2-1：manual 模型 budget 由客户端下发，可精确钳制：Math.min(档位budget, 上限)。
    if (maxThinking !== null && maxThinking < budget) {
      budget = maxThinking;
      params.thinkingBudgetCapped = {
        requestedMax: maxThinking,
        appliedBudget: budget,
        mode: "manual",
      };
    }
    params.thinking = { enabled: true, budgetTokens: budget };
  }
}

/**
 * 规则 4：OpenAI o-series。
 * - 无显式思考开关（内置推理），thinking no-op。
 * - effort → reasoning_effort（low/medium/high，无 max：max→high）。由 openai.ts 对 o-series 透传。
 */
function applyOSeries(params: SendParams, effort: EffortSetting, _thinking: boolean): void {
  if (effort !== undefined) {
    // o-series 仅 low/medium/high，无 max：max 与 xhigh 均钳到 high。
    params.reasoningEffort = clampToHighWire(effort);
  }
}

/** 规则 5：兜底——不下发任何字段，避免未知端点 400。 */
function applyNoop(_params: SendParams, _effort: EffortSetting, _thinking: boolean): void {
  /* no-op */
}

/**
 * 规则 6：智谱 GLM（OpenAI 兼容端点）。
 * - thinking → params.thinking（openai.ts 转请求体顶层 `thinking:{type:enabled/disabled}`，GLM-4.5+）。
 * - effort   → params.reasoningEffort（仅 GLM-5.2 生效；GLM 内部钳制：low/medium→high，max→max）。
 *   GLM 支持 max，故 supportsMaxEffort=true，直接透传统一档位由 GLM 服务端按上表收敛。
 *   [来源: glm-api.md:144-147,189-201]
 */
function applyGLMOpenAI(params: SendParams, effort: EffortSetting, thinking: boolean): void {
  params.thinking = { enabled: thinking, budgetTokens: 0 };
  // 思考关闭时不下发 effort（与 DeepSeek 一致，避免与 disabled 冲突）。
  // GLM 线格式仅认 low/medium/high/max，不认 xhigh：xhigh 钳到 max（GLM 支持的最高档）。
  if (thinking && effort !== undefined) {
    params.reasoningEffort = clampToMaxWire(effort);
  }
}

/**
 * 规则 7：xAI Grok（OpenAI 兼容端点，推理模型 grok-4.3 / grok-4.20 / grok-build）。
 * - 无显式思考开关（配置化推理，内置），thinking no-op。
 * - effort → reasoning_effort（none/low/medium/high，**无 max**：max→high）。
 *   openai.ts 需对 grok 透传 reasoning_effort。[来源: grok-api.md:30,157,277,487]
 */
function applyGrokOpenAI(params: SendParams, effort: EffortSetting, _thinking: boolean): void {
  if (effort !== undefined) {
    // Grok 无 max：max 与 xhigh 均钳到 high。
    params.reasoningEffort = clampToHighWire(effort);
  }
}

/**
 * 规则 8：OpenAI Responses API 族（GPT-5.x，走 POST /v1/responses 的 `reasoning.effort`）。
 *
 * - 无显式思考开关（推理内置、不可关），thinking no-op —— 故不下发 params.thinking。
 * - effort → reasoning_effort，**5 档原样透传不钳制**：该族是目前唯一原生认 xhigh 的协议族。
 *   由 openai-responses-request.ts 的 buildResponsesRequest 转成嵌套 `reasoning:{effort}`。
 *
 * 此前本族错绑 applyNoop（连同 CAPABILITY_FLAGS.supportsEffort=false），导致 /effort 对所有
 * GPT-5.x 硬报「不支持推理强度档位切换」——但服务端实际会校验该字段（传非法值返回 400
 * `param: reasoning.effort`），证明能力真实存在，是我们没接线。
 *
 * [实测: 自建网关 /v1/responses — low/medium/high→reasoning_tokens=0、xhigh→9、max→18、
 *  minimal→400「not supported with this model」；不传时服务端回显默认 effort=medium]
 * [官方: developers.openai.com/api/docs/models/gpt-5.6-sol、/guides/reasoning]
 */
function applyOpenAIResponses(params: SendParams, effort: EffortSetting, _thinking: boolean): void {
  if (effort !== undefined) {
    params.reasoningEffort = effort;
  }
}

const APPLIERS: Record<CapabilityKind, EffortCapability["applyToSendParams"]> = {
  "deepseek-openai": applyDeepSeekOpenAI,
  "deepseek-anthropic": applyDeepSeekAnthropic,
  "anthropic-native": applyAnthropicNative,
  "o-series": applyOSeries,
  "glm-openai": applyGLMOpenAI,
  "grok-openai": applyGrokOpenAI,
  "openai-responses": applyOpenAIResponses,
  unknown: applyNoop,
};

/** 各协议的能力位（除 applyToSendParams 外的描述字段） */
const CAPABILITY_FLAGS: Record<CapabilityKind, Omit<EffortCapability, "applyToSendParams">> = {
  "deepseek-openai": {
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: true,
    thinkingDefaultOn: true,
    defaultEffort: "high",
  },
  "deepseek-anthropic": {
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: true,
    thinkingDefaultOn: true,
    defaultEffort: "high",
  },
  "anthropic-native": {
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: true,
    thinkingDefaultOn: false,
    defaultEffort: "high",
  },
  "o-series": {
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsThinkingToggle: false,
    thinkingDefaultOn: true,
    defaultEffort: "medium",
  },
  "glm-openai": {
    // GLM-4.5+ 有显式思考开关，GLM-5.2 支持 reasoning_effort（含 max）。
    // 注：effort 仅 GLM-5.2 生效，其余 GLM 无 reasoning_effort 粒度——但下发对它们无害
    // （非 5.2 会忽略该字段），故统一声明 supportsEffort=true。[来源: glm-api.md:144-147,189]
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: true,
    thinkingDefaultOn: true,
    defaultEffort: "high",
  },
  "grok-openai": {
    // Grok 推理模型配置化推理，无显式思考开关；reasoning_effort 无 max（max→high）。
    // grok-4.3 默认 low。[来源: grok-api.md:30,277]
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsThinkingToggle: false,
    thinkingDefaultOn: true,
    defaultEffort: "low",
  },
  "openai-responses": {
    // GPT-5.x Responses API：`reasoning.effort` 原生支持 5 档（含 xhigh，无需钳制）。
    // 无显式思考开关（推理内置、不可关）→ supportsThinkingToggle=false，但这**不影响**
    // effort 下发（applyOpenAIResponses 不受 thinking 门控，与 Grok 同构）。
    // defaultEffort=medium 取自服务端实测回显（不传 reasoning 时 echo effort=medium）。
    //
    // ⚠ 此前这里是 supportsEffort:false + APPLIERS 绑 applyNoop，注释写「当前不支持」——
    // 实为未接线而非真不支持：服务端对非法值返回 400 `param: reasoning.effort`，
    // 证明字段被校验、能力存在。修复见 applyOpenAIResponses 的实测记录。
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: false,
    thinkingDefaultOn: false,
    defaultEffort: "medium",
  },
  unknown: {
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsThinkingToggle: false,
    thinkingDefaultOn: false,
    defaultEffort: "high",
  },
};

// ─────────────────────────────────────────────────────────────
// 4. 能力解析入口
// ─────────────────────────────────────────────────────────────

/**
 * 判定模型/协议属于哪一类。
 *
 * 查询优先级（方案 §5.4）：
 *   1. catalog 中声明的 protocolKind（精确，可预测）
 *   2. 现有 runtime 推断（兜底，处理未注册模型和 DeepSeek baseURL 判断）
 */
function classifyCapability(opts: {
  model: string;
  provider: string;
  baseURL?: string;
}): CapabilityKind {
  const { model, provider, baseURL } = opts;

  // 优先级 1：查 catalog 中声明的 protocolKind
  const catalogEntry = lookupCatalog(model);
  if (catalogEntry?.protocolKind) {
    return catalogEntry.protocolKind;
  }

  // 优先级 2：runtime 推断兜底（处理未注册模型和 DeepSeek baseURL 判断）
  const isDeepSeek = /deepseek/i.test(model);
  const isAnthropicEndpoint = !!baseURL && /\/anthropic/i.test(baseURL);

  if (isDeepSeek) {
    return isAnthropicEndpoint ? "deepseek-anthropic" : "deepseek-openai";
  }
  // 原生 Claude：provider 为 anthropic 且非 deepseek。
  if (provider === "anthropic" || /^claude/i.test(model)) {
    return "anthropic-native";
  }
  // OpenAI o-series（o1 / o3 / o4 …）。
  if (/^o[0-9]/i.test(model)) {
    return "o-series";
  }
  // 智谱 GLM（OpenAI 兼容端点）。
  if (/^glm/i.test(model)) {
    return "glm-openai";
  }
  // xAI Grok（OpenAI 兼容端点）。
  if (/grok/i.test(model)) {
    return "grok-openai";
  }
  // Responses API 协议族：判据是「该端点/模型是否走 /v1/responses」这一**协议事实**，
  // 由 openai.ts shouldUseResponsesAPI 统一裁决，不在这里复制模型名正则。
  //
  // ⚠ 曾经这里写过 `/^gpt-5\./i` 兜底——那正是「出一个新模型改一次代码」的老路，
  // 且违反 `feedback-no-hardcoded-model-tier-rules`（不按模型名硬编码分档）。
  // 现已删除：未注册模型的 effort 能力改由 model-capabilities.ts 的动态采集
  //（外部目录 + 服务端自报探针 + 400 自愈）数据驱动，见 resolveEffortCapability 优先级 2.5。
  return "unknown";
}

/**
 * 解析当前模型的 effort 能力描述符。
 *
 * 判定优先级：
 *   1. 用户显式声明 modelConfig.supportsThinking === false → 强制 unknown（全不支持，避贸然 400）。
 *   2. 内置协议族匹配（deepseek 双端点 / anthropic 原生 / o-series / GLM / Grok）。
 *   2.5 **动态能力缓存**（model-capabilities.ts）——协议族判为 unknown 时的数据驱动兜底：
 *       外部目录同步 + 服务端自报探针 + 400 自愈采到的 effort 档位。这是「用户只配
 *       name/endpoint/apiKey 就能用」的关键一环，替代了此前按模型名硬编码的 /^gpt-5\./i。
 *   3. 兜底 unknown（不下发 effort）。
 */
export function resolveEffortCapability(opts: {
  model: string;
  provider: string;
  baseURL?: string;
  modelConfig?: { supportsThinking?: boolean };
  /**
   * 本地别名（`config.model` / fallback 名），用于查 compat 声明。
   *
   * ⚠ 与 `opts.model` 是**两个不同的东西**，别合并：`opts.model` 必须是**真名**
   * （内部按前缀/家族匹配，喂别名会静默 miss），而 compat 按**渠道**（别名）建键
   * ——同一真名的两个渠道声明可以不同。缺省时退化为按 `opts.model` 查（两者相等
   * 是没配 modelId 的绝大多数情况）。
   */
  alias?: string;
}): EffortCapability {
  // 优先级 0：用户显式的 compat 声明——权威度高于下面一切按名推导的判定。
  // 它只**覆盖它声明了的那几位**，没声明的位继续走原有判定（undefined ≠ false）。
  const compat = lookupModelCompat(opts.alias ?? opts.model);

  // 优先级 1：用户显式声明不支持思考 → 全 no-op（不下发任何字段）。
  if (opts.modelConfig?.supportsThinking === false) {
    return applyCompatOverrides(
      { ...CAPABILITY_FLAGS.unknown, applyToSendParams: APPLIERS.unknown },
      compat,
    );
  }

  const kind = classifyCapability(opts);
  if (kind !== "unknown") {
    return applyCompatOverrides(
      { ...CAPABILITY_FLAGS[kind], applyToSendParams: APPLIERS[kind] },
      compat,
    );
  }

  // 优先级 2.5：协议族未知 → 查动态能力缓存（纯内存读，不触网）。
  return applyCompatOverrides(resolveFromCapabilityCache(opts.model), compat);
}

/**
 * 把用户的 compat 声明叠加到已解析的能力描述符上。
 *
 * 设计要点（三条，都踩过对应的坑形态）：
 *
 * 1. **只覆盖声明了的位**。`undefined` 一律不动原值——`compat` 是「补充/纠正个别位」，
 *    不是「整体替换能力描述符」。若按整体替换，用户为了纠正一个位就得把 6 位全配对，
 *    配漏的位会被当成 false，反而制造新的静默失真。
 *
 * 2. **`supportsReasoningEffort: false` 必须真的让 `applyToSendParams` 不写字段**，
 *    而不只是把 `supportsEffort` 标志位改掉。标志位只影响状态栏展示与档位选择，
 *    真正决定「线上发不发」的是 applier —— 只改标志位是本仓「仪器/开关改了但链路没改」
 *    的经典形态：UI 显示不支持，请求体照发，两边说法不一致。
 *
 * 3. **包装 applier 而不是替换**。各族 applier 里有大量族专属结构转换
 *    （DeepSeek 的 `thinking:{}`、Anthropic 的 `budget_tokens`），compat 是布尔位层，
 *    表达不了这些 —— 那是 dialect 模块的职责。故这里先跑原 applier，再按声明**剥字段**。
 */
function applyCompatOverrides(cap: EffortCapability, compat?: ModelCompat): EffortCapability {
  if (!compat) return cap;

  const out: EffortCapability = { ...cap };

  if (compat.supportsReasoningEffort !== undefined) {
    out.supportsEffort = compat.supportsReasoningEffort;
  }
  if (compat.supportsThinkingToggle !== undefined) {
    out.supportsThinkingToggle = compat.supportsThinkingToggle;
    // 声明为不支持开关时，thinkingDefaultOn 也不能再是 true —— 否则状态栏显示「思考默认开」
    // 却没有任何开关字段下发，是同一句话的两个矛盾说法。
    if (!compat.supportsThinkingToggle) out.thinkingDefaultOn = false;
  }
  if (compat.supportsMaxEffort !== undefined) {
    out.supportsMaxEffort = compat.supportsMaxEffort;
  }

  const inner = cap.applyToSendParams.bind(cap);
  out.applyToSendParams = (params, effort, thinking) => {
    // max 钳制：声明不支持 max 时，把档位降到 high 再交给原 applier。
    // 在**进入** applier 前钳，而不是事后改 params —— 各族 applier 对 max 有各自的分支
    // （DeepSeek 的 max→"max"、Grok/o-series 的守卫），事后改改不干净。
    let effective = effort;
    if (compat.supportsMaxEffort === false && (effort === "max" || effort === "xhigh")) {
      effective = "high";
    }

    inner(params, effective, thinking);

    // 声明为不支持 → 事后剥掉。剥而不是不调 applier：applier 同时负责 thinking 等
    // 其它字段，整个跳过会把不相关的能力一起关掉。
    if (compat.supportsReasoningEffort === false) {
      params.reasoningEffort = undefined;
      // Anthropic 族的 effort 走 outputConfig.effort（见 applyDeepSeekAnthropic），
      // 只剥 reasoningEffort 会漏掉这条线 —— 那正是「同一语义两条线只堵一条」的漏法。
      //
      // ⚠ 但只在 outputConfig **只承载 effort** 时整个置空。带了 thinkingType 时
      // （anthropic-native 的 adaptive 模型）刻意不动：`effort` 在该类型里是必填，
      // 「保留 thinkingType 但去掉 effort」根本表达不出来，而丢掉整个对象会让
      // buildThinkingParam（anthropic.ts:889）从 adaptive 静默退回 manual budget_tokens
      // —— 用一个协议降级去实现另一个字段的关闭，代价远超收益。
      //
      // 这是 compat 布尔位层的**已知表达边界**，不是漏改：adaptive 模型按定义就吃 effort，
      // 对它声明 supportsReasoningEffort:false 本身是矛盾配置。真要支持这种组合，
      // 需要 dialect 层做结构转换（下一步），布尔位表达不了。
      if (params.outputConfig && params.outputConfig.thinkingType === undefined) {
        params.outputConfig = undefined;
      }
    }
    if (compat.supportsThinkingToggle === false) {
      params.thinking = undefined;
    }
  };

  return out;
}

/**
 * 未知协议族的能力兜底 —— 由 model-capabilities.ts 的采集数据驱动，零模型名判据。
 *
 * 三种情形：
 * - 缓存有非空 `effortValues` → 支持 effort。`supportsMaxEffort` 依据档位表里有没有 max；
 *   `defaultEffort` 取档位表的中位偏低档（服务端普遍以 medium 为默认，实测 GPT-5.6 回显 medium）。
 * - 缓存有**空** `effortValues`（探针 200 证实服务端不校验该字段）→ 明确不支持，同 unknown。
 * - 缓存无记录 → 乐观放行（supportsEffort=true）。这是「永不报错」的核心取舍：
 *   宁可发出去被 400 后自愈（learnFromError 会剥字段重试并记住），也不要在 /effort 上
 *   硬报「不支持」把用户挡死。首次可能多一次重试，之后就准了。
 */
function resolveFromCapabilityCache(model: string): EffortCapability {
  const cap = lookupCapability(model);

  // 明确不支持（探针已证实服务端不校验 reasoning_effort）。
  if (cap?.effortValues && cap.effortValues.length === 0) {
    return { ...CAPABILITY_FLAGS.unknown, applyToSendParams: APPLIERS.unknown };
  }

  const values = cap?.effortValues;
  const supportsMax = values ? values.includes("max") : true;
  // 已知档位表里挑默认档：优先 medium（服务端最常见默认），否则退到 high，再否则第一档。
  const defaultEffort: EffortLevel = values
    ? values.includes("medium")
      ? "medium"
      : values.includes("high")
        ? "high"
        : ((values.find((v: string) => isEffortLevel(v)) as EffortLevel | undefined) ?? "medium")
    : "medium";

  return {
    supportsEffort: true,
    supportsMaxEffort: supportsMax,
    // 未知模型不猜「思考开关」——它比 effort 更容易 400（DeepSeek/GLM 的 thinking 结构各异）。
    supportsThinkingToggle: false,
    thinkingDefaultOn: false,
    defaultEffort,
    applyToSendParams: (params, effort) => {
      if (effort === undefined) return;
      // 有档位表就按表钳（表外档位降到表内最接近的低档），无表则原样发，让服务端裁决 + 自愈兜底。
      params.reasoningEffort = values ? clampToKnownValues(effort, values) : clampToMaxWire(effort);
    },
  };
}

/**
 * 把统一档位钳到「服务端自报的档位表」之内。
 *
 * 策略：先试原档；不在表内则沿标度**向下**找最近的可用档（宁可弱一点也不要 400）；
 * 全表都比它低则取表内最高档。`none`/`minimal` 不作为降级目标——它们语义是「几乎不推理」，
 * 用户要 high 却降到 none 属于静默失真，宁可取表内最高的正常档。
 */
function clampToKnownValues(effort: EffortLevel, values: string[]): SendParams["reasoningEffort"] {
  const SCALE: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
  const usable = SCALE.filter((v) => values.includes(v));
  if (usable.length === 0) return undefined; // 表里只有 none/minimal → 不下发，交给服务端默认
  if (usable.includes(effort)) return effort;
  const idx = SCALE.indexOf(effort);
  for (let i = idx - 1; i >= 0; i--) {
    if (usable.includes(SCALE[i])) return SCALE[i];
  }
  return usable[usable.length - 1];
}

// ─────────────────────────────────────────────────────────────
// 5. 状态解析纯函数（可单测，对标 cc resolveAppliedEffort / getDisplayedEffortLevel）
// ─────────────────────────────────────────────────────────────

/**
 * 实际下发给 API 的档位（含 max→high 钳制；优先级 env > runtime > auto）。
 * @param envOverride getEffortEnvOverride() 的返回值：null=env 未设；undefined=env 强制 auto；level=env 强制档位。
 */
export function resolveAppliedEffort(
  cap: EffortCapability,
  runtimeEffort: EffortSetting,
  envOverride: EffortSetting | null,
): EffortSetting {
  // env 已设（含强制 auto=undefined）则覆盖 runtime；未设（null）才用 runtime。
  let effort: EffortSetting = envOverride !== null ? envOverride : runtimeEffort;
  // max→high 钳制：模型不支持 max 时降级。
  if (effort === "max" && !cap.supportsMaxEffort) {
    effort = "high";
  }
  return effort;
}

/**
 * 状态栏展示档位（auto 解析为具体档位，对标 cc getDisplayedEffortLevel）。
 * auto 态返回模型默认档（cap.defaultEffort）；含 max→high 钳制。
 */
export function getDisplayedEffort(
  cap: EffortCapability,
  runtimeEffort: EffortSetting,
  envOverride: EffortSetting | null,
): EffortLevel {
  const applied = resolveAppliedEffort(cap, runtimeEffort, envOverride);
  return applied ?? cap.defaultEffort;
}

/**
 * 当前 effort 是否为 auto 态（未显式设档位）。用于状态栏区分「auto」与具体档位展示。
 */
export function isEffortAuto(
  runtimeEffort: EffortSetting,
  envOverride: EffortSetting | null,
): boolean {
  const effective = envOverride !== null ? envOverride : runtimeEffort;
  return effective === undefined;
}

/**
 * 预演某显式档位经能力层 applyToSendParams 映射后「实际下发」的线格式强度档。
 *
 * 用途：命令层对比「请求档 vs 实际下发档」，对被服务端钳制的档位诚实告知用户
 * （如 DeepSeek 仅 high/max → low/medium 实际按 high 下发；o-series 无 max → max 按 high）。
 *
 * 设计：用一次性探针 SendParams 跑真实映射，读出 reasoningEffort（OpenAI/o-series）或
 * outputConfig.effort（deepseek-anthropic），**不写死任何 provider**——映射规则变了这里自动跟随。
 * 走 budget_tokens 路径的原生 Claude 无 reasoningEffort 下发，其 4 档与预算一一对应、无钳制概念，
 * 故返回原档（不提示钳制）。
 *
 * @returns 实际下发的强度档；与入参 level 不同即表示发生了钳制。
 */
export function previewWireEffort(cap: EffortCapability, level: EffortLevel): EffortLevel {
  // 思考须开启才会下发 effort（与 applyToSendParams 内的 thinking 门控一致）。
  const probe: SendParams = { model: "", messages: [], maxTokens: 0 };
  cap.applyToSendParams(probe, level, true);
  const wire = probe.reasoningEffort ?? probe.outputConfig?.effort;
  if (wire !== undefined && isEffortLevel(wire)) return wire;
  // 无显式 effort 下发（如原生 Claude 走 budget_tokens，或 unknown no-op）→ 视为无钳制。
  return level;
}

/**
 * 该模型**真实可选**的档位集合（/effort 面板列表 + /model 面板左右键循环的唯一依据）。
 *
 * 为什么需要它：`EffortCapability` 此前只暴露 `supportsEffort` / `supportsMaxEffort` 两个布尔，
 * 表达不了「o-series 无 max 与 xhigh」「DeepSeek 只认 high/max」这类**档位子集**。
 * 于是 UI 只能拿全量 5 档硬编码列举，用户选了实际会被静默钳制的档（选 low 实发 high），
 * 面板显示的档位与真正下发的档位不一致——「档位应该跟模型配对」缺的就是这一层。
 *
 * 实现刻意**不新建映射表**：复用 {@link previewWireEffort} 对每档做一次真实映射预演，
 * 凡「映射后 ≠ 自己」的档位说明会被钳制到别的档，即对该模型不是独立可选档，剔除。
 * 这样能力矩阵（APPLIERS / 动态能力缓存）怎么变，这里自动跟随，不会漂移出第二份真相。
 *
 * 两个特例：
 * - 走 budget_tokens 的原生 Claude 无 `reasoningEffort` 下发，previewWireEffort 一律返回原档，
 *   故 5 档全保留——这是对的，它们确实各自对应不同 budget（2K/10K/20K/32K/50K）。
 * - `supportsEffort=false`（unknown / 用户声明不支持思考）→ 返回空数组，UI 据此禁用切换。
 *
 * @returns 按 low→max 升序的可选档位；空数组表示该模型不支持档位切换。
 */
export function getSelectableEfforts(cap: EffortCapability): EffortLevel[] {
  if (!cap.supportsEffort) return [];
  const usable = EFFORT_LEVELS.filter((lv) => {
    // max 单独由 supportsMaxEffort 把关（resolveAppliedEffort 会 max→high 钳制）
    if (lv === "max" && !cap.supportsMaxEffort) return false;
    return previewWireEffort(cap, lv) === lv;
  });
  // 兜底：若映射预演把所有档都判为被钳制（理论上不该发生，如 applier 恒定返回同一档），
  // 退回「至少给出默认档」，不要给 UI 一个空列表导致面板看起来像不支持。
  return usable.length > 0 ? usable : [cap.defaultEffort];
}

/**
 * 在该模型可选档位内循环切换（/model 面板 ←/→ 用）。
 *
 * 与「在全量 5 档里循环再钳制」的区别：钳制会把多个统一档折叠到同一线格式档，
 * 于是用户连按方向键时面板出现「按了没反应」的停顿（如 o-series 上 xhigh/max 都显示 high）。
 * 这里直接在**该模型真实可选**的档位数组里走，每一步都必然是可见的变化。
 *
 * @param cap     当前模型能力
 * @param current 当前生效档位（auto 态传入解析后的实际档位）
 * @param dir     1=增强（右），-1=减弱（左）
 * @returns 下一档；模型不支持切换时返回 undefined（调用方应忽略本次按键）
 */
export function cycleEffortForModel(
  cap: EffortCapability,
  current: EffortLevel | undefined,
  dir: 1 | -1,
): EffortLevel | undefined {
  const levels = getSelectableEfforts(cap);
  if (levels.length === 0) return undefined;
  // 当前档不在可选集内（如刚切模型、旧档位已失效）→ 从默认档所在位置起步，
  // 仍不在则落到首档，保证方向键永远有响应。
  let idx = current ? levels.indexOf(current) : -1;
  if (idx < 0) idx = levels.indexOf(cap.defaultEffort);
  if (idx < 0) return levels[dir === 1 ? 0 : levels.length - 1];
  return levels[(idx + dir + levels.length) % levels.length];
}

/**
 * 该模型的 effort 下发是否被 thinking 开关「门控」——即关掉思考后档位完全不下发。
 *
 * DeepSeek / GLM 的 applier 把 reasoning_effort 挂在 thinking 分支内（思考关了就不带该字段），
 * 而 o-series / GPT-5.x / Grok 的推理内置、不受 thinking 影响。这个差异对用户是**可见的**：
 * 在 GLM 上 `/think off` 之后，`/effort` 面板与 `/model` 面板的 ←/→ 仍在切档，但没有任何
 * 档位会真的发出去——面板在"空转"。判定方式同 previewWireEffort：跑一次真实映射对比有无
 * effort 字段，不写死任何 provider 名，applier 改了自动跟随。
 *
 * @returns true = 关掉思考后档位不下发（UI 应提示"当前思考已关，档位不生效"）
 */
export function isEffortGatedByThinking(cap: EffortCapability): boolean {
  if (!cap.supportsEffort) return false;
  const probe = (thinking: boolean): string | undefined => {
    const p: SendParams = { model: "", messages: [], maxTokens: 0 };
    cap.applyToSendParams(p, cap.defaultEffort, thinking);
    return p.reasoningEffort ?? p.outputConfig?.effort;
  };
  // 思考开时会下发、关时不下发 → 被门控。
  return probe(true) !== undefined && probe(false) === undefined;
}

/**
 * 换模型后把 runtime 档位「归正」到新模型真实可选的档位上。
 *
 * 为什么必须做：档位是**跨模型共享的运行时态**（`runtimeEffort`），而可选档位集合是
 * **每模型不同**的。在 claude（支持 xhigh）上调到 xhigh 再切到 GLM（xhigh 会被钳成 max），
 * runtimeEffort 仍是 xhigh：状态栏与 /model 面板显示 xhigh，实际下发 max，且面板 hint
 * 列出的可选档位里根本没有 xhigh —— 显示、提示、实发三者互相矛盾。
 *
 * 归正规则（诚实优先，不猜用户意图）：
 * - auto（undefined）不动：它本就是"跟随新模型默认"，换模型后语义天然正确。
 * - 档位已在新模型可选集内：不动（绝不因换模型悄悄改用户显式选过的档）。
 * - 否则映射到该档**实际会被下发**的那一档（previewWireEffort），使显示 == 实发；
 *   若映射结果仍不在可选集内（理论上不该发生），退到新模型默认档。
 *
 * @returns 归正后的档位；与入参相同表示无需变更（调用方可据此决定是否提示用户）。
 */
export function reconcileEffortForModel(
  cap: EffortCapability,
  runtimeEffort: EffortSetting,
): EffortSetting {
  if (runtimeEffort === undefined) return undefined; // auto 天然跟随新模型
  if (!cap.supportsEffort) return runtimeEffort; // 不支持档位的模型不下发，留着旧值无害
  const levels = getSelectableEfforts(cap);
  if (levels.includes(runtimeEffort)) return runtimeEffort;
  const wire = previewWireEffort(cap, runtimeEffort);
  return levels.includes(wire) ? wire : cap.defaultEffort;
}

/**
 * thinking 是否实际开启（优先级 env > runtime > cap.thinkingDefaultOn）。
 * @param envOverride getThinkingEnvOverride() 的返回值：null=env 未设；true/false=env 强制。
 */
export function resolveThinking(
  cap: EffortCapability,
  runtimeThinking: ThinkingSetting,
  envOverride: boolean | null,
): boolean {
  if (envOverride !== null) return envOverride;
  if (runtimeThinking === "on") return true;
  if (runtimeThinking === "off") return false;
  return cap.thinkingDefaultOn; // auto
}

// ─────────────────────────────────────────────────────────────
// 6. 环境变量读取（含 CLAUDE_CODE_EFFORT_LEVEL 兼容别名）
// ─────────────────────────────────────────────────────────────

/**
 * 读取 effort 环境变量覆盖。
 * - SID_CODE_EFFORT_LEVEL 优先于兼容别名 CLAUDE_CODE_EFFORT_LEVEL（自有变量 > 兼容别名，方案 §9.2.7）。
 * - 'unset' / 'auto' → 强制 auto（返回 undefined）。
 * - 合法档位 → 返回该档位。
 * - 未设 / 非法值 → 返回 null（不参与覆盖）。
 */
export function getEffortEnvOverride(
  env: Record<string, string | undefined> = process.env,
): EffortSetting | null {
  const raw = env.SID_CODE_EFFORT_LEVEL ?? env.CLAUDE_CODE_EFFORT_LEVEL;
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v === "unset" || v === "auto") return undefined; // 强制 auto
  if (isEffortLevel(v)) return v;
  return null; // 非法值忽略
}

/**
 * 读取 thinking 环境变量覆盖（SID_CODE_THINKING）。
 * - on / true / 1 → true；off / false / 0 → false；auto → null（强制跟随默认）。
 * - 未设 / 非法 → null（不覆盖）。
 */
export function getThinkingEnvOverride(
  env: Record<string, string | undefined> = process.env,
): boolean | null {
  const raw = env.SID_CODE_THINKING;
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return null; // auto / 非法 → 不覆盖
}

/**
 * §12 P2-1：读取思考 token 预算上限（SID_CODE_MAX_THINKING_TOKENS / 兼容别名 MAX_THINKING_TOKENS）。
 *
 * 对齐 CC `MAX_THINKING_TOKENS`——直接钳制思考 token 上限省钱。
 * - `SID_CODE_MAX_THINKING_TOKENS` 优先于兼容别名 `MAX_THINKING_TOKENS`（自有变量 > 迁移别名）。
 * - settings 参数 `settingsValue` 优先级低于 env（env 是即时覆盖）。
 * - 须为正整数；非法值（≤0 / NaN）忽略返回 null（不钳制）。
 *
 * 语义随模型协议不同：
 * - manual 模型（budget 客户端下发）：直接 Math.min(档位budget, 上限)，精确钳制。
 * - adaptive 模型（budget 服务端定）：客户端无法硬钳，改为按上限把 effort 降档间接压低（见 applyAnthropicNative）。
 *
 * @param settingsValue settings.maxThinkingTokens（可选，env 未设时的兜底）
 * @returns 正整数上限，或 null（未设/非法）。
 */
export function getMaxThinkingTokensOverride(
  settingsValue?: number,
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.SID_CODE_MAX_THINKING_TOKENS ?? env.MAX_THINKING_TOKENS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    // 非法 env 值：不静默回退到 settings（用户显式设了 env 应能看出问题），直接忽略返回 null
    return null;
  }
  if (settingsValue !== undefined && Number.isFinite(settingsValue) && settingsValue > 0) {
    return Math.floor(settingsValue);
  }
  return null;
}

/**
 * §12 P2-1：adaptive 模型下把「思考 token 上限」映射到 effort 降档（客户端无法硬钳服务端预算）。
 * 阈值与 ANTHROPIC_EFFORT_BUDGET 档位预算对应：<5K→low、<15K→medium、<32K→high，否则不降。
 * 返回降档后的建议 effort（若无需降档返回 null）。
 */
export function mapThinkingCapToEffort(maxThinkingTokens: number): EffortLevel | null {
  if (maxThinkingTokens < 5_000) return "low";
  if (maxThinkingTokens < 15_000) return "medium";
  if (maxThinkingTokens < 32_000) return "high";
  return null; // ≥32K：不降档（已接近/超过 xhigh 预算）
}
