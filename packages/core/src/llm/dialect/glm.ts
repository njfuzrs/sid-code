/**
 * 智谱 GLM 方言（OpenAI 兼容端点）。
 *
 * 出处见随行文档 `glm.md`。
 *
 * ## 与 DeepSeek 的关系：线格式同构，但**不共用**一份描述符
 *
 * 两族在 `wire` 上目前逐字段相同（`thinking:{type}` + 顶层 `reasoning_effort` +
 * 思考门控），原实现因此把它们合成一支 `if (isDeepSeek || isGLM)`。
 *
 * 这里仍分两个 Dialect，理由不是「将来可能不同」（那是投机），而是**它们已经不同**：
 * `toolChoice` 的约束不一样（GLM 是 `auto-only`，DeepSeek 是 `reject-when-thinking`），
 * effort 档位值域也不一样（GLM 认四档，DeepSeek 只认 high/max）。原实现把这两处差异
 * 拆在别的函数里写，于是「DeepSeek 和 GLM 是一回事」这个印象只在 thinking 那一段成立。
 *
 * 合并的代价是真实的：读代码的人看到 `isDeepSeek || isGLM` 会以为两族全等，
 * 然后在 `applyToolChoice` 里被 GLM 的独立分支打脸。
 */

import type { SendParams } from "../types.ts";
import { lookupCatalog } from "../model-params-catalog.ts";
import { roundEffortToKnownValues } from "../model-capability-filter.ts";
import { pickWireModel } from "../wire-model.ts";
import type { Dialect, DialectEffortLevel } from "./types.ts";

type GlmWireEffort = Exclude<DialectEffortLevel, "xhigh">;

/**
 * 把档位落到该模型登记的真实档位上：表内原样，表外沿标度**向上**取最近的一档。
 *
 * 向上而不是向下，跟的是官方自己的语义：GLM-5.2 `low/medium → high`、`xhigh → max`
 * （glm-api.md §6.2）。GLM-5.3 只认 `low/high/max`、对 medium 文档未说明，真网关静默受理
 * （E10），这里同样按向上取整映射成 high，不把官方没列的值透传出去。
 *
 * 取整用线格式层同一个 {@link roundEffortToKnownValues}：此前两处各写一份，线格式层是
 * 「表外一律取最高档」，GLM-5.2 的 low 到那里会变成 max（20261019 effort 复审）。
 *
 * 没登记档位表的 GLM 模型保持旧行为（xhigh → max，其余原样）。
 */
function toGlmWireEffort(effort: DialectEffortLevel, values?: readonly string[]): GlmWireEffort {
  const base: GlmWireEffort = effort === "xhigh" ? "max" : effort;
  if (!values || values.length === 0) return base;
  return roundEffortToKnownValues(base, values) as GlmWireEffort;
}

export const glmOpenAIDialect: Dialect = {
  kind: "glm-openai",
  flags: {
    // effort 仅 GLM-5.2 生效，其余 GLM 无 reasoning_effort 粒度——但下发对它们无害
    // （非 5.2 会忽略该字段），故统一声明 supportsEffort=true。见 glm.md。
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: true,
    thinkingDefaultOn: true,
    defaultEffort: "high",
  },
  wire: {
    thinkingToggle: "type-enum",
    sendsReasoningEffort: true,
    effortGatedByThinking: true,
    allowsMaxEffort: true,
    // GLM 的 tool_choice 默认且仅支持 auto：required/none/指定函数会被拒绝。
    // 降级为不下发（等价服务端默认 auto）而非冒 400。见 glm.md。
    toolChoice: "auto-only",
  },
  applyToSendParams(params: SendParams, effort, thinking) {
    params.thinking = { enabled: thinking, budgetTokens: 0 };
    // 思考关闭时不下发 effort（与 DeepSeek 一致，避免与 disabled 冲突）。
    // GLM 线格式不认 xhigh；每模型的真实档位按注册表档位表映射（见 toGlmWireEffort）。
    // 与线格式层 filterParamsForModel 同用 lookupCatalog + roundEffortToKnownValues，
    // 两处对同一模型给同一个答案（门禁见 effort-review-followups.test.ts）。
    if (thinking && effort !== undefined) {
      const values = lookupCatalog(
        pickWireModel(params, params.model || ""),
      )?.reasoningEffortValues;
      params.reasoningEffort = toGlmWireEffort(effort, values);
    }
  },
};
