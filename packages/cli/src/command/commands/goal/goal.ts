/**
 * /goal 命令实现
 *
 * 目标驱动持续执行：设定完成条件，AI 在达成前不停止。
 * 子命令：set(默认) / status / pause / resume / edit / turns / budget / clear / cancel
 */

import type { LocalCommandModule, CommandContext } from "../../types.ts";
import type { LocalCommandResult } from "../../types.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import type { GoalState, GoalStatus } from "@sid-code/core/goal/state.ts";
import { buildFirstTurnPrompt, buildResumeTurnPrompt } from "@sid-code/core/goal/reminder.ts";
import { DEFAULT_GOAL_CONFIG } from "@sid-code/core/goal/config.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

const log = getLogger();
const MAX_OBJECTIVE_CHARS = 4000;
/** 轮次上限的合理区间：至少 1 轮，最多 1000 轮（防手滑输入天文数字导致真失控）。 */
const MIN_TURNS = 1;
const MAX_TURNS_LIMIT = 1000;

/**
 * 目标状态 → 中文文案（去彩色 emoji，改单色字形前缀 + 中文描述）。
 * 字形仅靠语义选取，与 figures.ts 的单色几何字形语言一致，不用 🎯⏸️🚫❌💰⏱️ 彩色 emoji。
 */
const STATUS_TEXT: Record<GoalStatus, string> = {
  active: "◎ 进行中",
  paused: "⏸ 已暂停",
  blocked: "⚠ 疑似卡住",
  impossible: "⚠ 疑似无法达成",
  budget_limited: "⚠ Token 预算已耗尽",
  turns_limited: "⚠ 已达最大轮次",
  complete: "✔ 已完成",
};

/** 记录 Goal 生命周期事件（结构化日志，方便后续分析/回放） */
function logLifecycle(action: string, goal: GoalState, extra?: Record<string, unknown>): void {
  log.info(
    "GOAL_LIFECYCLE",
    `${action}: id=${goal.id}, objective="${goal.objective.slice(0, 60)}", status=${goal.status}, turns=${goal.turnsUsed}/${goal.maxTurns}, tokens=${goal.tokensUsed}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}, evidence=${goal.evidenceLog.length}`,
    { action, goalId: goal.id, ...extra },
  );
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
    if (trimmed.startsWith("turns ")) return setMaxTurns(trimmed.slice(6), ctx);
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

  // 轮次行：明确标注这是"执行轮数"而非"完成进度"，避免用户误读。
  const turnsLine = `已用轮次: ${goal.turnsUsed} / ${goal.maxTurns}（每轮 = 一次"模型响应 + 工具执行"，是执行进度，不是完成度）`;

  const budgetLine = goal.tokenBudget
    ? `Token 预算: 已用 ${goal.tokensUsed.toLocaleString()} / 上限 ${goal.tokenBudget.toLocaleString()}`
    : `Token 用量: 已用 ${goal.tokensUsed.toLocaleString()}（未设预算上限）`;

  const evidenceLine =
    goal.evidenceLog.length > 0
      ? `证据: ${goal.evidenceLog.length} 条（最新: ${goal.evidenceLog[goal.evidenceLog.length - 1]!.summary.slice(0, 60)}）`
      : `证据: 暂无`;

  const lines = [
    `目标状态: ${STATUS_TEXT[goal.status] || goal.status}`,
    ``,
    `条件: ${goal.objective}`,
    turnsLine,
    budgetLine,
    evidenceLine,
    goal.lastEvalReason ? `上次评估: ${goal.lastEvalReason}` : "",
    ``,
    `提示: 达最大轮次或 Token 预算前，模型会持续推进直至目标达成；随时可按 ESC 介入，或用 /goal turns <n> 调整轮次上限、/goal pause 暂停。`,
  ].filter(Boolean);

  return { type: "text", value: lines.join("\n") };
}

function pauseGoal(ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无活跃目标。" };
  }
  if (goal.status !== "active") {
    return {
      type: "text",
      value: `目标状态为 "${STATUS_TEXT[goal.status] || goal.status}"，无法暂停。`,
    };
  }

  goal.status = "paused";
  ctx.updateGoalState?.((g: GoalState) => {
    g.status = "paused";
  });
  logLifecycle("pause", goal);
  return { type: "text", value: `⏸ 目标已暂停。使用 \`/goal resume\` 恢复。` };
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
  ctx.updateGoalState?.((g: GoalState) => {
    g.status = "active";
  });
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
    return {
      type: "text",
      value: `目标条件过长（${trimmed.length} 字符），最多 ${MAX_OBJECTIVE_CHARS} 字符。`,
    };
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

  return {
    type: "text",
    value: `✔ 目标已更新为: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}"\n证据日志已重置，继续推进新目标。`,
  };
}

/** /goal turns <n>：调整当前目标的最大轮次上限（运行时按需放宽/收紧）。 */
function setMaxTurns(turnsStr: string, ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无活跃目标。请先用 `/goal <条件>` 设置目标。" };
  }

  const trimmed = turnsStr.trim();
  const n = parseInt(trimmed, 10);
  if (isNaN(n) || String(n) !== trimmed) {
    return {
      type: "text",
      value: `无效的轮次值: "${trimmed}"。请输入正整数，例如 \`/goal turns 200\`。`,
    };
  }
  if (n < MIN_TURNS || n > MAX_TURNS_LIMIT) {
    return {
      type: "text",
      value: `轮次上限需在 ${MIN_TURNS}~${MAX_TURNS_LIMIT} 之间（输入了 ${n}）。`,
    };
  }
  if (n < goal.turnsUsed) {
    return {
      type: "text",
      value: `新上限 ${n} 小于已用轮次 ${goal.turnsUsed}，设置后会立即触发轮次超限。如确要收尾，请直接 \`/goal clear\`。`,
    };
  }

  const old = goal.maxTurns;
  goal.maxTurns = n;
  ctx.updateGoalState?.((g: GoalState) => {
    g.maxTurns = n;
  });
  logLifecycle("turns", goal, { oldMaxTurns: old, newMaxTurns: n });
  return { type: "text", value: `最大轮次已从 ${old} 调整为 ${n}（已用 ${goal.turnsUsed} 轮）。` };
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
    return {
      type: "text",
      value: `无效的预算值: "${trimmed}"。请输入正整数（支持 "100k" 格式）。`,
    };
  }

  goal.tokenBudget = budget;
  ctx.updateGoalState?.((g: GoalState) => {
    g.tokenBudget = budget;
  });
  logLifecycle("budget", goal, { newBudget: budget });
  return {
    type: "text",
    value: `Token 预算已设为 ${budget.toLocaleString()}（已用 ${goal.tokensUsed.toLocaleString()}）`,
  };
}

function clearGoal(ctx: CommandContext): LocalCommandResult {
  const goal = ctx.getGoalState?.();
  if (!goal) {
    return { type: "text", value: "当前无目标。" };
  }

  logLifecycle("clear", goal);
  ctx.setGoalState?.(null);
  return {
    type: "text",
    value: `目标已清除: "${goal.objective.slice(0, 60)}${goal.objective.length > 60 ? "..." : ""}"`,
  };
}

export default mod;
