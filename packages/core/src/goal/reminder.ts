/**
 * Goal Reminder — 目标状态周期性注入
 *
 * 对标 Codex 的 continuation.md——每隔 N 轮向主模型注入目标状态，保持目标意识。
 * 通过 reminderParts[] 管道注入，不影响 system prompt → Prompt Cache 命中率不变。
 */

import type { GoalState } from "./state.ts";
import type { WaitSource } from "../task/wait-registry.ts";
import { describeWaitLine } from "../task/wait-registry.ts";
import { GOAL_TURNS_NEAR_LIMIT_RATIO } from "./config.ts";

/**
 * 本轮是否该发「接近轮次上限」的软提醒（每轮调用，只在首次越过阈值时为真）。
 *
 * 刻意做成**纯判定**（不改 `goal`）：置位交给调用方，测试才能把「判定」与
 * 「副作用」分开断言 —— 判定错了和置位漏了是两种不同的 bug。
 *
 * 三个条件缺一不可：
 * - 没发过（`softLimitWarned`）：否则只要还在 80% 以上就每轮刷一条同样的提醒；
 * - 有上限（`maxTurns > 0`）：0/负数表示「不设上限」的退化输入，不能触发；
 * - 越过阈值（`>= ratio`）：与 cli 状态栏变黄的判据共用同一个常量。
 */
export function shouldWarnNearTurnLimit(goal: GoalState): boolean {
  if (goal.softLimitWarned) return false;
  if (goal.maxTurns <= 0) return false;
  return goal.turnsUsed >= goal.maxTurns * GOAL_TURNS_NEAR_LIMIT_RATIO;
}

/**
 * 构建「接近轮次上限」软提醒。
 *
 * 为什么要有这条：`maxTurns` 从 150 放宽到 300 后，如果不在 80% 处告诉模型，
 * 上限翻倍只是把「毫无自知地跑到被掐断」的成本也翻倍。提醒的核心是**逼出一次
 * 显式取舍**（哪些必须做完、哪些承认做不完），而不是催它快点。
 */
export function buildNearTurnLimitReminder(goal: GoalState): string {
  const usedPct = Math.round((goal.turnsUsed / goal.maxTurns) * 100);
  const remaining = Math.max(goal.maxTurns - goal.turnsUsed, 0);
  return `<system-reminder>
[Goal 轮次提醒 — 已用 ${goal.turnsUsed}/${goal.maxTurns} 轮（${usedPct}%）]

目标: ${goal.objective}

轮次预算已用掉 ${usedPct}%，剩余 ${remaining} 轮。到上限后任务会被强制收尾
（turns_limited），无法再调用工具。请据此调整节奏：
- 优先完成"没有它目标就算没达成"的核心部分，把可延后的部分明确列为未完成；
- 每步都在对话里留下可验证的输出（命令结果、测试结果），评估者只能看到这些；
- 如果判断剩余轮次不够，现在就如实报告进度与缺口并给出后续建议，
  不要拖到最后一轮才发现来不及。

（这只是提醒，不会终止任务；用户可用 /goal turns <n> 调整上限。）
</system-reminder>`;
}

/**
 * 构建目标状态 reminder（注入到 reminderParts）。
 *
 * G5（2026-11-16）：`waitingSources` 非空时换成「等待版」文案。
 *
 * 要修的缺陷：旧文案无条件写「继续推进目标」，模型挂着 monitor / wait_until 等 CI 时
 * 读到它，会理解成「不能停下来等」→ 回到前台反复 `gh pr checks` 空转。等待原语的回执
 * 明明说了「结果会以通知送达」，两边口径矛盾，模型只能猜。
 *
 * 判据必须是**显式声明**的外部等待（`isDeclaredExternalWait`，与 goal-gate 的 G2 同源）：
 * 派生子代理 / 普通后台 shell 承诺的是「自己结束时回报」，不构成「目标在等外部状态」
 * 的证据，拿 `hasPromisedWait` 当判据会把「起了一个无关的 bun test」也算成在等。
 *
 * 为什么不在这里自己读注册表：本模块保持纯函数（只依赖入参），副作用留在 loop.ts，
 * 与 `query/wait-only-state.ts` 同一分层。调用频率上也不需要额外节流——注入本身已受
 * `reminderInterval` 约束（默认每 4 轮），不是每轮重发。
 */
