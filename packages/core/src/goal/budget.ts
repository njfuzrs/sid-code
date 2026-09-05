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
 * 无条件累加本轮用量到 goal.tokensUsed（含 cache_creation，Anthropic 对其收费高于 input）。
 *
 * ## 为什么这一步必须与预算门控分开（F1，2026-09-03 排查）
 *
 * 原先累加写在 `checkGoalBudget` 里、并且在 `if (!goal.tokenBudget) return "ok"` 之后，
 * 而 `DEFAULT_GOAL_CONFIG.defaultTokenBudget = 0`、`createGoal` 又把 0 转成 undefined
 * ——**默认配置下 tokensUsed 恒为 0**，四处展示（/goal status、reminder 注入、
 * GOAL_LIFECYCLE 日志、/goal budget 回显）全在报错数。
 *
 * 最尖锐的后果不是显示：用户跑到一半执行 `/goal budget 100k` 时，这 100k 会
 * **从 0 重新计**而不是从已消耗量算起。排查实测「设 100k 上限、实际花掉 780k」。
 *
 * 所以「记账」是无条件的事实采集，「门控」才依赖是否设了预算——两者解耦。
 */
export function accumulateGoalTokens(goal: GoalState, currentTurnUsage: TurnUsage): void {
  goal.tokensUsed +=
    currentTurnUsage.inputTokens +
    currentTurnUsage.outputTokens +
    (currentTurnUsage.cacheCreationTokens ?? 0);
}

/**
 * 检查目标预算状态，并累加本轮用量到 goal.tokensUsed。
 * 返回：
 * - "ok": 预算充足
 * - "warning": 已用 ≥85%（预警）
 * - "exceeded": 已用 ≥100%（耗尽）
 *
 * ⚠️ 本函数**自带累加**（保持既有调用方语义不变）。调用方若已自行调过
 * `accumulateGoalTokens`，**不得**再调本函数，否则同一轮用量入账两次、预算上限被腰斩。
 * goal-gate 的做法是「无条件 accumulate → 有预算才走这里的判定分支」，见该处注释。
 */
export function checkGoalBudget(
  goal: GoalState,
  currentTurnUsage: TurnUsage,
): "ok" | "warning" | "exceeded" {
  if (!goal.tokenBudget) {
    // 无预算也要记账：门控不生效 ≠ 不统计用量（F1）。
    accumulateGoalTokens(goal, currentTurnUsage);
    return "ok";
  }

  accumulateGoalTokens(goal, currentTurnUsage);

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
