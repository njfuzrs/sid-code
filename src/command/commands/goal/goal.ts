/**
 * /goal 命令实现
 *
 * 目标驱动持续执行：设定完成条件，AI 在达成前不停止。
 * 子命令：set(默认) / status / pause / resume / edit / budget / clear / cancel
 */

import type { LocalCommandModule, CommandContext } from "../../types.ts";
import type { LocalCommandResult } from "../../types.ts";
import { createGoal } from "../../../goal/state.ts";
import type { GoalState } from "../../../goal/state.ts";
import { buildFirstTurnPrompt, buildResumeTurnPrompt } from "../../../goal/reminder.ts";
import { DEFAULT_GOAL_CONFIG } from "../../../goal/config.ts";
import { getLogger } from "../../../debug/logger.ts";

const log = getLogger();
const MAX_OBJECTIVE_CHARS = 4000;

/** 记录 Goal 生命周期事件（结构化日志，方便后续分析/回放） */
function logLifecycle(action: string, goal: GoalState, extra?: Record<string, unknown>): void {
  log.info("GOAL_LIFECYCLE", `${action}: id=${goal.id}, objective="${goal.objective.slice(0, 60)}", status=${goal.status}, turns=${goal.turnsUsed}/${goal.maxTurns}, tokens=${goal.tokensUsed}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}, evidence=${goal.evidenceLog.length}`, { action, goalId: goal.id, ...extra });
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const trimmed = args.trim();

    // 子命令分发
    if (!trimmed || trimmed === "status") return showGoalStatus(ctx);
    if (trimmed === "pause") return pauseGoal(ctx);
    if (trimmed === "resume") return resumeGoal(ctx);
    if (trimmed === "clear" || trimmed === "cancel") return clearGoal(ctx);
    if (trimmed.startsWith("edit ")) return editGoal(trimmed.slice(5), ctx);
    if (trimmed.startsWith("budget ")) return setBudget(trimmed.slice(7), ctx);

    // 主流程：设置新目标
    return setGoal(trimmed, ctx);
  },
};

// ─── 子命令实现 ───

async function setGoal(objective: string, ctx: CommandContext): Promise<LocalCommandResult> {
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return {
      type: "text",
      value: `目标条件过长（${objective.length} 字符），最多 ${MAX_OBJECTIVE_CHARS} 字符。\n请精简完成条件，或拆分为多个子目标。`,
    };
  }

  // 检查是否已有活跃目标
  const existing = ctx.getGoalState?.();
  if (existing && existing.status === "active") {
    return {
      type: "confirm",
      message: `已有活跃目标: "${existing.objective.slice(0, 60)}${existing.objective.length > 60 ? "..." : ""}"\n替换为新目标？`,
      onConfirm: async () => doSetGoal(objective, ctx),
    };
  }

  return doSetGoal(objective, ctx);
}

async function doSetGoal(objective: string, ctx: CommandContext): Promise<LocalCommandResult> {
  // 合并用户 config.goal 与内置默认值（用户未配则全走默认）
  const goalCfg = { ...DEFAULT_GOAL_CONFIG, ...ctx.config?.goal };
  const goal = createGoal(objective, {
    tokenBudget: goalCfg.defaultTokenBudget || undefined,
    maxTurns: goalCfg.defaultMaxTurns,
  });

  // 注入到运行时
  ctx.setGoalState?.(goal);
  logLifecycle("create", goal);

  // 返回 submit_prompt，第一轮直接以目标作为指令
  return {
    type: "submit_prompt",
    prompt: buildFirstTurnPrompt(goal),
  };
}

