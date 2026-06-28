/**
 * Goal Gate — end_turn 拦截
 *
 * Goal Gate 是 queryLoop 中 end_turn 处理链的最后一环。
 * 只有前三道 Gate（Stop Hook → Todo → Hypothesis）全部放行，才轮到 Goal Gate 做最终判定。
 */

import type { GoalState } from "../goal/state.ts";
import type { GoalEvalResult, EvalConfig } from "../goal/evaluator.ts";
import type { Message } from "../llm/types.ts";
import { evaluateGoal, extractEvalContext } from "../goal/evaluator.ts";
import { checkGoalBudget, buildBudgetLimitMessage, buildBudgetWarningMessage } from "../goal/budget.ts";
import type { TurnUsage } from "../goal/budget.ts";
import { BlockedDetector } from "../goal/blocked-detector.ts";
import { DEFAULT_GOAL_CONFIG } from "../goal/config.ts";
import type { GoalConfig } from "../goal/config.ts";
import { getLogger } from "../debug/logger.ts";

const log = getLogger();

// ─── 类型定义 ───

export interface GoalGateResult {
  /** 是否应该继续循环 */
  shouldContinue: boolean;
  /** 目标是否已完成 */
  completed: boolean;
  /** 目标是否被判定为不可能 */
  impossible: boolean;
  /** 反馈消息（注入下一轮） */
  feedback?: string;
  /** 评估结果 */
  evalResult?: GoalEvalResult;
}

export interface GoalGateContext {
  goal: GoalState;
  messages: Message[];
  turnUsage: TurnUsage;
  evalConfig: EvalConfig;
  goalConfig?: GoalConfig;
  blockedDetector: BlockedDetector;
  /** Trace 事件写入（可选——未注入则不写 trace） */
  traceAppendEvent?: (event: { event: string; session_id: string; timestamp: string; data?: Record<string, unknown> }) => void;
  sessionId?: string;
}

// ─── 核心逻辑 ───

/**
 * 处理 Goal Gate 逻辑，返回是否应该继续循环。
 * 不使用 AsyncGenerator（简化集成），直接返回结果 + 副作用消息。
 */
