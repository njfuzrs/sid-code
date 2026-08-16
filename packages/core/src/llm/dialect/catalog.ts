/**
 * dialect 目录 —— 「族 → 方言」的解析入口。
 *
 * 这是本层唯一对外的查表处。`effort.ts` / `openai.ts` 都只跟它打交道，
 * 不直接 import 各族模块——否则「新增一族要改哪几个文件」又变成散落知识。
 */

import type { Dialect, ProtocolFamily, WireDialect } from "./types.ts";
import { classifyProtocolFamily, type ClassifyInput } from "./classify.ts";
import { deepseekOpenAIDialect, deepseekAnthropicDialect } from "./deepseek.ts";
import { glmOpenAIDialect } from "./glm.ts";
import { grokOpenAIDialect } from "./grok.ts";
import { oSeriesDialect, openAIResponsesDialect, unknownDialect } from "./openai.ts";
import { createAnthropicNativeDialect } from "./anthropic.ts";

/**
 * 构造全族方言表。
 *
 * @param resolveMaxThinking 读「思考 token 上限」的钩子，仅 anthropic-native 需要
 *   （见 `anthropic.ts createAnthropicNativeDialect` 里对「为什么注入而不是 import」的说明）。
 *
 * ⚠ 返回的是 `Record<ProtocolFamily, Dialect>` 而非 `Partial<…>`：
 * 类型层强制**每一族都有方言**。新增一个 `ProtocolFamily` 取值而忘了在这里登记，
 * 是编译期错误而不是运行时落到兜底——这正是 PR-1 学到的那条
 * 「协议字面量收进 union 后写错会变成编译期错误」的同类应用。
 */
export function buildDialectCatalog(
  resolveMaxThinking: (settingsValue?: number) => number | null,
): Record<ProtocolFamily, Dialect> {
  return {
    "deepseek-openai": deepseekOpenAIDialect,
    "deepseek-anthropic": deepseekAnthropicDialect,
    "anthropic-native": createAnthropicNativeDialect(resolveMaxThinking),
    "o-series": oSeriesDialect,
    "glm-openai": glmOpenAIDialect,
    "grok-openai": grokOpenAIDialect,
    "openai-responses": openAIResponsesDialect,
    unknown: unknownDialect,
  };
}

/**
 * 分类 + 查表一步到位（大多数调用方要的就是这个）。
 *
 * @returns 该模型的方言；未知族返回 {@link unknownDialect}，**不返回 undefined**——
 *   让调用方无需处理「查不到」的分支（那个分支在原实现里就是各处手写的兜底 if）。
 */
export function resolveDialect(
  catalog: Record<ProtocolFamily, Dialect>,
  input: ClassifyInput,
): Dialect {
  return catalog[classifyProtocolFamily(input)];
}

/**
 * 只取某族的**线格式描述符**（不含 applier）。
 *
 * 给 `openai.ts` 这类只做请求体装配的调用方用：它不需要 `applyToSendParams`
 * （档位映射早在 `effort.ts` 那一层做完了），也不需要 `flags`（那是 UI 的事）。
 *
 * 单独开这个入口而不是让它拿整个 `Dialect`，是为了不必给它注入
 * `resolveMaxThinking` —— 那个钩子只有 anthropic-native 的 applier 要，
 * 而 anthropic-native 根本不走 Chat Completions 线。让装配层去构造一个它用不到的
 * 依赖，是把「谁需要什么」这件事搞浑。
 *
 * 线格式描述符是**纯数据**（无闭包、无注入），故这里用一张静态表，不惰性构造。
 */
export function getDialectWire(kind: ProtocolFamily): WireDialect {
  return WIRE_DIALECTS[kind];
}

/** 各族线格式描述符的静态表。取值来自各族模块，此处只做投影，不重新声明。 */
const WIRE_DIALECTS: Record<ProtocolFamily, WireDialect> = {
  "deepseek-openai": deepseekOpenAIDialect.wire,
  "deepseek-anthropic": deepseekAnthropicDialect.wire,
  // anthropic-native 的 wire 是纯数据，与它 applier 需要的注入无关，故可直接取。
  // 传一个永不被调用的 stub：本表只读 .wire，applier 不会在这里执行。
  "anthropic-native": createAnthropicNativeDialect(() => null).wire,
  "o-series": oSeriesDialect.wire,
  "glm-openai": glmOpenAIDialect.wire,
  "grok-openai": grokOpenAIDialect.wire,
  "openai-responses": openAIResponsesDialect.wire,
  unknown: unknownDialect.wire,
};

export { classifyProtocolFamily, isChatCompletionsFamily } from "./classify.ts";
export type { ClassifyInput } from "./classify.ts";
export {
  getToolSchemaDialect,
  sanitizeToolSchema,
  hasStrictIncompatibleNode,
  JSON_SCHEMA_META_KEYS,
} from "./tool-schema.ts";
export type { ToolSchemaDialect, SanitizeResult, SanitizeOptions } from "./tool-schema.ts";
export type {
  Dialect,
  DialectFlags,
  DialectEffortLevel,
  ProtocolFamily,
  ToolChoiceConstraint,
  WireDialect,
} from "./types.ts";
export { ANTHROPIC_EFFORT_BUDGET, mapThinkingCapToEffort } from "./anthropic.ts";
