/**
 * Phase 3 W7: 三层 Grader — Layer 3 Process Grader
 * 基于 LLM Judge 做语义级评分（调用 prompt-v1.md）
 */

import type { GradeResult, TaskExpected } from "./outcome-grader.ts";

export interface JudgeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  promptPath: string;
}

export interface JudgeInput {
  task: string;
  expected: TaskExpected;
  agentResponse: string;
}

/**
 * Layer 3: Process Grader — LLM Judge 语义评分
 * 调用 LLM，秒级延迟，$0.001/条
 */
export async function gradeProcess(input: JudgeInput, config: JudgeConfig): Promise<GradeResult> {
  const judgePrompt = await Bun.file(config.promptPath).text();

  const userMsg = `Task: ${input.task}

Expected:
- must_include_any_of: ${JSON.stringify(input.expected.must_include_keywords || [])}
- must_call_tools: ${JSON.stringify(input.expected.must_call_tools || [])}
- must_not_modify_files: ${JSON.stringify(input.expected.must_not_modify_files || [])}
- max_steps: ${input.expected.max_steps || 30}

Agent Response (摘要):
${input.agentResponse.slice(0, 3000)}`;

  try {
    const resp = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: judgePrompt },
          { role: "user", content: userMsg },
        ],
        max_tokens: 300,
        temperature: 0.2,
      }),
    });

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";

    // 解析 JSON
    let judgment: { score?: number; reasoning?: string };
    try {
      const jsonStr = text.startsWith("```") ? text.split("```")[1].replace(/^json\n?/, "") : text;
      judgment = JSON.parse(jsonStr);
    } catch {
      // 尝试从文本中提取分数
      const scoreMatch = text.match(/"score"\s*:\s*(\d)/);
      judgment = {
        score: scoreMatch ? parseInt(scoreMatch[1]) : 3,
        reasoning: "JSON parse failed, extracted score from text",
      };
    }

    // 诊断字符串走 reasoning 而不是 details：GradeResult.details 的契约是
    // Record<string, boolean | number>（outcome-grader.ts:9），字符串塞不进去 ——
    // capability-grader.ts:289 还专门把非 number/boolean 项过滤掉，说明这个窄契约
    // 是刻意的（details 是给聚合统计读的数值维度，不是自由文本槽）。
    // 原先两处都往 details 塞字符串，其中 raw_response 那处只是因为 text 源自
    // `data: any` 才没被 tsc 抓到，error 那处就报了错。
    return {
      score: Math.min(5, Math.max(0, judgment.score ?? 3)),
      layer: "process",
      details: {},
      reasoning: judgment.reasoning || `LLM Judge evaluation (raw: ${String(text).slice(0, 200)})`,
    };
  } catch (error) {
    return {
      score: 3, // 默认中间分
      layer: "process",
      details: {},
      reasoning: `LLM Judge call failed, using default score: ${String(error).slice(0, 200)}`,
    };
  }
}

/**
 * 三层评分聚合：加权平均
 * Layer 1 (Outcome): 40% — 确定性，最可靠
 * Layer 2 (Trajectory): 20% — 过程质量
 * Layer 3 (Process/Judge): 40% — 语义理解
 */
export function aggregateScores(
  outcome: GradeResult,
  trajectory: GradeResult,
  process: GradeResult,
): { finalScore: number; breakdown: Record<string, number> } {
  const weights = { outcome: 0.4, trajectory: 0.2, process: 0.4 };

  const finalScore =
    outcome.score * weights.outcome +
    trajectory.score * weights.trajectory +
    process.score * weights.process;

  return {
    finalScore: Math.round(finalScore * 10) / 10,
    breakdown: {
      outcome: outcome.score,
      trajectory: trajectory.score,
      process: process.score,
    },
  };
}