export function buildGoalReminder(
  goal: GoalState,
  opts?: {
    /**
     * G5：当前有效的**显式外部**等待源（调用方传 `listWaits().filter(isDeclaredExternalWait)`）。
     */
    waitingSources?: WaitSource[];
  },
): string {
  const budgetLine = goal.tokenBudget
    ? `Token: ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()}`
    : `Token: ${goal.tokensUsed.toLocaleString()}（无预算限制）`;

  const head = `<goal-status>
目标: ${goal.objective}
状态: ${goal.status} | 轮次: ${goal.turnsUsed}/${goal.maxTurns} | ${budgetLine}
${goal.lastEvalReason ? `上次评估: ${goal.lastEvalReason}` : ""}
</goal-status>`;

  const waiting = opts?.waitingSources ?? [];
  if (waiting.length > 0) {
    // 等待版：这些事之所以没完成，是因为外部状态还没变。催它「继续推进」只会换来
    // 一轮状态空查（正是 P1 守卫要拦的形态），所以把祈使句换成「怎么等」。
    return `${head}

目标依赖外部状态，当前在等：
${waiting.map((w) => `- ${describeWaitLine(w)}`).join("\n")}

等待期间：挂着等待**结束本轮**是合法推进，不是偷懒——等待源回报时会把主循环叫醒。注意：
- 不要为了「显得在推进」反复查询同一个状态（重复跑 \`gh pr checks\` / \`git status\` 之类），那是空转
- 如果还有别的可推进的事，先做那些，不必原地等
- 每次操作后确认结果（跑测试、检查输出），评估者只能看到你输出的内容
- 若某条路走不通，换方向而不是反复重试`;
  }

  return `${head}

继续推进目标。注意：
- 每次操作后确认结果（跑测试、检查输出），评估者只能看到你输出的内容
- 不要假设操作成功——验证它
- 若某条路走不通，换方向而不是反复重试
- 如果下一步取决于外部状态（CI 跑完 / PR 合并 / 部署 / 别人 review），**等待也是推进**：
  用 monitor、\`bash --wait_until_seconds\` 或 schedule_wakeup 把等待挂上，然后结束本轮，
  等待源回报时会把主循环叫醒——不要在前台反复查询状态`;
}

/**
 * 构建首轮目标 prompt（/goal set 时注入）。
 *
 * G5（2026-11-16）：旧版写「在满足上述条件之前，系统不会让你停止」。这句话一半真一半假：
 * goal gate 确实会在 end_turn 时评估并推回继续，但**挂着等待源结束本轮是放行的**（G2）。
 * 模型照字面理解成「不能停下来」，于是宁可前台轮询也不敢收尾——把「等」误当成「没在推进」。
 * 现在把两件事分开说清楚，并给出等待原语的具体名字。
 */
export function buildFirstTurnPrompt(goal: GoalState): string {
  return `<goal>
${goal.objective}
</goal>

你现在有一个持续执行目标。两条边界先说清楚：
- 目标未达成时结束本轮，会被评估一次并推回继续——所以不要把「停下来」当成完成；
- 但如果目标在等外部状态（CI / 部署 / 别人 review），挂上等待后结束本轮不会被打回，那是合法推进（见下面第 5 条）。

工作方式：
0. 先验证当前状态（跑测试/检查错误数/确认文件存在），确认 baseline
1. 分析目标，制定计划
2. 逐步执行，每步验证结果
3. 确保关键操作的输出对话中可见（测试结果、命令输出等）——评估者需要看到证据
4. 若某条路走不通，换方向尝试
5. 等待也是推进：当下一步取决于外部状态时，不要在前台反复查询状态——用 monitor、\`bash --wait_until_seconds\`
   或 schedule_wakeup 把等待挂上，然后结束本轮。等待源回报时会把主循环叫醒。

现在开始工作。先执行第 0 步：验证当前状态。`;
}

/** 构建恢复轮 prompt（/goal resume 时注入） */
export function buildResumeTurnPrompt(goal: GoalState): string {
  return `<goal-resume>
你正在恢复一个未完成的目标（上次在第 ${goal.turnsUsed} 轮中断）。

目标: ${goal.objective}
${goal.lastEvalReason ? `上次评估反馈: ${goal.lastEvalReason}` : ""}

请从当前状态继续工作。先检查当前文件系统/项目状态，确认进度，然后继续推进。
如果下一步取决于外部状态（CI / 部署 / 别人 review），先挂上显式等待再收尾，不要前台反复轮询。
</goal-resume>`;
}
