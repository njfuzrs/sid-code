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
          // P1-3: 记录本次评估器调用消耗的 token（evalResult 可能尚未赋值，延迟读取）
          evalTokensUsed: (extra as any)?.evalTokensUsed ?? 0,
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
  const conversationContext = extractEvalContext(messages, goalConfig.evalContextMaxChars);
  // P1-1: Goal Gate 只在 end_turn 处理链触发，故 stopReason 恒为 "end_turn"。
  // 取最后一条 assistant 消息的文本长度供报告型 fast-path 判据。
  const lastAssistantTextLength = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") continue;
      let len = 0;
      for (const block of messages[i].content) {
        if (block.type === "text" && block.text.trim()) len += block.text.length;
      }
      return len;
    }
    return 0;
  })();
  let evalResult: GoalEvalResult;
  try {
    evalResult = await evaluateGoal(goal, conversationContext, evalConfig, {
      stopReason: "end_turn",
      assistantTextLength: lastAssistantTextLength,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn("GOAL_GATE", `评估者调用失败（未被 evaluateGoal 捕获的异常）: ${msg}`);
    evalResult = {
      satisfied: false,
      reason: "（评估器暂时不可用，继续工作）",
      progress: undefined,
      blockerKey: "__evaluator_unavailable__",
    };
  }

  // P0-1/P1-2: 评估器降级时（blockerKey=__evaluator_unavailable__）推 warning 到 TUI。
  // 文案必须随 isGoalHardStopEnabled() 分支：默认（降级模式）达阈值后不会放行，只会持续
  // 注入软提醒直到 maxTurns/budget 兜底——若沿用「第 N 次将自动放行」文案会误导用户。
  if (evalResult.blockerKey === "__evaluator_unavailable__") {
    const failCount = blockedDetector["recentBlockerKeys"].filter(k => k === "__evaluator_unavailable__").length + 1;
    const text = isGoalHardStopEnabled()
      ? `⚠️ Goal 评估器连续失败 ${failCount}/${goalConfig.blockedThreshold} 次，第 ${goalConfig.blockedThreshold} 次将自动放行。可 /goal clear 手动结束。`
      : `⚠️ Goal 评估器连续失败 ${failCount}/${goalConfig.blockedThreshold} 次，将持续提醒模型自行决定收尾（由轮次/预算上限兜底）。可 /goal clear 手动结束。`;
    systemMessages.push({ level: "warning", text });
  }

  // 5. 目标不可能达成
  if (evalResult.impossible) {
    if (isGoalHardStopEnabled()) {
      // 硬停止模式（需 SID_ENABLE_GOAL_HARD_STOP=1 显式开启）：保留旧的"即终止"行为。
      goal.status = "impossible";
      log.warn("GOAL_GATE", `目标不可能达成（硬停止）: reason="${evalResult.reason}", turn=${goal.turnsUsed}`);
      systemMessages.push({ level: "warning", text: `Goal 被判定为不可能达成: ${evalResult.reason}` });
      emitTraceEvent("impossible", false, { evalReason: evalResult.reason, evalTokensUsed: evalResult.evalTokensUsed ?? 0 });
      return {
        result: { shouldContinue: false, completed: false, impossible: true, evalResult },
        injectMessages,
        systemMessages,
      };
    }
    // 默认（降级模式）：不终止，注入软提醒把判断交还模型，继续循环（由 maxTurns/budget 兜底）。
    goal.lastEvalReason = evalResult.reason;
    log.info("GOAL_GATE", `目标疑似不可能达成（降级为提醒，不终止）: reason="${evalResult.reason?.slice(0, 80)}", turn=${goal.turnsUsed}`);
    const impossibleReminder = buildImpossibleReminder(goal, evalResult);
    injectMessages.push({ role: "user", content: [{ type: "text", text: impossibleReminder }] });
    systemMessages.push({ level: "warning", text: `评估者认为目标可能无法达成（${evalResult.reason?.slice(0, 60)}），已提醒模型自行决定` });
    emitTraceEvent("impossible_soft", true, { evalReason: evalResult.reason, evalTokensUsed: evalResult.evalTokensUsed ?? 0 });
    return {
      result: { shouldContinue: true, completed: false, impossible: false, feedback: impossibleReminder, evalResult },
      injectMessages,
      systemMessages,
    };
  }

  // 6. 目标达成
  if (evalResult.satisfied) {
    goal.status = "complete";
    log.info("GOAL_GATE", `目标达成: reason="${evalResult.reason}", turn=${goal.turnsUsed}, progress=100`);
    systemMessages.push({ level: "info", text: `✓ 目标达成: ${evalResult.reason}` });
    emitTraceEvent("satisfied", false, { evalReason: evalResult.reason, progress: 100, evalTokensUsed: evalResult.evalTokensUsed ?? 0 });
    return {
      result: { shouldContinue: false, completed: true, impossible: false, evalResult },
      injectMessages,
      systemMessages,
    };
  }

  // 7. 未达成 → blocked 检测
  if (goalConfig.enableBlockedDetection && blockedDetector.record(evalResult.blockerKey)) {
    if (isGoalHardStopEnabled()) {
      // 硬停止模式（需 SID_ENABLE_GOAL_HARD_STOP=1 显式开启）：保留旧的"即暂停"行为。
      goal.status = "blocked";
      log.warn("GOAL_GATE", `blocked 检测触发（硬停止）: blockerKey="${evalResult.blockerKey}", threshold=${goalConfig.blockedThreshold}, turn=${goal.turnsUsed}`);
      systemMessages.push({
        level: "warning",
        text: `Goal 检测到卡住（连续 ${goalConfig.blockedThreshold} 轮相同阻塞原因: ${evalResult.blockerKey}），已暂停`,
      });
      emitTraceEvent("blocked", false, { blockerKey: evalResult.blockerKey, threshold: goalConfig.blockedThreshold, evalTokensUsed: evalResult.evalTokensUsed ?? 0 });
      return {
        result: { shouldContinue: false, completed: false, impossible: false, evalResult },
        injectMessages,
        systemMessages,
      };
    }
    // 默认（降级模式）：不终止，注入软提醒逼模型换思路，继续循环（由 maxTurns/budget 兜底）。
    // 注意：命中后 blockedDetector 内部计数不重置——若模型换路后仍卡在同一 blockerKey，
    // 下一轮会再次命中并再提醒一次，直到换出新 blockerKey（重置）或触及轮次/预算上限。
    goal.lastEvalReason = evalResult.reason;
    log.info("GOAL_GATE", `blocked 检测触发（降级为提醒，不终止）: blockerKey="${evalResult.blockerKey}", turn=${goal.turnsUsed}`);
    const blockedReminder = buildBlockedReminder(goal, evalResult.blockerKey, goalConfig.blockedThreshold);
    injectMessages.push({ role: "user", content: [{ type: "text", text: blockedReminder }] });
    systemMessages.push({
      level: "warning",
      text: `Goal 疑似卡住（连续 ${goalConfig.blockedThreshold} 轮相同阻塞原因），已提醒模型换思路`,
    });
    emitTraceEvent("blocked_soft", true, { blockerKey: evalResult.blockerKey, threshold: goalConfig.blockedThreshold, evalTokensUsed: evalResult.evalTokensUsed ?? 0 });
    return {
      result: { shouldContinue: true, completed: false, impossible: false, feedback: blockedReminder, evalResult },
      injectMessages,
      systemMessages,
    };
  }

  // 8. 未达成 → 注入反馈 + continue
  goal.lastEvalReason = evalResult.reason;
  log.info("GOAL_GATE", `决策: shouldContinue=true, progress=${evalResult.progress ?? "?"}, reason="${evalResult.reason?.slice(0, 80)}", turn=${goal.turnsUsed}`);
  emitTraceEvent("continue", true, { progress: evalResult.progress, evalReason: evalResult.reason?.slice(0, 200), blockerKey: evalResult.blockerKey, evalTokensUsed: evalResult.evalTokensUsed ?? 0 });
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

/**
 * 目标"硬停止"是否启用（默认关闭 = 降级为"提醒 + 继续"）。
 *
 * 为什么默认把 blocked/impossible 从"终止"降为"提醒"（2026-07-07 决策，
 * 约束型误伤排查清单 §3.5 #7 + §8）：
 * - blocked 判据是"连续 N 轮相同 blockerKey"，但这未必真卡住——模型可能正稳步攻克
 *   同一个难点，评估者却因表层现象相同持续报同一 blockerKey，于是把"正在攻坚"误判成
 *   "卡死"直接终止整个 /goal 任务。
 * - impossible 是评估者 LLM 的主观判定，本身有误判风险；一次误判就终止，代价过重。
 * - 二者拦的都是"模型可能走的弯路"而非"不可逆危害"，且已有 maxTurns / tokenBudget 双重
 *   硬上限兜底、用户可随时 ESC 介入。让评估者的"卡住/不可能"判断从"替用户拍板终止"降为
 *   "把判断告知模型、让它自己决定换路还是收尾"，更符合"信任模型能力"的设计哲学。
 *
 * 代码不删、仅默认降级（env 门控可逆）：SID_ENABLE_GOAL_HARD_STOP=1 可恢复旧的
 * "blocked/impossible 即终止"行为（例如批处理/无人值守场景希望尽早止损）。
 */
export function isGoalHardStopEnabled(): boolean {
  return process.env.SID_ENABLE_GOAL_HARD_STOP === "1";
}

/** 构造 impossible 软提醒（降级模式下注入，让模型自己决定换路/收尾，而非直接终止）。 */
function buildImpossibleReminder(goal: GoalState, evalResult: GoalEvalResult): string {
  return `<system-reminder>
[Goal 评估提示 — 第 ${goal.turnsUsed} 轮 / 最多 ${goal.maxTurns} 轮]

目标条件: ${goal.objective}

评估者认为当前目标可能无法达成，理由：${evalResult.reason}

这只是评估者的判断，可能不准。请你自己决定下一步：
- 如果确实无法达成，明确向用户说明原因和已尝试过的路径，然后收尾；
- 如果你判断仍有别的思路没试过，换一种方法继续推进；
- 不要因为这条提示就机械放弃一个其实还能推进的目标。
（已达最大轮次或预算耗尽时会自动停止，用户也可随时介入。）
</system-reminder>`;
}

/** 构造 blocked 软提醒（降级模式下注入，让模型换思路，而非直接终止）。 */
function buildBlockedReminder(goal: GoalState, blockerKey: string | undefined, threshold: number): string {
  return `<system-reminder>
[Goal 卡住提示 — 第 ${goal.turnsUsed} 轮 / 最多 ${goal.maxTurns} 轮]

目标条件: ${goal.objective}

评估者连续 ${threshold} 轮报告相同的阻塞原因${blockerKey ? `（${blockerKey}）` : ""}，你可能在同一处反复受阻。
请换一种思路：
- 回顾前几轮到底卡在哪，不要重复已经失败的同一操作；
- 尝试从不同角度切入，或用不同工具去验证假设；
- 如果确实无法突破，明确说明卡点和已尝试的路径，再决定是否收尾。
（这只是提示，不会强制终止；达最大轮次或预算耗尽时会自动停止，用户也可随时介入。）
</system-reminder>`;
}
