/**
 * Anthropic 原生 Claude 方言。
 *
 * 出处见随行文档 `anthropic.md`。
 *
 * ## 本族是「为什么必须有函数钩子」的证明
 *
 * 其余六族的差异都能用 {@link WireDialect} 那五个字段枚举完。本族不能：
 *
 * - `thinking` 的强度是 **`budget_tokens` 数值**（2K/10K/20K/32K/50K），不是档位字符串
 * - 新旧模型走**两条不同协议**（adaptive 的 `{type:"adaptive"}` + `output_config.effort`
 *   vs manual 的 `{type:"enabled", budget_tokens:N}`）
 * - 思考 token 上限的钳制方式随协议不同：manual 能精确 `Math.min`，
 *   adaptive 只能**反查档位间接压低**（预算由服务端定，客户端钳不动）
 *
 * 这三条没有一条能写成布尔位或枚举——故本族用 `applyToSendParams` 表达。
 * 这也是 PR-2 的 compat 布尔位层刻意留下的边界：它明确写了
 * 「`supportsReasoningEffort: false` 对 adaptive 模型是矛盾配置，需 dialect 层做结构转换」。
 */

import type { SendParams } from "../types.ts";
import { lookupCatalog } from "../model-params-catalog.ts";
import type { Dialect, DialectEffortLevel } from "./types.ts";

/**
 * 「档位 → thinking budget_tokens」映射。
 *
 * 沿用既有预算思路（simple 2K / medium 10K / complex 50K），补 high=20K、xhigh=32K
 * 两档，使 5 档与预算一一对应。
 *
 * ⚠ 这张表同时被 `mapThinkingCapToEffort`（反向：上限 → 档位）用作阈值依据，
 * 两者必须同步改——改一处就是「正向映射与反向钳制对不上」。
 */
export const ANTHROPIC_EFFORT_BUDGET: Record<DialectEffortLevel, number> = {
  low: 2_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 50_000,
};

/**
 * adaptive 模型下把「思考 token 上限」映射到 effort 降档。
 *
 * 为什么需要它：adaptive 模型的预算由**服务端**决定，客户端无法硬钳
 * （没有 `budget_tokens` 字段可写），只能通过降低 effort 档位间接压低思考量。
 *
 * 阈值与 {@link ANTHROPIC_EFFORT_BUDGET} 对应：<5K→low、<15K→medium、<32K→high。
 * ≥32K 返回 null（不降档：已接近/超过 xhigh 预算，再降就是无谓削弱）。
 */
export function mapThinkingCapToEffort(maxThinkingTokens: number): DialectEffortLevel | null {
  if (maxThinkingTokens < 5_000) return "low";
  if (maxThinkingTokens < 15_000) return "medium";
  if (maxThinkingTokens < 32_000) return "high";
  return null;
}

/**
 * 构造 Anthropic 原生方言。
 *
 * @param resolveMaxThinking 读「思考 token 上限」（env > settings）的钩子。
 *
 * 为什么用**注入**而不是直接 import `effort.ts getMaxThinkingTokensOverride`：
 * 那会形成 `effort.ts → dialect/ → effort.ts` 的 import 环。环在 bun 下不一定报错，
 * 但会让模块初始化顺序变得依赖引入路径——本仓有过「registry 被 as-unknown 替身充当」
 * 这类初始化时序坑。注入让依赖方向保持单向（`effort.ts` → `dialect/`）。
 */
export function createAnthropicNativeDialect(
  resolveMaxThinking: (settingsValue?: number) => number | null,
): Dialect {
  return {
    kind: "anthropic-native",
    flags: {
      supportsEffort: true,
      supportsMaxEffort: true,
      supportsThinkingToggle: true,
      // 原生 Claude 思考默认关（与 DeepSeek/GLM 相反）。
      thinkingDefaultOn: false,
      defaultEffort: "high",
    },
    wire: {
      // 走 anthropic.ts 的独立请求构造器，不经过 openai.ts 的顶层字段透传。
      // 以下取值只为描述符完整性，`isChatCompletionsFamily` 已排除本族。
      thinkingToggle: "none",
      sendsReasoningEffort: false,
      effortGatedByThinking: true,
      allowsMaxEffort: true,
      toolChoice: "full",
    },
    applyToSendParams(params: SendParams, effort, thinking) {
      const thinkingMode = lookupCatalog(params.model || "")?.thinkingMode;
      // 思考 token 上限（env / settings）。null 表示未设。
      const maxThinking = resolveMaxThinking(params.maxThinkingTokens);

      if (thinkingMode === "always-on" || thinkingMode === "adaptive") {
        // ── adaptive / always-on 路径 ──
        // always-on 模型不可关闭思考（关也按低 effort 下发），避免 400。
        const effectiveThinking = thinkingMode === "always-on" ? true : thinking;

        if (!effectiveThinking) {
          // adaptive 模型显式关闭思考：不下发 thinking 参数（省略 = 不思考）。
          params.thinking = { enabled: false, budgetTokens: 0 };
          return;
        }

        // auto（effort=undefined）→ 走模型默认（Opus 4.8 默认 high）。
        let effectiveEffort: DialectEffortLevel = effort ?? "high";
        // adaptive 模型 budget 由服务端定，客户端无法硬钳——改为按上限把 effort 降档间接压低。
        // 仅当降档结果比用户档位更低时才生效（不上调），并在 outputConfig 打标记供 UI/日志诚实告知。
        if (maxThinking !== null) {
          const capped = mapThinkingCapToEffort(maxThinking);
          if (
            capped !== null &&
            ANTHROPIC_EFFORT_BUDGET[capped] < ANTHROPIC_EFFORT_BUDGET[effectiveEffort]
          ) {
            effectiveEffort = capped;
            params.thinkingBudgetCapped = {
              requestedMax: maxThinking,
              mappedEffort: capped,
              mode: "adaptive",
            };
          }
        }
        // Anthropic adaptive 线格式官方档位为 low/medium/high/max，不含 xhigh：
        // xhigh 钳到 max，避免未知档位触发 400。
        const level = effectiveEffort === "xhigh" ? "max" : effectiveEffort;
        // 标记为 adaptive 模式：anthropic.ts 据此下发 {type:"adaptive"} 而非 {type:"enabled"}。
        params.thinking = { enabled: true, budgetTokens: 0 };
        params.outputConfig = { effort: level, thinkingType: "adaptive" };
      } else {
        // ── manual 路径（旧模型：Opus 4-20250514 / Sonnet 4.5 / Haiku 4.5 等）──
        if (!thinking) {
          params.thinking = { enabled: false, budgetTokens: 0 };
          return;
        }
        // auto（effort=undefined）兜底用 medium 预算，保证开思考时有合理预算。
        const level: DialectEffortLevel = effort ?? "medium";
        let budget = ANTHROPIC_EFFORT_BUDGET[level];
        // manual 模型 budget 由客户端下发，可精确钳制：Math.min(档位budget, 上限)。
        if (maxThinking !== null && maxThinking < budget) {
          budget = maxThinking;
          params.thinkingBudgetCapped = {
            requestedMax: maxThinking,
            appliedBudget: budget,
            mode: "manual",
          };
        }
        params.thinking = { enabled: true, budgetTokens: budget };
      }
    },
  };
}
