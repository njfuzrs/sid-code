/**
 * Goal Gate — end_turn 拦截
 *
 * Goal Gate 是 queryLoop 中 end_turn 处理链的最后一环。
 * 只有前三道 Gate（Stop Hook → Todo → Hypothesis）全部放行，才轮到 Goal Gate 做最终判定。
 *
 * ## 职责边界（2026-11-16 拆分）
 *
 * 这里**只做语义评估**：「目标达成了吗、该不该继续」。
 * 「还能不能继续」——token 记账、预算上限、轮次上限——是确定性事实，已移到
 * `goal/limits.ts` 的 `checkGoalHardLimits`，由主循环**每轮**调用。
 *
 * 之前三者都在本文件，而本文件只在 `isEndTurnLike` 分支被调用，于是模型连续
 * `tool_use` 空转时 `maxTurns` / `tokenBudget` 一次都没被检查过（2026-11-16 事故）。
 * 把上限绑在「模型想停」上，等于上限不存在。
 */

import type { GoalState } from "../goal/state.ts";
import type { GoalEvalResult, EvalConfig } from "../goal/evaluator.ts";
import type { Message } from "../llm/types.ts";
import { evaluateGoal, extractEvalContext } from "../goal/evaluator.ts";
import { BlockedDetector } from "../goal/blocked-detector.ts";
import { DEFAULT_GOAL_CONFIG } from "../goal/config.ts";
import type { GoalConfig } from "../goal/config.ts";
import {
  decideWaitSuspend,
  MAX_CONSECUTIVE_WAIT_PASSES,
  type GoalWaitingFacts,
} from "./goal-waiting.ts";
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
  /**
   * G2（2026-11-16）：本轮因「等待挂起」放行。
   *
   * `shouldContinue=false` 但 goal **仍是 active** —— 语义是「本轮结束，等等待事件
   * 唤醒下一轮」，调用方**不得**按 completed / impossible / 「终止」处理（那会写终态、
   * 把 goal 关掉）。与 `blocked` 的区别是：这里模型没卡住，它只是唯一能做的事就是等。
   */
  waiting?: boolean;
  /** 等待挂起时命中的等待源 id（进回执与 trace 的 `wait_ids`） */
  waitIds?: string[];
}

export interface GoalGateContext {
  goal: GoalState;
  messages: Message[];
  evalConfig: EvalConfig;
  goalConfig?: GoalConfig;
  blockedDetector: BlockedDetector;
  /** Trace 事件写入（可选——未注入则不写 trace） */
  traceAppendEvent?: (event: {
    event: string;
    session_id: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }) => void;
  sessionId?: string;
  /**
   * 缺口7（轮次口径统一）：会话累计轮次（跨用户消息不归零）。
   * GoalGateDecision 的 `turn` 是 goal 内部计数（goal.turnsUsed），与 LoopState.turnCount
   * 同为消息内口径、跨消息回绕——离线分析"这条决策发生在会话哪一阶段"时不可靠。
   * absoluteTurn 让它与 hypothesis 各事件可比、可相减。可选：不注入则降级为不落该字段。
   */
  absoluteTurn?: number;
  /** 缺口7：第几条用户消息，让 turn 回绕可还原。可选，同 absoluteTurn。 */
  promptSeq?: number;
  /**
   * G2（2026-11-16）：等待挂起判据的外部事实，由调用方现算后传入。
   *
   * 之所以不让本模块自己去读 registry：`GoalGateContext` 的既有契约就是「事实由调用方
   * 现算、判定逻辑保持纯」（`blockedDetector`、`traceAppendEvent` 都是这个形状），
   * 单测因此可以直接构造「有显式等待 / 只有派生任务 / 有待投递通知」三种组合。
   * 不传 = 无等待态，行为与改动前逐字节一致（极简路径与既有测试不受影响）。
   */
  waiting?: GoalWaitingFacts;
}

/** GoalGateDecision 事件的最小上下文 —— 评估器路径与每轮硬约束路径共用同一份字段口径。 */
export interface GoalGateDecisionContext {
  goal: GoalState;
  traceAppendEvent?: GoalGateContext["traceAppendEvent"];
  sessionId?: string;
  absoluteTurn?: number;
  promptSeq?: number;
}

