/**
 * openai-usage.ts — OpenAI 族 usage 字段提取的**单一事实源**
 *
 * 为什么独立成文件：`openai.ts` 与 `openai-responses.ts` 都要用这两个提取器，
 * 而 `openai.ts` 已 import `openai-responses.ts`（`parseResponsesStream`），
 * 反向 import 会成环。放在这里让两边平等依赖，避免"两条协议路径各写一份提取逻辑"
 * ——那正是 2026-08-08 那个漏采 bug 的形态（Responses 路径从不读任何 cache 字段）。
 *
 * 三种 usage 形态的键名对照（依据 api-reference 各家文档 + 实测 curl）：
 *
 * | 维度 | Chat Completions | Responses API |
 * | --- | --- | --- |
 * | 输入 | `prompt_tokens` | `input_tokens` |
 * | 缓存命中 | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
 * | 推理 | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |
 *
 * 两个提取器都做**跨形态兜底**（把两族键名放进同一条链），所以任一路径调用都能拿到值；
 * 这样即便将来协议分派出错，也只是走错线，不会同时丢数据。
 */

import type { Usage } from "./types.ts";

/**
 * 从 OpenAI 兼容响应的 usage 提取"缓存命中(读)token 数"——所有路径共用的单一事实源。
 *
 * 各家字段差异按优先级兜底：
 *   ① `prompt_cache_hit_tokens` —— DeepSeek 官方直连的顶层专有字段；
 *   ② `prompt_tokens_details.cached_tokens` —— OpenAI Chat Completions 标准字段。
 *      公司网关(uni-api) 对所有 OpenAI 族后端(deepseek/glm/gemini/qwen 隐式/grok/kimi)
 *      统一归一化到此（实测 curl 各家均返回此形状，官方顶层扩展字段被网关吃掉）；
 *   ③ `input_tokens_details.cached_tokens` —— **Responses API 形状**。与 ② 是不同的键，
 *      2026-08-08 前不在链里，导致整个 openai-responses 族 11 个模型的命中全部漏采
 *      （luna 账本记 2.2%，实测真实 95.2%）；
 *   ④ `cached_tokens` —— Kimi 官方直连的顶层扩展字段(标准端点顶层无此字段，
 *      放兜底链末尾不会误伤其它家)。
 *
 * 缓存写入(cacheCreationInputTokens)：OpenAI 族均无自动写入计费概念(恒 0)；
 * Qwen 显式缓存的 `cache_creation_input_tokens` 需客户端主动打 cache_control 标记，
 * 当前 openai 协议路径不发该标记，不会产生，故不映射。
 */
export function extractOpenAICacheHit(usage: any): number {
  return usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.cached_tokens
    ?? 0;
}

/**
 * 从 OpenAI 兼容响应的 usage 提取"推理(思考)token 数"——所有路径共用的单一事实源。
 *
 * ① `completion_tokens_details.reasoning_tokens` —— Chat Completions 标准字段
 *    （OpenAI o-series / GLM / DeepSeek 经网关归一化后均落此形状）；
 * ② `output_tokens_details.reasoning_tokens` —— Responses API 形状；
 * ③ 顶层 `reasoning_tokens` —— DeepSeek 官方直连可能出现。
 *
 * 该值是输出 token 的**子集**（reasoning 已计入 completion/output_tokens），
 * 单独暴露供成本拆解（缺口分析二类），调用方勿再叠加进 outputTokens。
 * 无该字段（非思考模型 / 网关未透传）时返回 0，由上层决定是否落 undefined。
 */
export function extractOpenAIReasoningTokens(usage: any): number {
  return usage?.completion_tokens_details?.reasoning_tokens
    ?? usage?.output_tokens_details?.reasoning_tokens
    ?? usage?.reasoning_tokens
    ?? 0;
}

/**
 * 把 Responses API 的 usage 映射进统一 {@link Usage}，就地改写传入对象。
 *
 * 与 Chat 路径共用上面两个提取器 —— 刻意不写第二份提取逻辑。
 * `reasoningTokens` 只在非零时写入：落一个 0 会让"非思考模型"与"网关未透传"
 * 无法区分，而 undefined 才是"本次没有这个维度"的正确表达。
 */
export function applyResponsesUsage(target: Usage, usage: any): void {
  target.inputTokens = usage?.input_tokens ?? target.inputTokens ?? 0;
  target.outputTokens = usage?.output_tokens ?? target.outputTokens ?? 0;

  const cacheHit = extractOpenAICacheHit(usage);
  if (cacheHit > 0) target.cacheReadInputTokens = cacheHit;

  const reasoning = extractOpenAIReasoningTokens(usage);
  if (reasoning > 0) target.reasoningTokens = reasoning;
}
