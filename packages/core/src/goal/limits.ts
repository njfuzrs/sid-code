/**
 * Goal 硬约束检查 —— 每轮执行，与评估器解耦
 *
 * ## 为什么要跟评估器拆开（2026-11-16 事故）
 *
 * 改动前，token 记账 / 预算判定 / 轮次判定三件事都写在 `handleGoalGate` 里，而
 * `handleGoalGate` 只在 `isEndTurnLike` 分支被调用。于是**这三条确定性上限只在
 * 模型想停的那一轮才被检查**：一次会话里模型连续 119 轮 `tool_use` 空转轮询，
 * `goal.maxTurns=150` 与 `tokenBudget` 一次都没被读过，上限形同虚设。
 *
 * 拆开的判据很简单：
 * - 「还能不能继续」是**确定性事实**，每轮 AfterModel 之后都该判一次；
 * - 「该不该继续」是**语义判断**（目标达没达成），只在模型想停时才有信息量。
 *
 * 把语义判断摊到每轮会让评估器（一次真实模型调用，实测 `evalTokensUsed≈6.7k`）
 * 每轮跑一遍；而把确定性事实绑在语义判断上则会让上限彻底失效。所以两者分开。
 *
 * ## 调用方约定（写错会造成真实损失）
 *
 * 1. **只调本函数，不要再调 `accumulateGoalTokens`**：`checkGoalBudget` 自带累加
 *    （见 budget.ts 文件头警告），叠加会让同一轮用量入账两次、预算上限被腰斩。
 * 2. 本函数会改 `goal` 对象（记账、`budgetWarningEmitted`），但**不改 `status`** ——
 *    终态由调用方写，因为「写哪个 status」属于主循环的收尾决策，不属纯检查。
 */

import type { GoalState } from "./state.ts";
import { checkGoalBudget } from "./budget.ts";
import type { TurnUsage } from "./budget.ts";

/**
 * 硬约束检查结果。
 *
 * `budget_warning` 是**非终态**：预算进了告警档但还没耗尽，模型应照常继续工作，
 * 调用方只负责在 `firstNotice` 为真时注入一次提醒。
 */
export type GoalHardLimitResult =
  | { kind: "ok" }
  | { kind: "budget_warning"; firstNotice: boolean }
  | { kind: "budget_limited" }
  | { kind: "turns_limited" };

/**
 * 每轮检查 goal 的确定性上限（token 记账 + 预算 + 轮次）。
 *
 * 顺序刻意与旧的 `handleGoalGate` 一致（预算先于轮次）：预算耗尽有自己的处置
 * （调 `/goal budget`），轮次耗尽调 `/goal turns`，两条归因不能粘在一起。
 *
 * @param goal 目标状态（会被就地记账，并置 `budgetWarningEmitted`）
 * @param turnUsage 本轮的 usage（调用方从 `response.usage` 取，口径见 §3.4 调查）
 */
export function checkGoalHardLimits(goal: GoalState, turnUsage: TurnUsage): GoalHardLimitResult {
  // ① 记账 + ② 预算判定。checkGoalBudget **自带累加**，这里绝不能再调
  // accumulateGoalTokens —— 那是 budget.ts 文件头点名的「上限被腰斩」路径。
  const budgetStatus = checkGoalBudget(goal, turnUsage);

  if (goal.tokenBudget && budgetStatus === "exceeded") {
    return { kind: "budget_limited" };
  }

  // ③ 轮次上限。`turnsUsed` 在**发请求前**自增（loop.ts 的 reminder 段），
  // 所以 `>=` 的语义是「第 maxTurns 轮的请求已经发出并返回，不再发起新的一轮」，
  // 与主循环 `state.turnCount < state.maxTurns` 同口径。
  if (goal.turnsUsed >= goal.maxTurns) {
    return { kind: "turns_limited" };
  }

  if (goal.tokenBudget && budgetStatus === "warning") {
    // 只在首次跨过告警档时提示一次：ratio 一旦 ≥85% 就每轮都会返回 warning，
    // 不去重等于每轮往对话里塞一条同样的提醒。
    const firstNotice = !goal.budgetWarningEmitted;
    goal.budgetWarningEmitted = true;
    return { kind: "budget_warning", firstNotice };
  }

  return { kind: "ok" };
}

/** 构建轮次耗尽的收尾提示（与 buildBudgetLimitMessage 同构，避免模型把两件事混为一谈）。 */
export function buildGoalTurnsLimitMessage(goal: GoalState): string {
  return `<system-reminder>
[Goal 轮次耗尽]
目标: ${goal.objective}
已用: ${goal.turnsUsed} / ${goal.maxTurns} 轮

轮次预算已用尽，请在本轮内：
1. 总结已完成的进度
2. 列出未完成的部分
3. 给出明确的"下一步"建议（用户可据此决定是否继续）

不要开始新的实质性工作。
</system-reminder>`;
}

/**
 * 强制总结轮的提示文本（goal 到上限时进主循环的强制总结出口）。
 *
 * 刻意与 `buildBudgetLimitMessage` / `buildGoalTurnsLimitMessage` 分开：那两个进**对话**
 * 告诉模型该收尾了，这一条是**总结轮自己的请求提示**，措辞要说明是哪种预算用尽
 * （否则模型会写成「轮数不够，下一轮继续」，而下一轮根本不会发生），并给出对应的
 * `/goal` 调整出口。
 */
export function buildGoalLimitSummaryPrompt(
  goal: GoalState | undefined,
  source: "turns" | "budget",
): string {
  const reason =
    source === "turns"
      ? `目标的轮次预算已用尽${goal ? `（${goal.turnsUsed} / ${goal.maxTurns} 轮，用户可用 /goal turns <n> 调整）` : ""}`
      : `目标的 token 预算已用尽${goal ? `（已用 ${goal.tokensUsed.toLocaleString()} / ${(goal.tokenBudget ?? 0).toLocaleString()} tokens，用户可用 /goal budget <n> 调整）` : ""}`;
  return `${reason}，无法继续调用工具。请立即总结你目前为止的所有发现和已完成的工作，以及尚未完成的部分，用结构化格式（列表/表格）呈现。不要再调用任何工具。`;
}
