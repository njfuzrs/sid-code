/**
 * 子代理 effort → SendParams 的唯一收口。
 *
 * 为什么单独一个文件：`executeInner` 与 `executeCustomInner` 各写过一份
 * 「low/medium/high → high；xhigh/max → max」的手写映射，两份必然漂移，
 * 而且都绕过 `effort.ts` 的能力层。后果是 GPT-5.6 族（唯一原生认 xhigh 的协议）
 * 在子代理路径上把 xhigh 塌成 max，而主循环同一档位是原样透传——
 * 同一个 xhigh，主循环和子代理发出去的不是一回事，且不报错。
 *
 * 这里复用主循环 `query/loop.ts` 同一套解析：`resolveEffortCapability` 按模型定族，
 * `applyToSendParams` 按族翻译线格式。不支持的档位由各族 applier 自己钳制
 * （DeepSeek xhigh→max、o-series/Grok max/xhigh→high），不在这里写死模型名单。
 */

import type { SendParams } from "../llm/types.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import {
  resolveEffortCapability,
  getMaxThinkingTokensOverride,
  type EffortLevel,
} from "../llm/effort.ts";

export interface SubAgentEffortInput {
  /** 子代理实际使用的模型名（task.model / 按类型解析 / 主模型，调用方已算好） */
  model: string;
  /** provider 名（`provider.name()`）。缺省时只按模型名判族 */
  providerName?: string;
  /**
   * 端点 URL。只影响 DeepSeek 双端点的族判定（OpenAI 兼容 vs Anthropic 兼容），
   * 其余族不看它。拿不到时按模型名判，DeepSeek 退到 OpenAI 兼容端点。
   */
  baseURL?: string;
  /** 显式档位；undefined = 子代理默认不思考（与改造前的「未指定 effort 关 thinking」一致） */
  effort?: EffortLevel;
}

/**
 * 把子代理的 effort 翻译成要并进 `sendParamsExtra` 的字段。
 *
 * - `effort` 未指定 → `{ thinking: SIDE_CALL_NO_THINK }`，子代理默认不思考。
 *   这是既有行为（explore/summarize 这类只读子代理不该默认烧思考 token），保持不变。
 * - `effort` 显式指定 → 视为「要思考」，经能力层映射后下发。
 *   思考预算上限（`getMaxThinkingTokensOverride`）一并透传，manual 线格式模型
 *   由 applier 精确钳制、adaptive 模型按上限降档——与主循环同一条路径。
 */
export function buildSubAgentEffortParams(input: SubAgentEffortInput): Partial<SendParams> {
  if (input.effort === undefined) {
    return { thinking: SIDE_CALL_NO_THINK };
  }

  const cap = resolveEffortCapability({
    model: input.model,
    provider: input.providerName ?? "",
    baseURL: input.baseURL,
  });
  const thinkingCap = getMaxThinkingTokensOverride();

  const params: SendParams = {
    model: input.model,
    messages: [],
    maxTokens: 0,
    maxThinkingTokens: thinkingCap ?? undefined,
  };
  // 显式指定 effort = 要思考。thinking 开关由 applier 按族决定具体线格式
  // （Anthropic 写 budget_tokens、DeepSeek/GLM 写 thinking:{type}），这里只给意图。
  cap.applyToSendParams(params, input.effort, true);

  const extra: Partial<SendParams> = {};
  if (params.thinking) extra.thinking = params.thinking;
  if (params.reasoningEffort !== undefined) extra.reasoningEffort = params.reasoningEffort;
  if (params.outputConfig) extra.outputConfig = params.outputConfig;
  if (params.maxThinkingTokens !== undefined) extra.maxThinkingTokens = params.maxThinkingTokens;
  if (params.thinkingBudgetCapped) extra.thinkingBudgetCapped = params.thinkingBudgetCapped;
  return extra;
}
