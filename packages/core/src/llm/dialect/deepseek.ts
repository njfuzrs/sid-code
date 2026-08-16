/**
 * DeepSeek 方言（OpenAI 兼容端点 + Anthropic 兼容端点两支）。
 *
 * 出处与实测记录见随行文档 `deepseek.md`——**结论写在这里，依据写在那里**。
 * 这个分工是刻意的：代码注释要短到有人读，而「为什么是 high/max 而不是四档」
 * 这类需要贴官方文档原文的东西放在代码里会把函数淹掉。
 * （原实现把两者混在一起，`effort.ts` 顶部有 19 行的协议矩阵注释。）
 */

import type { SendParams } from "../types.ts";
import type { Dialect, DialectEffortLevel } from "./types.ts";

/**
 * DeepSeek 仅认 `high` / `max` 两档（低档会被服务端映射为 high，见 `deepseek.md`）。
 * 故 xhigh/max → max，low/medium/high → high。
 *
 * 这不是「我们钳的」而是「服务端本来就这么收敛」——下发 low 不会报错，只是无效。
 * 但仍在客户端映射，好处是 `previewWireEffort` 能对用户诚实显示「你选 low 实发 high」。
 */
function toDeepSeekWireEffort(effort: DialectEffortLevel): "high" | "max" {
  return effort === "max" || effort === "xhigh" ? "max" : "high";
}

/**
 * DeepSeek · OpenAI 兼容端点（主力路径）。
 *
 * - thinking → `params.thinking`，由 `openai.ts` 转请求体顶层 `thinking:{type}`
 * - effort   → `params.reasoningEffort`（仅 high/max）
 */
export const deepseekOpenAIDialect: Dialect = {
  kind: "deepseek-openai",
  flags: {
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
    // DeepSeek V4 思考模式实测 400（`deepseek.md` §tool_choice）。思考关闭时可正常下发，
    // 故是 reject-when-thinking 而非一律拒绝。
    toolChoice: "reject-when-thinking",
  },
  applyToSendParams(params: SendParams, effort, thinking) {
    // budgetTokens 在 DeepSeek OpenAI 端点无对应字段，置 0；强度走 reasoningEffort。
    params.thinking = { enabled: thinking, budgetTokens: 0 };
    // 思考关闭时不下发 effort（避免与 `thinking:{type:"disabled"}` 冲突）。
    if (thinking && effort !== undefined) {
      params.reasoningEffort = toDeepSeekWireEffort(effort);
    }
  },
};

/**
 * DeepSeek · Anthropic 兼容端点。
 *
 * 与上面同族但**线格式不同**：强度走 `output_config.effort`（由 `anthropic.ts` 消费），
 * 不是顶层 `reasoning_effort`。thinking 开关有效但 `budget_tokens` 被服务端忽略。
 *
 * 这一对正是「布尔位表达不了族差异」的最短证明：同一个厂商、同一个模型，
 * 换个端点整个请求体结构就不同，而 compat 的 6 个布尔位里没有任何一位能表达
 * 「effort 该写到哪个字段」。
 */
export const deepseekAnthropicDialect: Dialect = {
  kind: "deepseek-anthropic",
  flags: {
    supportsEffort: true,
    supportsMaxEffort: true,
    supportsThinkingToggle: true,
    thinkingDefaultOn: true,
    defaultEffort: "high",
  },
  wire: {
    // 走 anthropic.ts 的请求构造器，不经过 openai.ts 的顶层字段透传。
    // 这里的取值只为描述符完整性，`isChatCompletionsFamily` 已把本族排除在那条线之外。
    thinkingToggle: "none",
    sendsReasoningEffort: false,
    effortGatedByThinking: true,
    allowsMaxEffort: true,
    toolChoice: "full",
  },
  applyToSendParams(params: SendParams, effort, thinking) {
    params.thinking = { enabled: thinking, budgetTokens: 0 };
    if (thinking && effort !== undefined) {
      params.outputConfig = { effort: toDeepSeekWireEffort(effort) };
    }
  },
};
