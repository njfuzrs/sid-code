/**
 * Goal 预算门控
 *
 * 检查目标的 token 消耗，在预算耗尽时触发收尾模式。
 * 包含 cache_creation tokens（Anthropic 对其收费高于 input）。
 */

import type { GoalState } from "./state.ts";
import { getLogger } from "../debug/logger.ts";

const log = getLogger();

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
}

/**
 * 检查目标预算状态，并累加本轮用量到 goal.tokensUsed。
 * 返回：
 * - "ok": 预算充足
 * - "warning": 已用 ≥85%（预警）
 * - "exceeded": 已用 ≥100%（耗尽）
 */
export function checkGoalBudget(
  goal: GoalState,
  currentTurnUsage: TurnUsage,
): "ok" | "warning" | "exceeded" {
  if (!goal.tokenBudget) return "ok";

  // 累加本轮用量（含 cache_creation，因为 Anthropic 对其收费高于 input）
  goal.tokensUsed +=
    currentTurnUsage.inputTokens +
    currentTurnUsage.outputTokens +
    (currentTurnUsage.cacheCreationTokens ?? 0);

  const ratio = goal.tokensUsed / goal.tokenBudget;
  if (ratio >= 1.0) {
    log.warn(
      "GOAL_BUDGET",
      `预算耗尽: used=${goal.tokensUsed}, budget=${goal.tokenBudget}, ratio=${ratio.toFixed(2)}`,
    );
    return "exceeded";
  }
  if (ratio >= 0.85) {
    log.info(
      "GOAL_BUDGET",
      `预算预警: used=${goal.tokensUsed}, budget=${goal.tokenBudget}, ratio=${(ratio * 100).toFixed(0)}%`,
    );
    return "warning";
  }
  return "ok";
}

/** 构建预算耗尽消息（注入到对话让模型收尾） */
export function buildBudgetLimitMessage(goal: GoalState): string {
  return `<system-reminder>
[Goal 预算耗尽]
目标: ${goal.objective}
已用: ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget!.toLocaleString()} tokens

预算已耗尽，请在本轮内：
1. 总结已完成的进度
2. 列出未完成的部分
3. 给出明确的"下一步"建议（用户可据此决定是否继续）

不要开始新的实质性工作。
</system-reminder>`;
}

/** 构建预算预警消息（85% 时注入） */
export function buildBudgetWarningMessage(goal: GoalState): string {
  const remaining = goal.tokenBudget! - goal.tokensUsed;
  return `<system-reminder>
[Goal 预算预警] 已用 ${Math.round((goal.tokensUsed / goal.tokenBudget!) * 100)}%，剩余约 ${remaining.toLocaleString()} tokens。
请合理分配剩余预算，优先完成最关键的部分。
</system-reminder>`;
}
