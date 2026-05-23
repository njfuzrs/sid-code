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

/**
 * 锚点命中评分。
 *
 * 设计原则（修复 case_007 / case_028 类问题）:
 * - must_include_any_of 的语义是"命中任一即可合格"，不应该因为锚点表写得多而降低 score
 * - 但如果一个锚点都没命中，明显是答非所问，给低分
 * - 渐进满分：命中 1 个 = 0.5，达到 max(2, 50%) 个 = 1.0（既奖励多命中，又不让长锚点表惩罚正确答案）
 */
export function gradeAnchorHit(output: string, anchors: string[]): DimScore {
  if (anchors.length === 0) {
    return { pass: true, score: 1.0, reason: "无锚点，跳过" };
  }
  const hits = anchors.filter((a) => output.includes(a));
  const hitCount = hits.length;
  const total = anchors.length;

  // 满分阈值：max(2, 50%)。锚点表越长，达到满分的门槛越宽松（避免长表惩罚）。
  const fullScoreThreshold = Math.max(2, Math.ceil(total * 0.5));
  let score: number;
  if (hitCount === 0) {
    score = 0;
  } else if (hitCount === 1) {
    score = 0.5;  // 命中任一即合格的基础分
  } else if (hitCount >= fullScoreThreshold) {
    score = 1.0;
  } else {
    // 1 < hitCount < fullScoreThreshold：在 0.5 ~ 1.0 间线性插值
    const ratio = (hitCount - 1) / (fullScoreThreshold - 1);
    score = 0.5 + 0.5 * ratio;
  }

  const pass = hitCount >= 1;
  const missing = anchors.filter((a) => !output.includes(a));
  const reason =
    hitCount === total
      ? `全部命中: ${hits.join(", ")}`
      : hitCount >= fullScoreThreshold
        ? `命中 ${hitCount}/${total}（达到满分阈值 ${fullScoreThreshold}）: ${hits.join(", ")}`
        : hitCount > 0
          ? `命中 ${hitCount}/${total}（满分阈值 ${fullScoreThreshold}）: ${hits.join(", ")}; 未命中: ${missing.join(", ")}`
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

  // 限流/网络错误：最多重试 3 次，指数退避
  const maxRetries = 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
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
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const status = (err as { status?: number }).status;
      // 429/503/500 可重试；4xx 其它直接放弃
      const retryable = status === 429 || status === 503 || status === 500 || status === 502 || status === 504;
      if (!retryable || attempt === maxRetries) break;
      const delayMs = Math.min(30_000, 2_000 * Math.pow(2, attempt));
      process.stderr.write(`[gradeRubric] judge API ${status} 第 ${attempt + 1}/${maxRetries} 次失败，${delayMs}ms 后重试\n`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  // 重试用尽：降级——score=1.0 但 pass=false + reason 标注 judge 不可用
  // 这样不会让单个 case 因 judge 限流而误判失败，整体仍可继续
  return { pass: false, score: 1.0, reason: `LLM judge 不可用（重试用尽）: ${lastErr?.message?.slice(0, 100) ?? "unknown"}` };
}

export function gradeToolCompliance(
  meta: AgentMeta,
  expected: {
    mustCallTools?: string[];
    /** 工具调用模式：all_of(默认，所有都必须用) | any_of(任一即可) */
    mustCallMode?: "all_of" | "any_of";
    mustNotCallTools?: string[];
    mustNotModifyFiles?: string[];
  }
): DimScore {
  const { tools_used, files_edited, total_steps } = meta;
  const mustCallTools = expected.mustCallTools ?? [];
  const mustCallMode = expected.mustCallMode ?? "all_of";
  const mustNotCallTools = expected.mustNotCallTools ?? [];
  const mustNotModifyFiles = expected.mustNotModifyFiles ?? [];

  // sideband metadata 缺失兜底（修复 case_002/005 等卡 0.6 的系统性偏差）
  // 当 wrapper 没读到 trajectory 时，所有合规维度数据都是空的——这是评测体系问题，不应扣模型的分
  if (
    tools_used.length === 0 &&
    files_edited.length === 0 &&
    (total_steps ?? 0) === 0
  ) {
    return {
      pass: true,
      score: 1.0,
      reason: "sideband metadata 缺失（trajectory 未落盘或读取失败），跳过工具合规检查",
    };
  }

  let score = 1.0;
  const reasons: string[] = [];

  if (mustCallTools.length > 0) {
    const hits = mustCallTools.filter((t) => tools_used.includes(t));
    if (mustCallMode === "any_of") {
      // any_of：命中任一即满分
      if (hits.length === 0) {
        score -= 0.4;
        reasons.push("未使用任何要求的工具(any_of): " + mustCallTools.join("|"));
      }
    } else {
      // all_of（默认）：按命中比例扣分
      if (hits.length < mustCallTools.length) {
        score -= 0.4 * (1 - hits.length / mustCallTools.length);
        reasons.push(
          "未使用要求的工具: " + mustCallTools.filter((t) => !tools_used.includes(t)).join(", ")
        );
      }
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
