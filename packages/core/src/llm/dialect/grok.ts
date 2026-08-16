/**
 * xAI Grok 方言（OpenAI 兼容端点，推理模型 grok-4.3 / grok-4.20 / grok-build）。
 *
 * 出处见随行文档 `grok.md`。
 *
 * 与 DeepSeek/GLM 的关键差别：**无显式思考开关**（配置化推理，内置不可关），
 * 故 effort 下发**不受** thinking 门控——`/think off` 之后档位照发。
 * 这个差异对用户可见，`effort.ts isEffortGatedByThinking` 靠跑真实映射探测它。
 */

import type { SendParams } from "../types.ts";
import type { Dialect } from "./types.ts";

export const grokOpenAIDialect: Dialect = {
  kind: "grok-openai",
  flags: {
    supportsEffort: true,
    // Grok 只有 none/low/medium/high，无 max。
    supportsMaxEffort: false,
    // 配置化推理，无显式开关。
    supportsThinkingToggle: false,
    thinkingDefaultOn: true,
    // grok-4.3 默认 low（见 grok.md）。
    defaultEffort: "low",
  },
  wire: {
    thinkingToggle: "none",
    sendsReasoningEffort: true,
    /**
     * ⚠ `true` 而不是 `false`，尽管本族**没有**思考开关可言。
     *
     * 这是照搬重构前的既有行为：旧代码 Grok 那一支写着
     * `if (isGrok && effectiveEffort && effectiveEffort !== "max" && !thinkingDisabled)`
     * —— 带 `!thinkingDisabled` 守卫，而紧邻的 o-series 那一支**没有**。
     *
     * 这处不对称大概是当年顺手复制 DeepSeek 分支留下的（Grok 无开关，
     * `params.thinking.enabled === false` 只可能由上层显式塞进来，实际极少生效）。
     * 但它在线上活着，本次是纯搬迁 —— 抹平它属于改行为，要改另开 PR。
     * 写在这里而不是悄悄「修正」，是为了让下一个人知道这是**已知**的不对称。
     */
    effortGatedByThinking: true,
    allowsMaxEffort: false,
    toolChoice: "full",
  },
  applyToSendParams(params: SendParams, effort) {
    // 刻意不写 params.thinking：本族无思考开关，下发一个它不认的结构是白撞 400。
    if (effort !== undefined) {
      // Grok 无 max：max 与 xhigh 均钳到 high。
      params.reasoningEffort = effort === "max" || effort === "xhigh" ? "high" : effort;
    }
  },
};
