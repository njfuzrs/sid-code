/**
 * Goal Reminder — 目标状态周期性注入
 *
 * 对标 Codex 的 continuation.md——每隔 N 轮向主模型注入目标状态，保持目标意识。
 * 通过 reminderParts[] 管道注入，不影响 system prompt → Prompt Cache 命中率不变。
 */

import type { GoalState } from "./state.ts";

/** 构建目标状态 reminder（注入到 reminderParts） */
export function buildGoalReminder(goal: GoalState): string {
  const budgetLine = goal.tokenBudget
    ? `Token: ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()}`
    : `Token: ${goal.tokensUsed.toLocaleString()}（无预算限制）`;

  return `<goal-status>
目标: ${goal.objective}
状态: ${goal.status} | 轮次: ${goal.turnsUsed}/${goal.maxTurns} | ${budgetLine}
${goal.lastEvalReason ? `上次评估: ${goal.lastEvalReason}` : ""}
</goal-status>

继续推进目标。注意：
- 每次操作后确认结果（跑测试、检查输出），评估者只能看到你输出的内容
- 不要假设操作成功——验证它
- 若某条路走不通，换方向而不是反复重试`;
}

/** 构建首轮目标 prompt（/goal set 时注入） */
export function buildFirstTurnPrompt(goal: GoalState): string {
  return `<goal>
${goal.objective}
</goal>

你现在有一个持续执行目标。在满足上述条件之前，系统不会让你停止。

工作方式：
0. 先验证当前状态（跑测试/检查错误数/确认文件存在），确认 baseline
1. 分析目标，制定计划
2. 逐步执行，每步验证结果
3. 确保关键操作的输出对话中可见（测试结果、命令输出等）——评估者需要看到证据
4. 若某条路走不通，换方向尝试

现在开始工作。先执行第 0 步：验证当前状态。`;
}

/** 构建恢复轮 prompt（/goal resume 时注入） */
export function buildResumeTurnPrompt(goal: GoalState): string {
  return `<goal-resume>
你正在恢复一个未完成的目标（上次在第 ${goal.turnsUsed} 轮中断）。

目标: ${goal.objective}
${goal.lastEvalReason ? `上次评估反馈: ${goal.lastEvalReason}` : ""}

请从当前状态继续工作。先检查当前文件系统/项目状态，确认进度，然后继续推进。
</goal-resume>`;
}
