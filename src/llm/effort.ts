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
 * - thinking + effort → thinking.budget_tokens（anthropic.ts:137 已消费）。
 * - effort 档位映射预算：low=2K / medium=10K / high=20K / max=50K。
 */
function applyAnthropicNative(params: SendParams, effort: EffortSetting, thinking: boolean): void {
  if (!thinking) {
    // 显式关闭：不开 Extended Thinking（anthropic.ts 仅在 enabled 时下发 thinking 块）。
    params.thinking = { enabled: false, budgetTokens: 0 };
    return;
  }
  // auto（effort=undefined）兜底用 medium 预算，保证开思考时有合理预算。
  const level: EffortLevel = effort ?? "medium";
  params.thinking = { enabled: true, budgetTokens: ANTHROPIC_EFFORT_BUDGET[level] };
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

const APPLIERS: Record<CapabilityKind, EffortCapability["applyToSendParams"]> = {
  "deepseek-openai": applyDeepSeekOpenAI,
  "deepseek-anthropic": applyDeepSeekAnthropic,
  "anthropic-native": applyAnthropicNative,
  "o-series": applyOSeries,
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

/** 判定模型/协议属于哪一类（判定优先级见方案 §2.4） */
function classifyCapability(opts: {
  model: string;
  provider: string;
  baseURL?: string;
}): CapabilityKind {
  const { model, provider, baseURL } = opts;
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
