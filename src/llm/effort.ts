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

// ─────────────────────────────────────────────────────────────
// 1. 统一内部标度（与协议无关）
// ─────────────────────────────────────────────────────────────

/** 统一推理强度档位（用户面对的永远是这 4 档 + auto） */
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** undefined = auto（跟随模型默认，不显式下发 effort 参数） */
export type EffortSetting = EffortLevel | undefined;

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
  if (thinking && effort !== undefined) {
    params.reasoningEffort = effort === "max" ? "max" : "high";
  }
}

/**
 * 规则 2：DeepSeek（Anthropic 兼容端点）。
 * - thinking 开关有效（budget 被服务端忽略，仍按 anthropic.ts 既有形态下发 enabled）。
 * - effort   走 output_config.effort（由 anthropic.ts S7 补丁消费）：low/medium→high，max→max。
 */
function applyDeepSeekAnthropic(params: SendParams, effort: EffortSetting, thinking: boolean): void {
  params.thinking = { enabled: thinking, budgetTokens: 0 };
  if (thinking && effort !== undefined) {
    params.outputConfig = { effort: effort === "max" ? "max" : "high" };
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
    const level: EffortLevel = effort ?? "high";
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
    params.thinking = { enabled: true, budgetTokens: ANTHROPIC_EFFORT_BUDGET[level] };
  }
}

/**
 * 规则 4：OpenAI o-series。
 * - 无显式思考开关（内置推理），thinking no-op。
 * - effort → reasoning_effort（low/medium/high，无 max：max→high）。由 openai.ts 对 o-series 透传。
 */
function applyOSeries(params: SendParams, effort: EffortSetting, _thinking: boolean): void {
  if (effort !== undefined) {
    params.reasoningEffort = effort === "max" ? "high" : effort;
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
  if (thinking && effort !== undefined) {
    params.reasoningEffort = effort;
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
    params.reasoningEffort = effort === "max" ? "high" : effort;
  }
}

const APPLIERS: Record<CapabilityKind, EffortCapability["applyToSendParams"]> = {
  "deepseek-openai": applyDeepSeekOpenAI,
  "deepseek-anthropic": applyDeepSeekAnthropic,
  "anthropic-native": applyAnthropicNative,
  "o-series": applyOSeries,
  "glm-openai": applyGLMOpenAI,
  "grok-openai": applyGrokOpenAI,
  "openai-responses": applyNoop,
  unknown: applyNoop,
};

/** 各协议的能力位（除 applyToSendParams 外的描述字段） */
const CAPABILITY_FLAGS: Record<
  CapabilityKind,
  Omit<EffortCapability, "applyToSendParams">
> = {
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
    // GPT-5.x Responses API：当前不支持 reasoning_effort / thinking 开关。
    // 未来 o-series 迁移到 Responses API 时再扩展。
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsThinkingToggle: false,
    thinkingDefaultOn: false,
    defaultEffort: "high",
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
  return "unknown";
}

/**
 * 解析当前模型的 effort 能力描述符。
 *
 * 判定优先级（对标 cc 三级链）：
 *   1. 用户显式声明 modelConfig.supportsThinking === false → 强制 unknown（全不支持，避贸然 400）。
 *   2. 内置模型名 / 端点匹配（deepseek 双端点 / anthropic 原生 / o-series）。
 *   3. 兜底 unknown（不支持，不下发 effort）。
 */
export function resolveEffortCapability(opts: {
  model: string;
  provider: string;
  baseURL?: string;
  modelConfig?: { supportsThinking?: boolean };
}): EffortCapability {
  // 优先级 1：用户显式声明不支持思考 → 全 no-op（不下发任何字段）。
  if (opts.modelConfig?.supportsThinking === false) {
    return { ...CAPABILITY_FLAGS.unknown, applyToSendParams: APPLIERS.unknown };
  }

  const kind = classifyCapability(opts);
  return { ...CAPABILITY_FLAGS[kind], applyToSendParams: APPLIERS[kind] };
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
  if (v === "" ) return null;
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
