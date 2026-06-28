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
}

export interface EvalConfig {
  model: string;
  provider: Provider;
  timeout?: number;
  minTurnsBeforeEval: number;
}

// ─── 快速路径 ───

/** 成本优化：Evidence Log 快速路径，省下明确满足时的 LLM 调用 */
export function tryFastPathEval(goal: GoalState): GoalEvalResult | null {
  const lastEvidence = goal.evidenceLog[goal.evidenceLog.length - 1];
  if (!lastEvidence) return null;

  // 目标含"测试通过"类关键词 + 最后证据是测试全绿 → 快速满足
  if (
    lastEvidence.type === "test_result" &&
    /\b0\s*(fail|error|failure)/i.test(lastEvidence.summary) &&
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

// ─── 核心评估函数 ───

/** 调用独立评估者判定目标是否达成 */
export async function evaluateGoal(
  goal: GoalState,
  conversationContext: string,
  config: EvalConfig,
): Promise<GoalEvalResult> {
  // 1. 先尝试快速路径
  const fastResult = tryFastPathEval(goal);
  if (fastResult) {
    log.info("GOAL_EVAL", `快速路径命中: ${fastResult.reason}`, { goalId: goal.id, type: fastResult.satisfied ? "satisfied" : "not_satisfied" });
    return fastResult;
  }

  // 2. 调用 LLM 评估
  const systemPrompt = buildEvalSystemPrompt();
  const userPrompt = buildEvalUserPrompt(goal, conversationContext);
  const startTime = Date.now();

  log.info("GOAL_EVAL", `开始评估: objective="${goal.objective.slice(0, 60)}", evidenceCount=${goal.evidenceLog.length}, contextChars=${conversationContext.length}, model=${config.model}`);

  try {
    const response = await callEvaluatorModel(systemPrompt, userPrompt, config);
    const result = parseEvalResponse(response);
    const durationMs = Date.now() - startTime;
    log.info("GOAL_EVAL", `评估完成: satisfied=${result.satisfied}, reason="${result.reason?.slice(0, 100)}", progress=${result.progress ?? "N/A"}, impossible=${result.impossible ?? false}, blockerKey=${result.blockerKey ?? "N/A"}, durationMs=${durationMs}`);
    return result;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;
    log.warn("GOAL_EVAL", `评估者调用失败: ${msg}`, { goalId: goal.id, durationMs, model: config.model });
    // 降级：评估失败不阻止循环，视为"未满足"并继续
    return {
      satisfied: false,
      reason: "（评估器暂时不可用，继续工作）",
      progress: undefined,
    };
  }
}

// ─── 对话上下文提取 ───

/** 从消息列表中提取评估者需要的上下文（最近几轮的摘要） */
export function extractEvalContext(messages: Message[], maxChars: number = 4000): string {
  const parts: string[] = [];

  // 从后往前遍历，提取最近的助手回复和工具结果
  const recentMessages = messages.slice(-6); // 最近 3 轮（每轮 user + assistant）

  for (const msg of recentMessages) {
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
    .map(
      (e) =>
        `[轮${e.turn}] ${e.type}: ${e.summary}${e.raw ? `\n  输出: ${e.raw}` : ""}`,
    )
    .join("\n");
}

async function callEvaluatorModel(
  systemPrompt: string,
  userPrompt: string,
  config: EvalConfig,
): Promise<string> {
  const { provider, model, timeout = 8000 } = config;

  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userPrompt }],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let responseText = "";
    const stream = provider.sendMessageStream(
      {
        model,
        messages,
        system: systemPrompt,
        maxTokens: 512,
      },
      controller.signal,
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && "text" in event.delta) {
        responseText += event.delta.text;
      }
    }

    return responseText;
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