/**
 * 写一条 `GoalGateDecision` trace 事件。
 *
 * 抽出成模块级函数（而不是留在 `handleGoalGate` 闭包里）的原因：`goal/limits.ts` 的
 * 每轮硬约束检查也要落**同一形状**的事件。两条路径各写一份的话字段会分叉，
 * 而离线统计是按 `reason` 与字段名分桶的——分叉之后「goal 为什么停」再也对不上账。
 */
export function emitGoalGateDecision(
  ctx: GoalGateDecisionContext,
  reason: string,
  shouldContinue: boolean,
  extra?: Record<string, unknown>,
): void {
  const { goal, traceAppendEvent, sessionId, absoluteTurn, promptSeq } = ctx;
  if (!traceAppendEvent || !sessionId) return;
  try {
    traceAppendEvent({
      event: "GoalGateDecision",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      data: {
        goalId: goal.id,
        // 缺口7：`turn`（goal.turnsUsed）是消息内口径、跨消息回绕，与 hypothesis
        // 各事件不可直接比较/相减。absoluteTurn（会话累计）补齐后，"这条决策发生在
        // 会话哪一阶段"才可跨消息还原。两字段都可选——不注入则降级为不落，不阻断。
        ...(typeof absoluteTurn === "number" ? { turn: absoluteTurn } : { turn: goal.turnsUsed }),
        ...(typeof absoluteTurn === "number" ? { absoluteTurn } : {}),
        ...(typeof promptSeq === "number" ? { promptSeq } : {}),
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
  } catch {
    /* trace 写入失败不阻断 */
  }
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
  const {
    goal,
    messages,
    evalConfig,
    goalConfig = DEFAULT_GOAL_CONFIG,
    blockedDetector,
    // G2（2026-11-16）：等待挂起判据的外部事实（不传 = 无等待态，旧行为）
    waiting,
  } = ctx;
  const injectMessages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }> =
    [];
  const systemMessages: Array<{ level: "info" | "warning"; text: string }> = [];

  // 字段口径与 `goal/limits.ts` 的每轮硬约束路径共用同一个发射函数（见 emitGoalGateDecision）。
  const emitTraceEvent = (
    reason: string,
    shouldContinue: boolean,
    extra?: Record<string, unknown>,
  ) => emitGoalGateDecision(ctx, reason, shouldContinue, extra);

  // 1. 前 N 轮跳过评估（模型刚开始，不可能已完成）
  if (goal.turnsUsed < evalConfig.minTurnsBeforeEval) {
    log.debug(
      "GOAL_GATE",
      `前 ${evalConfig.minTurnsBeforeEval} 轮跳过评估（当前第 ${goal.turnsUsed} 轮）`,
    );
    emitTraceEvent("eval_skipped", true);
    return {
      result: { shouldContinue: true, completed: false, impossible: false },
      injectMessages,
      systemMessages,
    };
  }

  // 3.5 等待挂起（G2，2026-11-16）
  //
  // 模型挂上显式等待源（monitor / wait_until / schedule_wakeup）后 end_turn 是在**等**，
  // 不是「以为做完了」。此时调评估器只会得到「未达成，继续推进」，把模型打回下一轮
  // 去重复查询状态（P1 守卫要拦的同一件事），还额外烧一次评估调用。
  //
  // 位置在前 N 轮跳过评估之后：那是「模型刚开始、本来就不评估」的分支，优先级更高；
  // 也在预算 / 轮次两个硬上限之后：那两条是终止语义，等待不该豁免它们。
  const waitSuspend = decideWaitSuspend(goal, waiting);
  goal.waitPass = waitSuspend.nextWaitPass;
  if (waitSuspend.release) {
    log.info(
      "GOAL_GATE",
      `等待挂起: wait_ids=${waitSuspend.waitIds.join(",") || "(通知)"}, 连续第 ${waitSuspend.count}/${MAX_CONSECUTIVE_WAIT_PASSES} 次放行`,
    );
    systemMessages.push({
      level: "info",
      text: `⏸ 目标等待中（${waitSuspend.count}/${MAX_CONSECUTIVE_WAIT_PASSES}）：本轮结束，等待事件到达后自动续跑`,
    });
    // trace 字段名按修复方案 §4.2 用 `wait_ids`：离线分析要能按等待源对账
    // 「这次 end_turn 是为了等谁」，与 `WaitReleased` 的 id 口径一致。
    emitTraceEvent("waiting", false, {
      wait_ids: waitSuspend.waitIds,
      wait_pass_count: waitSuspend.count,
      // C2（2026-11-17）：纯通知场景下 `wait_ids` 是空数组，单看它分不清
      // 「在等通知」与「字段缺失（旧轨迹 / 调用方没传 facts）」。加一个判别字段，
      // 离线统计「等待挂起里有多少是纯通知」才有唯一口径。
      ...(waitSuspend.notificationOnly ? { wait_kind: "notification" } : {}),
    });
    return {
      result: {
        shouldContinue: false,
        completed: false,
        impossible: false,
        waiting: true,
        waitIds: waitSuspend.waitIds,
      },
      injectMessages,
      systemMessages,
    };
  }

  // 3.6 等待放行到顶（C1，2026-11-17）
  //
  // 到顶这一轮**既没放行、也不会发 `waiting`**，于是 trace 里能看到的最后一件事是
  // 「连续第 3 次放行」，下一件事直接是评估结论 —— 「goal 为什么突然开始评估了」
  // 在轨迹里没有答案。补一条与 `waiting` 同字段口径的决策事件，离线才能对上账。
  //
  // 不 return：到顶的语义就是「落回评估器」，后面照常走。
  if (waitSuspend.exhausted) {
    emitTraceEvent("waiting_exhausted", false, {
      wait_ids: waitSuspend.waitIds,
      wait_pass_count: waitSuspend.count,
      ...(waitSuspend.notificationOnly ? { wait_kind: "notification" } : {}),
    });
  }

  // 4. 调用评估者（模型由 resolveGoalEvaluatorModel 解析，未配置时就是主模型）
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
    const failCount =
      blockedDetector["recentBlockerKeys"].filter((k) => k === "__evaluator_unavailable__").length +
      1;
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
      log.warn(
        "GOAL_GATE",
        `目标不可能达成（硬停止）: reason="${evalResult.reason}", turn=${goal.turnsUsed}`,
      );
      systemMessages.push({
        level: "warning",
        text: `Goal 被判定为不可能达成: ${evalResult.reason}`,
      });
      emitTraceEvent("impossible", false, {
        evalReason: evalResult.reason,
        evalTokensUsed: evalResult.evalTokensUsed ?? 0,
      });
      return {
        result: { shouldContinue: false, completed: false, impossible: true, evalResult },
        injectMessages,
        systemMessages,
      };
    }
    // 默认（降级模式）：不终止，注入软提醒把判断交还模型，继续循环（由 maxTurns/budget 兜底）。
    goal.lastEvalReason = evalResult.reason;
    log.info(
      "GOAL_GATE",
      `目标疑似不可能达成（降级为提醒，不终止）: reason="${evalResult.reason?.slice(0, 80)}", turn=${goal.turnsUsed}`,
    );
    const impossibleReminder = buildImpossibleReminder(goal, evalResult);
    injectMessages.push({ role: "user", content: [{ type: "text", text: impossibleReminder }] });
    systemMessages.push({
      level: "warning",
      text: `评估者认为目标可能无法达成（${evalResult.reason?.slice(0, 60)}），已提醒模型自行决定`,
    });
    emitTraceEvent("impossible_soft", true, {
      evalReason: evalResult.reason,
      evalTokensUsed: evalResult.evalTokensUsed ?? 0,
    });
    return {
      result: {
        shouldContinue: true,
        completed: false,
        impossible: false,
        feedback: impossibleReminder,
        evalResult,
      },
      injectMessages,
      systemMessages,
    };
  }

  // 6. 目标达成
  if (evalResult.satisfied) {
    goal.status = "complete";
    log.info(
      "GOAL_GATE",
      `目标达成: reason="${evalResult.reason}", turn=${goal.turnsUsed}, progress=100`,
    );
    systemMessages.push({ level: "info", text: `✓ 目标达成: ${evalResult.reason}` });
    emitTraceEvent("satisfied", false, {
      evalReason: evalResult.reason,
      progress: 100,
      evalTokensUsed: evalResult.evalTokensUsed ?? 0,
    });
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
      log.warn(
        "GOAL_GATE",
        `blocked 检测触发（硬停止）: blockerKey="${evalResult.blockerKey}", threshold=${goalConfig.blockedThreshold}, turn=${goal.turnsUsed}`,
      );
      systemMessages.push({
        level: "warning",
        text: `Goal 检测到卡住（连续 ${goalConfig.blockedThreshold} 轮相同阻塞原因: ${evalResult.blockerKey}），已暂停`,
      });
      emitTraceEvent("blocked", false, {
        blockerKey: evalResult.blockerKey,
        threshold: goalConfig.blockedThreshold,
        evalTokensUsed: evalResult.evalTokensUsed ?? 0,
      });
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
    log.info(
      "GOAL_GATE",
      `blocked 检测触发（降级为提醒，不终止）: blockerKey="${evalResult.blockerKey}", turn=${goal.turnsUsed}`,
    );
    const blockedReminder = buildBlockedReminder(
      goal,
      evalResult.blockerKey,
      goalConfig.blockedThreshold,
    );
    injectMessages.push({ role: "user", content: [{ type: "text", text: blockedReminder }] });
    systemMessages.push({
      level: "warning",
      text: `Goal 疑似卡住（连续 ${goalConfig.blockedThreshold} 轮相同阻塞原因），已提醒模型换思路`,
    });
    emitTraceEvent("blocked_soft", true, {
      blockerKey: evalResult.blockerKey,
      threshold: goalConfig.blockedThreshold,
      evalTokensUsed: evalResult.evalTokensUsed ?? 0,
    });
    return {
      result: {
        shouldContinue: true,
        completed: false,
        impossible: false,
        feedback: blockedReminder,
        evalResult,
      },
      injectMessages,
      systemMessages,
    };
  }

  // 8. 未达成 → 注入反馈 + continue
  goal.lastEvalReason = evalResult.reason;
  log.info(
    "GOAL_GATE",
    `决策: shouldContinue=true, progress=${evalResult.progress ?? "?"}, reason="${evalResult.reason?.slice(0, 80)}", turn=${goal.turnsUsed}`,
  );
  emitTraceEvent("continue", true, {
    progress: evalResult.progress,
    evalReason: evalResult.reason?.slice(0, 200),
    blockerKey: evalResult.blockerKey,
    evalTokensUsed: evalResult.evalTokensUsed ?? 0,
  });
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
    result: {
      shouldContinue: true,
      completed: false,
      impossible: false,
      feedback,
      evalResult,
    },
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
- 如果下一步取决于外部状态（CI 跑完 / PR 合并 / 部署 / 别人 review），**等待也是推进**：
  用 monitor、\`bash --wait_until_seconds\` 或 schedule_wakeup 把等待挂上，然后结束本轮即可——
  等待源回报时会把主循环叫醒。不要为了「显得在推进」在前台反复查询同一个状态。
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
- 不要因为这条提示就机械放弃一个其实还能推进的目标；
- 如果只是卡在等外部状态（CI / 部署 / 别人 review），那不是「无法达成」——**等待也是推进**：
  用 monitor、\`bash --wait_until_seconds\` 或 schedule_wakeup 挂上显式等待后结束本轮，
  等待源回报时会把主循环叫醒，不要继续前台轮询。
（已达最大轮次或预算耗尽时会自动停止，用户也可随时介入。）
</system-reminder>`;
}

/** 构造 blocked 软提醒（降级模式下注入，让模型换思路，而非直接终止）。 */
function buildBlockedReminder(
  goal: GoalState,
  blockerKey: string | undefined,
  threshold: number,
): string {
  return `<system-reminder>
[Goal 卡住提示 — 第 ${goal.turnsUsed} 轮 / 最多 ${goal.maxTurns} 轮]

目标条件: ${goal.objective}

评估者连续 ${threshold} 轮报告相同的阻塞原因${blockerKey ? `（${blockerKey}）` : ""}，你可能在同一处反复受阻。
请换一种思路：
- 回顾前几轮到底卡在哪，不要重复已经失败的同一操作；
- 尝试从不同角度切入，或用不同工具去验证假设；
- 如果连续受阻的原因是你一直在等同一个外部状态（CI / 部署 / 别人 review），那不算卡住——**等待也是推进**：
  挂上显式等待（monitor / \`bash --wait_until_seconds\` / schedule_wakeup）后结束本轮，不要继续轮询；
- 如果确实无法突破，明确说明卡点和已尝试的路径，再决定是否收尾。
（这只是提示，不会强制终止；达最大轮次或预算耗尽时会自动停止，用户也可随时介入。）
</system-reminder>`;
}