export async function handleGoalGate(ctx: GoalGateContext): Promise<{
  result: GoalGateResult;
  /** 需要注入到对话中的消息（反馈/预警/预算耗尽） */
  injectMessages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>;
  /** 需要显示给用户的系统消息 */
  systemMessages: Array<{ level: "info" | "warning"; text: string }>;
}> {
  const { goal, messages, turnUsage, evalConfig, goalConfig = DEFAULT_GOAL_CONFIG, blockedDetector, traceAppendEvent, sessionId } = ctx;
  const injectMessages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }> = [];
  const systemMessages: Array<{ level: "info" | "warning"; text: string }> = [];

  /** 写入 GoalGateDecision trace 事件 */
  const emitTraceEvent = (reason: string, shouldContinue: boolean, extra?: Record<string, unknown>) => {
    if (!traceAppendEvent || !sessionId) return;
    try {
      traceAppendEvent({
        event: "GoalGateDecision",
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        data: {
          goalId: goal.id,
          turn: goal.turnsUsed,
          shouldContinue,
          reason,
          objective: goal.objective.slice(0, 200),
          status: goal.status,
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget,
          ...extra,
        },
      });
    } catch { /* trace 写入失败不阻断 */ }
  };

  // 1. 预算检查（在评估之前，省下评估调用费用）
  if (goal.tokenBudget) {
    const budgetStatus = checkGoalBudget(goal, turnUsage);
    if (budgetStatus === "exceeded") {
      goal.status = "budget_limited";
      log.warn("GOAL_GATE", `预算耗尽: used=${goal.tokensUsed}, budget=${goal.tokenBudget}, 停止循环`);
      injectMessages.push({
        role: "user",
        content: [{ type: "text", text: buildBudgetLimitMessage(goal) }],
      });
      systemMessages.push({ level: "warning", text: "Goal 预算耗尽，进入收尾模式" });
      emitTraceEvent("budget_exceeded", false, { budgetRatio: goal.tokensUsed / goal.tokenBudget });
      return {
        result: { shouldContinue: false, completed: false, impossible: false },
        injectMessages,
        systemMessages,
      };
    }
    if (budgetStatus === "warning") {
      log.info("GOAL_GATE", `预算预警: ratio=${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}%`);
      injectMessages.push({
        role: "user",
        content: [{ type: "text", text: buildBudgetWarningMessage(goal) }],
      });
      systemMessages.push({ level: "warning", text: `Goal 预算预警 (${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}%)` });
    }
  }

  // 2. 轮次检查
  if (goal.turnsUsed >= goal.maxTurns) {
    goal.status = "turns_limited";
    log.warn("GOAL_GATE", `轮次耗尽: turns=${goal.turnsUsed}/${goal.maxTurns}, 停止循环`);
    systemMessages.push({ level: "warning", text: `Goal 已达最大轮次 (${goal.maxTurns})` });
    emitTraceEvent("turns_limited", false);
    return {
      result: { shouldContinue: false, completed: false, impossible: false },
      injectMessages,
      systemMessages,
    };
  }

  // 3. 前 N 轮跳过评估（模型刚开始，不可能已完成）
  if (goal.turnsUsed < evalConfig.minTurnsBeforeEval) {
    log.debug("GOAL_GATE", `前 ${evalConfig.minTurnsBeforeEval} 轮跳过评估（当前第 ${goal.turnsUsed} 轮）`);
    emitTraceEvent("eval_skipped", true);
    return {
      result: { shouldContinue: true, completed: false, impossible: false },
      injectMessages,
      systemMessages,
    };
  }

  // 4. 调用独立评估者
  const conversationContext = extractEvalContext(messages);
  let evalResult: GoalEvalResult;
  try {
    evalResult = await evaluateGoal(goal, conversationContext, evalConfig);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn("GOAL_GATE", `评估者调用失败: ${msg}`);
    evalResult = {
      satisfied: false,
      reason: "（评估器暂时不可用，继续工作）",
      progress: undefined,
    };
  }

  // 5. 目标不可能达成
  if (evalResult.impossible) {
    goal.status = "impossible";
    log.warn("GOAL_GATE", `目标不可能达成: reason="${evalResult.reason}", turn=${goal.turnsUsed}`);
    systemMessages.push({ level: "warning", text: `Goal 被判定为不可能达成: ${evalResult.reason}` });
    emitTraceEvent("impossible", false, { evalReason: evalResult.reason });
    return {
      result: { shouldContinue: false, completed: false, impossible: true, evalResult },
      injectMessages,
      systemMessages,
    };
  }

  // 6. 目标达成
  if (evalResult.satisfied) {
    goal.status = "complete";
    log.info("GOAL_GATE", `目标达成: reason="${evalResult.reason}", turn=${goal.turnsUsed}, progress=100`);
    systemMessages.push({ level: "info", text: `✓ 目标达成: ${evalResult.reason}` });
    emitTraceEvent("satisfied", false, { evalReason: evalResult.reason, progress: 100 });
    return {
      result: { shouldContinue: false, completed: true, impossible: false, evalResult },
      injectMessages,
      systemMessages,
    };
  }

  // 7. 未达成 → blocked 检测
  if (goalConfig.enableBlockedDetection && blockedDetector.record(evalResult.blockerKey)) {
    goal.status = "blocked";
    log.warn("GOAL_GATE", `blocked 检测触发: blockerKey="${evalResult.blockerKey}", threshold=${goalConfig.blockedThreshold}, turn=${goal.turnsUsed}`);
    systemMessages.push({
      level: "warning",
      text: `Goal 检测到卡住（连续 ${goalConfig.blockedThreshold} 轮相同阻塞原因: ${evalResult.blockerKey}），已暂停`,
    });
    emitTraceEvent("blocked", false, { blockerKey: evalResult.blockerKey, threshold: goalConfig.blockedThreshold });
    return {
      result: { shouldContinue: false, completed: false, impossible: false, evalResult },
      injectMessages,
      systemMessages,
    };
  }

  // 8. 未达成 → 注入反馈 + continue
  goal.lastEvalReason = evalResult.reason;
  log.info("GOAL_GATE", `决策: shouldContinue=true, progress=${evalResult.progress ?? "?"}, reason="${evalResult.reason?.slice(0, 80)}", turn=${goal.turnsUsed}`);
  emitTraceEvent("continue", true, { progress: evalResult.progress, evalReason: evalResult.reason?.slice(0, 200), blockerKey: evalResult.blockerKey });
  const feedback = buildGoalGateFeedback(goal, evalResult);
  injectMessages.push({
    role: "user",
    content: [{ type: "text", text: feedback }],
  });

  systemMessages.push({
    level: "info",
    text: `目标未达成 (进度 ${evalResult.progress ?? "?"}%)，继续推进...`,
  });

  return {
    result: { shouldContinue: true, completed: false, impossible: false, feedback, evalResult },
    injectMessages,
    systemMessages,
  };
}

// ─── 反馈消息构造 ───

function buildGoalGateFeedback(goal: GoalState, evalResult: GoalEvalResult): string {
  return `<system-reminder>
[Goal 评估反馈 — 第 ${goal.turnsUsed} 轮 / 最多 ${goal.maxTurns} 轮]

目标条件: ${goal.objective}

评估结果: 未满足
原因: ${evalResult.reason}
${evalResult.progress != null ? `当前进度: ${evalResult.progress}%` : ""}

请继续推进目标。提示：
- 确保执行的命令输出可见（评估者只能看到对话中的内容）
- 如果遇到阻塞，尝试不同的方法而不是重复失败的操作
- 若确认目标无法达成，请明确说明原因
</system-reminder>`;
}
