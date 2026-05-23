import Anthropic from "@anthropic-ai/sdk";

export interface DimScore {
  pass: boolean;
  score: number;
  reason: string;
}

export interface AgentMeta {
  tools_used: string[];
  files_edited: string[];
  total_steps: number;
  total_tokens: number;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  anchor_hit: 1.5,
  rubric_score: 4.0,
  tool_compliance: 1.5,
  efficiency: 1.0,
  cost: 0.5,
};

export function gradeAnchorHit(output: string, anchors: string[]): DimScore {
  if (anchors.length === 0) {
    return { pass: true, score: 1.0, reason: "无锚点，跳过" };
  }
  const hits = anchors.filter((a) => output.includes(a));
  const score = hits.length / anchors.length;
  const pass = hits.length >= 1;
  const reason =
    hits.length === anchors.length
      ? `全部命中: ${anchors.join(", ")}`
      : hits.length > 0
        ? `命中 ${hits.length}/${anchors.length}: ${hits.join(", ")}; 未命中: ${anchors.filter((a) => !output.includes(a)).join(", ")}`
        : `未命中任何锚点: ${anchors.join(", ")}`;
  return { pass, score, reason };
}

export async function gradeRubric(
  output: string,
  rubricPrompt: string,
  judgeModel = "claude-sonnet-4-5-20250929"
): Promise<DimScore> {
  const client = new Anthropic();
  const prompt = `${rubricPrompt}\n\n待评测输出:\n${output}`;
  const msg = await client.messages.create({
    model: judgeModel,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { pass: false, score: 0, reason: `judge 返回无法解析: ${text.slice(0, 120)}` };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { pass: boolean; score: number; reason: string };
    return {
      pass: Boolean(parsed.pass),
      score: Number(parsed.score),
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    return { pass: false, score: 0, reason: `JSON 解析失败: ${jsonMatch[0].slice(0, 120)}` };
  }
}

export function gradeToolCompliance(
  meta: AgentMeta,
  expected: {
    mustCallTools?: string[];
    mustNotCallTools?: string[];
    mustNotModifyFiles?: string[];
  }
): DimScore {
  const { tools_used, files_edited } = meta;
  const mustCallTools = expected.mustCallTools ?? [];
  const mustNotCallTools = expected.mustNotCallTools ?? [];
  const mustNotModifyFiles = expected.mustNotModifyFiles ?? [];

  let score = 1.0;
  const reasons: string[] = [];

  if (mustCallTools.length > 0) {
    const hits = mustCallTools.filter((t) => tools_used.includes(t));
    if (hits.length < mustCallTools.length) {
      score -= 0.4 * (1 - hits.length / mustCallTools.length);
      reasons.push(
        "未使用要求的工具: " + mustCallTools.filter((t) => !tools_used.includes(t)).join(", ")
      );
    }
  }

  for (const t of mustNotCallTools) {
    if (tools_used.includes(t)) {
      score -= 0.3;
      reasons.push("使用了禁止的工具: " + t);
    }
  }

  for (const pattern of mustNotModifyFiles) {
    const violations = files_edited.filter((f) => f.startsWith(pattern) || f === pattern);
    if (violations.length > 0) {
      score -= 0.5;
      reasons.push("修改了禁止的文件: " + violations.join(", "));
    }
  }

  score = Math.max(0, score);
  return {
    pass: score >= 0.6,
    score,
    reason: reasons.length > 0 ? reasons.join("; ") : "工具使用合规",
  };
}

export function gradeEfficiency(meta: AgentMeta, maxSteps: number): DimScore {
  const { total_steps } = meta;

  if (total_steps === 0) {
    return { pass: true, score: 1.0, reason: "无轨迹数据，跳过效率评估" };
  }

  const ratio = total_steps / maxSteps;
  let score: number;
  let reason: string;

  if (ratio <= 1.0) {
    score = 1.0;
    reason = `步数 ${total_steps}/${maxSteps} 在预期内`;
  } else if (ratio <= 1.5) {
    score = 0.7;
    reason = `步数偏多 ${total_steps}/${maxSteps} (${ratio.toFixed(1)}x)`;
  } else if (ratio <= 2.0) {
    score = 0.4;
    reason = `步数超标 ${total_steps}/${maxSteps} (${ratio.toFixed(1)}x)`;
  } else {
    score = 0.1;
    reason = `步数严重超标 ${total_steps}/${maxSteps} (${ratio.toFixed(1)}x)`;
  }

  return { pass: score >= 0.6, score, reason };
}

export function gradeCost(meta: AgentMeta): DimScore {
  const { total_tokens } = meta;

  if (total_tokens === 0) {
    return { pass: true, score: 1.0, reason: "无 token 数据，跳过成本评估" };
  }

  let score: number;
  let reason: string;

  if (total_tokens <= 200_000) {
    score = 1.0;
    reason = `token 使用 ${(total_tokens / 1000).toFixed(0)}k，低消耗`;
  } else if (total_tokens <= 500_000) {
    score = 0.7;
    reason = `token 使用 ${(total_tokens / 1000).toFixed(0)}k，中等`;
  } else if (total_tokens <= 1_000_000) {
    score = 0.4;
    reason = `token 使用 ${(total_tokens / 1000).toFixed(0)}k，偏高`;
  } else {
    score = 0.2;
    reason = `token 使用 ${(total_tokens / 1000).toFixed(0)}k，严重超标`;
  }

  return { pass: score >= 0.6, score, reason };
}

export function aggregate(
  dims: Record<string, DimScore>,
  weights?: Record<string, number>
): { score: number; namedScores: Record<string, number> } {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  let weightedSum = 0;
  let totalWeight = 0;
  const namedScores: Record<string, number> = {};

  for (const [name, dim] of Object.entries(dims)) {
    const weight = w[name] ?? 1.0;
    weightedSum += dim.score * weight;
    totalWeight += weight;
    namedScores[name] = dim.score;
  }

  const normalized = totalWeight > 0 ? (weightedSum / totalWeight) * 5 : 0;
  return { score: Math.round(normalized * 100) / 100, namedScores };
}
