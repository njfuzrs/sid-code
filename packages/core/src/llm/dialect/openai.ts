/**
 * OpenAI 自家两族：o-series（Chat Completions）与 GPT-5.x（Responses API）。
 *
 * 放在同一个文件是因为它们**同厂、同为内置推理、差异点完全对称**（一个不认 xhigh、
 * 一个原生认 xhigh），拆两个文件会让读者来回跳着才能看出这组对照。
 * 出处见随行文档 `openai.md`。
 */

import type { SendParams } from "../types.ts";
import type { Dialect } from "./types.ts";

/**
 * OpenAI o-series（o1/o3/o4…），走 Chat Completions。
 *
 * - 无显式思考开关（内置推理）
 * - effort → 顶层 `reasoning_effort`（low/medium/high，**无 max**）
 */
export const oSeriesDialect: Dialect = {
  kind: "o-series",
  flags: {
    supportsEffort: true,
    supportsMaxEffort: false,
    supportsThinkingToggle: false,
    thinkingDefaultOn: true,
    defaultEffort: "medium",
  },
  wire: {
    thinkingToggle: "none",
    sendsReasoningEffort: true,
    effortGatedByThinking: false,
    allowsMaxEffort: false,
    toolChoice: "full",
  },
  applyToSendParams(params: SendParams, effort) {
    if (effort !== undefined) {
      // o-series 仅 low/medium/high：max 与 xhigh 均钳到 high。
      params.reasoningEffort = effort === "max" || effort === "xhigh" ? "high" : effort;
    }
  },
};

/**
 * OpenAI Responses API 族（GPT-5.x，走 POST /v1/responses 的嵌套 `reasoning.effort`）。
 *
 * **本族是目前唯一原生认 `xhigh` 的协议族**，故 5 档原样透传、不钳制。
 * 请求体由 `openai-responses-request.ts buildResponsesRequest` 构造成嵌套
 * `reasoning:{effort}`，**不经过** `openai.ts` 的顶层字段透传——故
 * `isChatCompletionsFamily` 把本族排除在外。
 *
 * ## 一段值得留着的历史
 *
 * 此前本族错绑 no-op applier（连同 `supportsEffort: false`），注释写「当前不支持」，
 * 导致 `/effort` 对所有 GPT-5.x 硬报「不支持推理强度档位切换」。
 * 实为**未接线而非真不支持**：服务端对非法值返回 400 `param: reasoning.effort`，
 * 证明字段被校验、能力存在。
 *
 * 这是「有代码 ≠ 有能力」的反面形态——**声明了不支持，于是永远不会去试，
 * 于是永远发现不了它其实支持**。
 */
export const openAIResponsesDialect: Dialect = {
  kind: "openai-responses",
  flags: {
    supportsEffort: true,
    supportsMaxEffort: true,
    // 推理内置、不可关。注意这**不影响** effort 下发（applier 不受 thinking 门控，
    // 与 Grok 同构）——两件事此前被混为一谈过。
    supportsThinkingToggle: false,
    thinkingDefaultOn: false,
    // 取自服务端实测回显：不传 reasoning 时 echo effort=medium。
    defaultEffort: "medium",
  },
  wire: {
    // 走 openai-responses-request.ts 的独立构造器，以下取值只为描述符完整性。
    thinkingToggle: "none",
    sendsReasoningEffort: false,
    effortGatedByThinking: false,
    allowsMaxEffort: true,
    toolChoice: "full",
  },
  applyToSendParams(params: SendParams, effort) {
    if (effort !== undefined) {
      // 5 档原样透传，不钳制——本族原生认 xhigh。
      params.reasoningEffort = effort;
    }
  },
};

/**
 * 未知协议族兜底。
 *
 * ## 为什么它有 applier 而不是 no-op（这条是一次真实缺陷的修复）
 *
 * 2026-08-01 前：`effort.ts` 对未知族**乐观放行**（`supportsEffort: true`），
 * 算出 `params.reasoningEffort="high"`；但 `openai.ts` 的分派只认 deepseek/glm/grok/o-series
 * 四族，未知族没有任何分支接它——**字段算出来却从不进 requestBody**。
 * 实测 `kimi-k3` / `qwen3-coder-plus` / 任意新模型全部如此。
 *
 * 连带后果比「effort 不生效」严重得多：字段发不出去 ⇒ 服务端永远不会因它报 400
 * ⇒ `withCapabilityHealing` 的自愈**对未知模型永不触发** ⇒ `model-capabilities.ts` 的
 * 「乐观放行 + 400 自愈学真值」闭环在它唯一的目标人群上是断的。
 * **整套动态采集机制恰好在最需要它的地方空转。**
 *
 * ## 取舍：明知代价仍选下发
 *
 * 下发等于主动去撞可能的 400 换取自愈学习，首次请求可能多一跳重试。可接受的理由：
 *
 * 1. **撞了就学到**：`learnFromError` 记住服务端自报档位，剥字段重试一次即成功，
 *    用户看到的是一次正常完成的请求；下次起缓存已准，不再多这一跳。
 * 2. 大量 OpenAI 兼容端点对不认识的顶层字段是**忽略**而非报错，多数情况零代价。
 * 3. 反面更糟：永不下发 = 用户设了 `/effort` 却静默无效，且这个静默**永远不会自愈**。
 *
 * ## 但**不**下发 thinking
 *
 * 与 `flags.supportsThinkingToggle: false` 一致：thinking 的结构各家不同
 * （DeepSeek/GLM 是 `{type}`、Anthropic 是 `{budget_tokens}`），瞎猜结构的 400 风险
 * 远高于一个标量字段，且**无法从错误文本反推正确结构，自愈救不回来**。
 *
 * ⚠ 注意 `flags` 这里是「保守全 false」而 applier 却下发 effort——两者**不矛盾**：
 * `flags` 是 `effort.ts` 在**协议族已知为 unknown 且动态能力缓存也没有记录**时的兜底展示口径，
 * 而真正决定「乐观放行」的是 `effort.ts resolveFromCapabilityCache`（它会覆盖 flags）。
 * 本 applier 负责的是「一旦上层决定要发，字段得真的进请求体」这一段。
 */
export const unknownDialect: Dialect = {
  kind: "unknown",
  flags: {
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsThinkingToggle: false,
    thinkingDefaultOn: false,
    defaultEffort: "high",
  },
  wire: {
    thinkingToggle: "none",
    // 见上：这一支是 400 自愈闭环的入口，置 false 会让整套动态采集对未知模型失效。
    sendsReasoningEffort: true,
    // 与其它族保持一致语义：思考显式关闭时不下发。
    effortGatedByThinking: true,
    allowsMaxEffort: true,
    toolChoice: "full",
  },
  applyToSendParams() {
    /**
     * 刻意 no-op —— 与上面 `wire.sendsReasoningEffort: true` 分工不同，不是矛盾。
     *
     * 未知族的**档位映射**由 `effort.ts resolveFromCapabilityCache` 负责（它按动态能力
     * 缓存里服务端自报的档位表钳制，是数据驱动的，比这里任何硬编码都准）。
     * 本 applier 若也写一遍钳制，就是第二份真相，且必然与缓存那份漂移。
     *
     * 而 `wire.sendsReasoningEffort: true` 管的是**装配层**：无论档位是谁算的，
     * 算出来了就得真的进 requestBody。这正是 2026-08-01 那个缺陷的断点所在。
     */
  },
};
