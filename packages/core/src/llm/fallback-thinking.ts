/**
 * fallback 降级时按**备用模型**重下 thinking / effort 参数（D9）。
 *
 * 修前 `streamFromFallback` 用 `{...params}` 把主模型按自己那一族算好的
 * `thinking` / `reasoningEffort` / `outputConfig` 原样带给备用模型，实测四个方向：
 * DeepSeek `off` → Sonnet 5 时 `off` 静默失效；Sonnet 5 adaptive → DeepSeek 时把 Claude 专属的
 * `outputConfig.thinkingType` 灌进 DeepSeek。降级本就是「主模型已坏」的时刻，再叠一层静默错误
 * 用户几乎无法归因。
 *
 * 三条不能改回去的约束：
 * 1. **先清空再重下**三个字段，不做「只覆盖有值的位」——否则主模型族专有字段会残留。
 * 2. 输入取 `params.thinkingIntent`（调用方在 applier 之前写的原始意图），**不取**
 *    `params.thinking.enabled`（恒思考模型上已被强制成 true，会传染），也不取用户 `/think`
 *    （side-call / 子代理也走 fallback，它们的意图不是用户开关）。
 * 3. 能力判定吃**真名**（别名经进程级别名表翻译），与主循环同口径。
 */

import { resolveEffortCapability, type EffortCapability } from "./effort.ts";
import type { SendParams } from "./types.ts";
import { lookupWireModelAlias } from "./wire-model.ts";

/** 按备用模型解析能力的回调（app.ts 注入，可带 availableModels 里的 baseURL / supportsThinking）。 */
export type FallbackCapabilityResolver = (model: string) => EffortCapability | undefined;

/**
 * 原地改写 `params`：清空主模型族的思考字段，按备用模型能力与原始意图重下。
 *
 * 主模型参数里没有任何思考字段（调用方根本没表达过意图）时不动——此时既无可传染的东西，
 * 也没有可依据的意图，硬下发只会凭空改变请求形状。
 */
export function reapplyThinkingForFallback(
  params: SendParams,
  opts: {
    fallbackModel: string;
    providerName: string;
    resolveCapability?: FallbackCapabilityResolver;
  },
): void {
  const intent =
    params.thinkingIntent ??
    (params.thinking ? { thinking: params.thinking.enabled, effort: undefined } : undefined);
  if (!intent && params.reasoningEffort === undefined && params.outputConfig === undefined) return;

  delete params.thinking;
  delete params.reasoningEffort;
  delete params.outputConfig;
  delete params.thinkingBudgetCapped;
  if (!intent) return;

  const cap =
    opts.resolveCapability?.(opts.fallbackModel) ??
    resolveEffortCapability({
      model: lookupWireModelAlias(opts.fallbackModel) ?? opts.fallbackModel,
      provider: opts.providerName,
      alias: opts.fallbackModel,
    });
  let effort = intent.effort;
  // 与主循环 resolveAppliedEffort 同一条钳制：备用模型不支持 max 时降到 high。
  if (effort === "max" && !cap.supportsMaxEffort) effort = "high";
  cap.applyToSendParams(params, effort, intent.thinking);
}
