/**
 * Goal 评估器 — 独立评估者
 *
 * 评估器是 /goal 的核心——它决定目标是否达成。
 * 使用独立小模型（haiku 级别）做评估，架构级防自欺。
 * 主要判据是 Evidence Log（结构化证据链），对话上下文仅作补充。
 */

import type { GoalState, EvidenceEntry } from "./state.ts";
import type { Provider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { SIDE_CALL_TIMEOUT_REASON } from "../llm/errors.ts";

const log = getLogger();

// ─── 类型定义 ───

export interface GoalEvalResult {
  /** 目标是否满足 */
  satisfied: boolean;
  /** 判定理由（satisfied=false 时作为反馈注入下一轮） */
  reason: string;
  /** 阻塞标识符（用于 Blocked 检测，标识当前阻塞的根本问题） */
  blockerKey?: string;
  /** 完成度估算 0-100（可选，用于进度显示） */
  progress?: number;
  /** 目标是否被判定为不可能达成 */
  impossible?: boolean;
  /** P1-3: 本次评估调用消耗的 token（in+out），用于 GoalGateDecision 记账（快速路径/失败为 0） */
  evalTokensUsed?: number;
}

export interface EvalConfig {
  model: string;
  provider: Provider;
  timeout?: number;
  minTurnsBeforeEval: number;
  /** 评估器上下文最大字符数（P0-3，默认 12000） */
  contextMaxChars?: number;
  /**
   * B3：模型可用性服务（与主 fallback 引擎共享同一实例）。传入后目标评估请求走
   * streamWithResilience 时能与主路径共享 terminal 拉黑状态。缺省不影响行为。
   */
  availability?: import("../llm/availability.ts").ModelAvailabilityService;
}

/** fast-path 所需的最后一轮信号（P1-1 报告型任务放行用） */
export interface LastTurnSignals {
  stopReason?: string;
  assistantTextLength?: number;
}

// ─── 快速路径 ───

/**
 * 「报告型交付物」的措辞判据（F3 收窄后）。
 *
 * 只留**明确以文本为交付物**的措辞。原表含 `分析` / `总结` / `review` / `检查.*结果`，
 * 这些词大量出现在实干型目标里（"分析并修复…"、"检查并确认 tsc 结果为空"），
 * 于是「干完才停」退化成「说满 500 字就停」——差两个字，语义完全反转。
 */
const REPORT_DELIVERABLE_RE =
  /汇总告诉我|告诉我结果|写一份报告|出一份报告|产出报告|审计.*(汇总|报告)|(汇总|报告).*审计|write\s+(a\s+)?report|summari[sz]e\s+(it|the|your)/i;

/**
 * 实干型目标的否决词：出现即**不是**纯报告任务，无论还含什么报告类词（F3）。
 *
 * 判据方向刻意做成「否决优先」：报告型放行是终局判定（一放行任务就结束），
 * 而漏判只是退回评估器多跑一轮——两个方向的代价不对称。
 */
const HANDS_ON_OBJECTIVE_RE =
  /修复|修好|改好|修掉|解决|实现|重构|补齐|补上|删除|新增|加一个|接上|接线|跑绿|全绿|通过测试|测试通过|让.*(通过|绿)|fix|implement|refactor|migrate|make .* pass/i;

/** 证据里「明确失败」的形态：非零 failed / error 计数 */
const NON_ZERO_FAILURE_RE = /\b(?!0\b)\d+\s*(failed|failing|failures?|errors?)\b/i;

/** 证据里「零失败」的形态 */
const ZERO_FAILURE_RE = /\b0\s*(fail|error|failure)/i;

/**
 * 成本优化：Evidence Log 快速路径，省下明确满足时的 LLM 调用。
 *
 * ⚠️ 这里**不含**报告型放行——它已降级为「评估器不可用时的兜底」，见
 * {@link tryReportFallbackEval}。理由（F3，2026-09-03）：报告型 fast-path 的初衷是
 * 「评估器挂了至少有出路」，但它排在最前面且连 Evidence Log 都不看，于是
 * **评估器健康时也被它抢跑** —— 哪怕证据里最后一条写着「12 个测试仍失败」。
 */
export function tryFastPathEval(goal: GoalState): GoalEvalResult | null {
  const lastEvidence = goal.evidenceLog[goal.evidenceLog.length - 1];

  if (!lastEvidence) return null;

  // 该工具调用本身就失败了 → 任何"看起来成功"的文本都不足以放行（F2）。
  // 测试是否通过本质由退出码定义，不由输出文本定义。
  if (lastEvidence.isError) return null;

  // 目标含"测试通过"类关键词 + 最后证据是测试全绿 → 快速满足
  if (
    lastEvidence.type === "test_result" &&
    ZERO_FAILURE_RE.test(lastEvidence.summary) &&
    // F2 否决项：summary 里若同时有非零 failed，一律不放行。
    // jest/vitest 的两级计数（Test Suites: 3 failed / Tests: 0 failed）现已全部
    // 保留在 summary 里（见 evidence-collector 的 MAX_SUMMARY_LINES），这条才生效。
    !NON_ZERO_FAILURE_RE.test(lastEvidence.summary) &&
    /test|测试|spec/i.test(goal.objective)
  ) {
    return {
      satisfied: true,
      reason: `测试全部通过: ${lastEvidence.summary}`,
      progress: 100,
    };
  }

  // 目标含"build/编译"关键词 + 最后证据是构建成功（无 error）
  if (
    lastEvidence.type === "build_result" &&
    /\b(success|done|built|compiled)\b/i.test(lastEvidence.summary) &&
    !/error/i.test(lastEvidence.summary) &&
    /build|编译|tsc|compile/i.test(goal.objective)
  ) {
    return {
      satisfied: true,
      reason: `构建成功: ${lastEvidence.summary}`,
      progress: 100,
    };
  }

  return null; // 无法快速判定，走正常评估
}

/**
 * 报告型任务的**兜底**放行判据（F3 方案 C）。
 *
 * ## 它为什么不在 tryFastPathEval 里
 *
 * 原先它是 fast-path 的第一段，排在 `if (!lastEvidence) return null` **之前**——
 * 于是评估器健康时也会被它抢跑，且连 Evidence Log 都不看。实测三条放行里两条是
 * 实干型目标（"分析并修复…直到 bun test 全绿" + 720 字废话 → 判定完成）。
 *
 * 初衷（P1-1）是对的：「汇总告诉我」这类任务没有客观完成信号，评估器 LLM 是唯一判据，
 * 它一挂就彻底没出路。所以保留能力、但**只在评估器确实失败后**才启用。
 *
 * 三道判据，全部要过：
 * 1. objective 明确以文本为交付物（收窄后的词表），且不含实干型否决词；
 * 2. 最后一轮 end_turn 且 assistant 产出 > 500 字符；
 * 3. Evidence Log 最后一条不是「明确失败」——有客观失败信号时，报告写得再长也不算完成。
 *
 * @param lastStopReason 最后一轮的 stop_reason
 * @param lastAssistantTextLength 最后一条 assistant 文本长度
 */
export function tryReportFallbackEval(
  goal: GoalState,
  lastStopReason?: string,
  lastAssistantTextLength?: number,
): GoalEvalResult | null {
  if (lastStopReason !== "end_turn") return null;
  if (lastAssistantTextLength == null || lastAssistantTextLength <= 500) return null;
  if (!REPORT_DELIVERABLE_RE.test(goal.objective)) return null;
  // 否决优先：实干型措辞一出现就不是纯报告任务（F3）。
  if (HANDS_ON_OBJECTIVE_RE.test(goal.objective)) return null;

  // 有客观失败证据时不放行——这正是原实现"连 Evidence Log 都不看"的漏洞。
  const lastEvidence = goal.evidenceLog[goal.evidenceLog.length - 1];
  if (lastEvidence) {
    if (lastEvidence.isError) return null;
    if (NON_ZERO_FAILURE_RE.test(lastEvidence.summary)) return null;
  }

  return {
    satisfied: true,
    reason: "报告型任务已产出实质文本并 end_turn（评估器不可用，兜底放行）",
    progress: 100,
  };
}

// ─── 核心评估函数 ───

/** 调用独立评估者判定目标是否达成 */
export async function evaluateGoal(
  goal: GoalState,
  conversationContext: string,
  config: EvalConfig,
  lastTurnSignals?: LastTurnSignals,
): Promise<GoalEvalResult> {
  // 1. 先尝试快速路径（客观信号：测试全绿 / 构建成功）
  //    报告型放行不在这里——它是评估器失败后的兜底，见下方 catch 分支（F3）。
  const fastResult = tryFastPathEval(goal);
  if (fastResult) {
    log.info("GOAL_EVAL", `快速路径命中: ${fastResult.reason}`, {
      goalId: goal.id,
      type: fastResult.satisfied ? "satisfied" : "not_satisfied",
    });
    return fastResult;
  }

  // 2. 调用 LLM 评估
  const systemPrompt = buildEvalSystemPrompt();
  const userPrompt = buildEvalUserPrompt(goal, conversationContext);
  const startTime = Date.now();

  log.info(
    "GOAL_EVAL",
    `开始评估: objective="${goal.objective.slice(0, 60)}", evidenceCount=${goal.evidenceLog.length}, contextChars=${conversationContext.length}, model=${config.model}`,
  );

  try {
    const { text: response, tokensUsed } = await callEvaluatorModel(
      systemPrompt,
      userPrompt,
      config,
    );
    const result = parseEvalResponse(response);
    const durationMs = Date.now() - startTime;
    log.info(
      "GOAL_EVAL",
      `评估完成: satisfied=${result.satisfied}, reason="${result.reason?.slice(0, 100)}", progress=${result.progress ?? "N/A"}, impossible=${result.impossible ?? false}, blockerKey=${result.blockerKey ?? "N/A"}, durationMs=${durationMs}, tokensUsed=${tokensUsed}`,
    );
    return { ...result, evalTokensUsed: tokensUsed };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;
    log.warn("GOAL_EVAL", `评估者调用失败: ${msg}`, {
      goalId: goal.id,
      durationMs,
      model: config.model,
    });

    // F3：报告型任务的兜底放行只在**这里**——评估器确实失败之后。
    // 「汇总告诉我」这类目标没有客观完成信号，评估器是唯一判据，它一挂就彻底没出路；
    // 但放在 fast-path 里会让评估器健康时也被抢跑（实测实干型目标 + 720 字废话即收尾）。
    const reportFallback = tryReportFallbackEval(
      goal,
      lastTurnSignals?.stopReason,
      lastTurnSignals?.assistantTextLength,
    );
    if (reportFallback) {
      log.info("GOAL_EVAL", `评估器不可用，报告型兜底放行: ${reportFallback.reason}`, {
        goalId: goal.id,
      });
      return reportFallback;
    }

    // P0-1 修复：评估失败设 blockerKey="__evaluator_unavailable__"，复用 BlockedDetector 做熔断。
    // 方向反转：评估器坏了 ≠ "目标未满足"，而是"无法判定"——连续失败达阈值后由 blocked 路径放行。
    return {
      satisfied: false,
      reason: "（评估器暂时不可用，继续工作）",
      progress: undefined,
      blockerKey: "__evaluator_unavailable__",
    };
  }
}

// ─── 对话上下文提取 ───

/**
 * 从消息列表中提取评估者需要的上下文（最近几轮的摘要）。
 *
 * P0-3 修复：评估"是否完成"最需要的是模型最后的完整产出。旧实现三道截断联合
 * （slice(-6) + block.text.slice(0,800) + truncateToLimit(4000)），导致长报告
 * （如 6.7k 字符审计报告）被截在 4000 处，评估器看不全 → 判不出"已完成"。
 * 改法：单独取最后一条 assistant 消息不截断（放宽到 8000）拼在最前，其余维持 800 截断。
 */
export function extractEvalContext(messages: Message[], maxChars: number = 12000): string {
  const parts: string[] = [];

  // 单独定位最后一条 assistant 消息——它是"是否完成"最关键的判据，必须完整（放宽到 8000）。
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();
  let lastAssistantText = "";
  if (lastAssistantIdx >= 0) {
    for (const block of messages[lastAssistantIdx].content) {
      if (block.type === "text" && block.text.trim()) {
        lastAssistantText += (lastAssistantText ? "\n" : "") + block.text;
      }
    }
    if (lastAssistantText) {
      parts.push(`[assistant · 最新完整产出] ${lastAssistantText.slice(0, 8000)}`);
    }
  }

  // 从后往前遍历，提取最近的助手回复和工具结果（跳过已单独完整拼入的最后一条 assistant）
  const recentMessages = messages.slice(-6); // 最近 3 轮（每轮 user + assistant）
  const recentStartIdx = Math.max(0, messages.length - 6);

  for (let ri = 0; ri < recentMessages.length; ri++) {
    const msg = recentMessages[ri];
    const absoluteIdx = recentStartIdx + ri;
    if (absoluteIdx === lastAssistantIdx) continue; // 已完整拼入，避免重复
    for (const block of msg.content) {
      if (block.type === "text" && block.text.trim()) {
        parts.push(`[${msg.role}] ${block.text.slice(0, 800)}`);
      } else if (block.type === "tool_result") {
        const snippet = block.content.slice(0, 400);
        parts.push(`[tool_result] ${snippet}`);
      }
    }
  }

  const joined = parts.join("\n\n");
  return truncateToLimit(joined, maxChars);
}

// ─── 内部实现 ───

function buildEvalSystemPrompt(): string {
  return `你是一个目标完成度评估器。你的职责是判断 AI 编程助手是否已经满足用户设定的完成条件。

规则：
1. 优先根据"证据日志"中的结构化证据判断——这些是确认过的操作结果
2. 对话上下文作为补充参考，但证据日志优先级更高
3. "正在做"不等于"已完成"——必须看到最终结果
4. 如果目标涉及的前置条件根本不存在（如文件/模块不存在），返回 impossible=true
5. blockerKey：用一个简短标识符标记当前阻塞的根本问题（如 "auth-test-line42-assertion"），用于卡住检测
6. 返回 JSON 格式：{"satisfied": bool, "reason": "...", "blockerKey": "...", "progress": 0-100, "impossible": false}

重要：只输出 JSON，不要输出其他内容。`;
}

function buildEvalUserPrompt(goal: GoalState, conversationContext: string): string {
  return `## 完成条件
${goal.objective}

## 证据日志（按时间顺序，最新在后）
${formatEvidenceLog(goal.evidenceLog)}

## 最近对话上下文（补充参考）
${conversationContext || "（无对话上下文）"}

## 已执行轮次
${goal.turnsUsed} / ${goal.maxTurns}

请判断：完成条件是否已被满足？`;
}

function formatEvidenceLog(entries: EvidenceEntry[]): string {
  if (entries.length === 0) return "（暂无证据）";
  // 最多取最近 20 条，避免超长
  const recent = entries.slice(-20);
  return recent
    .map((e) => `[轮${e.turn}] ${e.type}: ${e.summary}${e.raw ? `\n  输出: ${e.raw}` : ""}`)
    .join("\n");
}

async function callEvaluatorModel(
  systemPrompt: string,
  userPrompt: string,
  config: EvalConfig,
): Promise<{ text: string; tokensUsed: number }> {
  const { provider, model, timeout = 25000 } = config;

  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userPrompt }],
    },
  ];

  const controller = new AbortController();
  // H10：超时用带 reason 的 abort（SIDE_CALL_TIMEOUT_REASON="side-call-timeout"，已登记
  // ABORT_REASONS）而非无参 abort。底层 fetch 以该裸字符串 reject 时被 isAbortError 识别为
  // 中断、不崩进程；与主路径「判超时看 reason 白名单」的口径统一，不再依赖错误消息文本匹配。
  const timer = setTimeout(() => controller.abort(SIDE_CALL_TIMEOUT_REASON), timeout);

  try {
    let responseText = "";
    let tokensUsed = 0;
    const { streamWithResilience } = await import("../llm/resilient-stream.ts");
    // B3（D8）：改走漏斗而非直连——此前 429/523 等可重试错误在这里 1ms 内直接失败。
    // 收紧参数：目标评估是轻量分类任务，只值得轻量重试，deadlineAt 与本函数的
    // controller 超时（timeout）同源，退避睡不完就提前收手，不吃满 timeout。
    const stream = streamWithResilience(
      provider,
      {
        model,
        messages,
        system: systemPrompt,
        maxTokens: 512,
        // H5：目标评估是「判断完成条件是否满足→出个 JSON」的分类任务，关思考。
        // 不关则主模型为思考模型时每次评估都触发完整思考，超时+成本双放大。
        thinking: SIDE_CALL_NO_THINK,
      },
      controller.signal,
      {
        querySource: "goal_eval",
        switchMode: "auto",
        maxRetries: 2,
        retryBackoffBaseMs: 1000,
        retryBackoffMaxMs: 5000,
        streamTimeoutMs: timeout,
        deadlineAt: Date.now() + timeout,
        availability: config.availability,
      },
    );

    for await (const event of stream) {
      // 纵深防御:goal-evaluator side-call 检查 signal(controller.signal),防止 provider 层超时失效时挂死
      // H10：抛出携带 abort reason 的错误（而非裸 "Request aborted"），与主路径 reason 白名单口径一致。
      if (controller.signal.aborted) {
        throw new Error(String(controller.signal.reason ?? SIDE_CALL_TIMEOUT_REASON));
      }
      // B3：streamWithResilience 重试耗尽/无法降级时通过 yield {type:"error"} 通知失败
      // （而非直接 throw），直连 provider 时不存在这个事件类型。改走漏斗后必须显式接住，
      // 否则错误被当作"正常流结束、responseText 为空"吞掉，上层看到的是"评估器返回非 JSON"
      // 而非真实的网络/限流失败原因。
      if (event.type === "error") {
        throw new Error(event.error.message);
      }
      if (event.type === "content_block_delta" && "text" in event.delta) {
        responseText += event.delta.text;
      } else if (event.type === "message_stop" && (event as any).usage) {
        const u = (event as any).usage;
        // P1-3: 累计评估器 token 供 GoalGateDecision 记账
        tokensUsed = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
        recordSideCall({
          label: "goal-evaluator",
          model,
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadInputTokens ?? 0,
          cacheCreationTokens: u.cacheCreationInputTokens ?? 0,
          durationMs: 0,
        });
      }
    }

    return { text: responseText, tokensUsed };
  } finally {
    clearTimeout(timer);
  }
}

function parseEvalResponse(response: string): GoalEvalResult {
  // 尝试提取 JSON（可能被 markdown 包裹）
  const jsonMatch = response.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    log.warn("GOAL_EVAL", `评估者返回非 JSON: ${response.slice(0, 200)}`);
    return {
      satisfied: false,
      reason: "评估结果解析失败，继续工作",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      satisfied: Boolean(parsed.satisfied),
      reason: String(parsed.reason || ""),
      blockerKey: parsed.blockerKey ? String(parsed.blockerKey) : undefined,
      progress: typeof parsed.progress === "number" ? parsed.progress : undefined,
      impossible: Boolean(parsed.impossible),
    };
  } catch {
    log.warn("GOAL_EVAL", `JSON 解析失败: ${jsonMatch[0].slice(0, 200)}`);
    return {
      satisfied: false,
      reason: "评估结果解析失败，继续工作",
    };
  }
}

function truncateToLimit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars); // 保留最新内容
}
