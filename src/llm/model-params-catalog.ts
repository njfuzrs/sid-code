/**
 * 模型参数速查表 — 委托 model-registry.ts 的投影适配层。
 *
 * 本文件不再维护独立数据表。所有模型参数数据统一在 model-registry.ts 中定义，
 * 此处仅提供向后兼容的 lookupCatalog / getCatalogEntries 接口（投影掉 pricing 字段）。
 *
 * 消费方（effort.ts / model-capability-filter.ts / discover.ts）无需任何修改。
 */

import { lookupRegistry, getRegistryEntries, type ModelRegistryEntry } from "./model-registry.ts";

export interface ModelParamsEntry {
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking?: boolean;

  // ── 协议能力声明（可选，缺省时走 effort.ts runtime 推断兜底） ──

  /** system prompt 的 role 表示。默认 "system" */
  systemRole?: "system" | "developer";
  /** 输出 token 限制字段名。默认 "max_tokens" */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** 是否支持 temperature/top_p 采样参数。默认 true */
  supportsTemperature?: boolean;
  /** 支持的 reasoning_effort 档位。undefined = 不支持 */
  reasoningEffortValues?: ("low" | "medium" | "high" | "max")[];
  /** 协议族标识（用于 effort.ts 分发）。undefined = 走现有 runtime 推断 */
  protocolKind?: "deepseek-openai" | "deepseek-anthropic" | "anthropic-native" | "o-series" | "glm-openai" | "grok-openai" | "openai-responses" | "unknown";
  /**
   * 多轮工具调用时是否要求回传 reasoning_content。
   * DeepSeek V4 thinking 系为 true（tool-call 轮必须回传，否则 400）；
   * 旧 deepseek-reasoner 为 false。详见 model-registry.ts 同名字段。
   */
  requiresReasoningContentForToolCalls?: boolean;
  /**
   * Extended Thinking 模式（Anthropic 协议族专用）。
   * "adaptive" = Opus 4.7+/Sonnet 4.6；"always-on" = Fable 5/Mythos 5；
   * undefined = manual（旧模型，用 budget_tokens）。
   */
  thinkingMode?: "adaptive" | "always-on";
}

/** 从 ModelRegistryEntry 投影为 ModelParamsEntry（去掉 pricing） */
function projectParams(entry: ModelRegistryEntry): ModelParamsEntry {
  const { pricing: _pricing, ...params } = entry;
  return params;
}

/**
 * 从内置速查表查找模型参数。
 * 匹配策略：精确 → 最长前缀 → 剥离路由前缀后重试 → 大小写不敏感 → 家族匹配 → null
 */
export function lookupCatalog(modelName: string): ModelParamsEntry | null {
  const entry = lookupRegistry(modelName);
  if (!entry) return null;
  return projectParams(entry);
}

/** 获取完整的速查表（只读用途，如 /model discover 展示） */
export function getCatalogEntries(): ReadonlyArray<[string, ModelParamsEntry]> {
  return getRegistryEntries().map(([k, v]) => [k, projectParams(v)] as [string, ModelParamsEntry]);
}