function showGoalStatus(ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无活跃目标。使用 `/goal <完成条件>` 设置目标。" };
  }

  const statusEmoji: Record<string, string> = {
    active: "🎯",
    paused: "⏸️",
    blocked: "🚫",
    impossible: "❌",
    budget_limited: "💰",
    turns_limited: "⏱️",
    complete: "✓",
  };

  const budgetLine = goal.tokenBudget
    ? `预算: ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`
    : `已用: ${goal.tokensUsed.toLocaleString()} tokens（无预算限制）`;

  const evidenceLine = goal.evidenceLog.length > 0
    ? `证据: ${goal.evidenceLog.length} 条（最新: ${goal.evidenceLog[goal.evidenceLog.length - 1]!.summary.slice(0, 60)}）`
    : `证据: 暂无`;

  const lines = [
    `${statusEmoji[goal.status] || "?"} 目标状态: ${goal.status}`,
    ``,
    `条件: ${goal.objective}`,
    `轮次: ${goal.turnsUsed} / ${goal.maxTurns}`,
    budgetLine,
    evidenceLine,
    goal.lastEvalReason ? `上次评估: ${goal.lastEvalReason}` : "",
  ].filter(Boolean);

  return { type: "text", value: lines.join("\n") };
}

function pauseGoal(ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无活跃目标。" };
  }
  if (goal.status !== "active") {
    return { type: "text", value: `目标状态为 "${goal.status}"，无法暂停。` };
  }

  goal.status = "paused";
  ctx.updateGoalState?.((g: GoalState) => { g.status = "paused"; });
  logLifecycle("pause", goal);
  return { type: "text", value: `⏸️ 目标已暂停。使用 \`/goal resume\` 恢复。` };
}

function resumeGoal(ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无目标可恢复。" };
  }
  if (goal.status === "active") {
    return { type: "text", value: "目标正在活跃执行中，无需恢复。" };
  }
  if (goal.status === "complete") {
    return { type: "text", value: `目标已完成: "${goal.objective.slice(0, 60)}"` };
  }

  // 恢复目标
  goal.status = "active";
  ctx.updateGoalState?.((g: GoalState) => { g.status = "active"; });
  logLifecycle("resume", goal);

  return {
    type: "submit_prompt",
    prompt: buildResumeTurnPrompt(goal),
  };
}

function editGoal(newObjective: string, ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无目标可编辑。使用 `/goal <完成条件>` 设置新目标。" };
  }

  const trimmed = newObjective.trim();
  if (!trimmed) {
    return { type: "text", value: "请提供新的完成条件。用法: `/goal edit <新条件>`" };
  }
  if (trimmed.length > MAX_OBJECTIVE_CHARS) {
    return { type: "text", value: `目标条件过长（${trimmed.length} 字符），最多 ${MAX_OBJECTIVE_CHARS} 字符。` };
  }

  // 编辑目标：修改 objective，重置 evidenceLog + blockedDetector，状态恢复 active
  goal.objective = trimmed;
  goal.evidenceLog = [];
  goal.status = "active";
  goal.lastEvalReason = undefined;
  ctx.updateGoalState?.((g: GoalState) => {
    g.objective = trimmed;
    g.evidenceLog = [];
    g.status = "active";
    g.lastEvalReason = undefined;
  });
  logLifecycle("edit", goal, { newObjective: trimmed.slice(0, 200) });

  return { type: "text", value: `✏️ 目标已更新为: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}"\n证据日志已重置，继续推进新目标。` };
}

function setBudget(budgetStr: string, ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无活跃目标。请先用 `/goal <条件>` 设置目标。" };
  }

  const trimmed = budgetStr.trim();
  // 支持 "100k" / "100K" / "100000" 格式
  let budget: number;
  const kMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*[kK]$/);
  if (kMatch) {
    budget = Math.round(parseFloat(kMatch[1]!) * 1000);
  } else {
    budget = parseInt(trimmed, 10);
  }

  if (isNaN(budget) || budget <= 0) {
    return { type: "text", value: `无效的预算值: "${trimmed}"。请输入正整数（支持 "100k" 格式）。` };
  }

  goal.tokenBudget = budget;
  ctx.updateGoalState?.((g: GoalState) => { g.tokenBudget = budget; });
  logLifecycle("budget", goal, { newBudget: budget });
  return { type: "text", value: `💰 Token 预算已设为 ${budget.toLocaleString()}（已用 ${goal.tokensUsed.toLocaleString()}）` };
}

function clearGoal(ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无目标。" };
  }

  logLifecycle("clear", goal);
  ctx.setGoalState?.(null);
  return { type: "text", value: `目标已清除: "${goal.objective.slice(0, 60)}${goal.objective.length > 60 ? "..." : ""}"` };
}

export default mod;
