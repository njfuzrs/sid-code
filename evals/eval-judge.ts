import Anthropic from "@anthropic-ai/sdk";

export interface DimScore {
  pass: boolean;
  /**
   * null 表示该维度"无可评分数据"（数据缺失 / judge 不可用），应在 aggregate 中跳过、
   * 不当作 0 也不当作 1。区别于 0（实测为 0）—— null 是"没法测"，0 是"测了但全错"。
   *
   * 旧实现把缺数据兜底给 1.0，会让挂掉的 case 在 tool/efficiency/cost 三个维度白拿满分，
   * 总分 ~2.5，污染均值（17% 错误率均分仍能稳在 4.1 看起来"还行"）。
   */
  score: number | null;
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
  // 重试用尽：score=null，aggregate 会跳过该维度（不当 0、也不当 1）。
  // 旧实现给 1.0 是误判方向：误判失败是 false negative，误判成功（限流→满分）才会污染 baseline。
  return { pass: false, score: null, reason: `LLM judge 不可用（重试用尽）: ${lastErr?.message?.slice(0, 100) ?? "unknown"}` };
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

  // sideband metadata 全空：trajectory 没落盘 / wrapper 失败 / case 真的没用工具。
  // 无法区分"用了但读不到"和"压根没用"，给 null 让 aggregate 跳过——
  // 旧实现给 1.0 会让挂掉的 case 在 tool 维度白拿满分。
  if (
    tools_used.length === 0 &&
    files_edited.length === 0 &&
    (total_steps ?? 0) === 0
  ) {
    return {
      pass: false,
      score: null,
      reason: "sideband metadata 缺失（trajectory 未落盘或 wrapper 失败），跳过工具合规检查",
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

  // 无轨迹数据：给 null 而非 1.0。挂掉的 case 在 efficiency 维度本应"无可评"，
  // 不是"高效"——这是当前评测体系无法测量的，不能记账成正面信号。
  if (total_steps === 0) {
    return { pass: false, score: null, reason: "无轨迹数据，跳过效率评估" };
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

/**
 * Token 成本评分。
 *
 * ─── 公式与阈值版本 ───
 *
 * 当前公式 v3（2026-05-25 起）:
 *   total_tokens 口径: input（取 last, 含全历史）+ output + cache_creation + cache_read 累加
 *   阈值: 200k / 500k / 1.5M（基于校准实测调整：case_028 sid-code 94k / claude-code 170k）
 *
 * 公式 v2（2026-05-24 ~ 2026-05-25，已废弃）:
 *   口径: 4 项全部累加（错误：input N² 过计数）
 *   阈值: 500k / 1.5M / 3M（建立在错误口径之上，过松，cost 维度无鉴别度）
 *
 * 公式 v1（2026-05-24 之前，已废弃）:
 *   口径: input + output 累加（同样 N² 过计数，且不含 cache）
 *   阈值: 200k / 500k / 1M
 *
 * ⚠️ 跨版本不可直接比较 cost 维度数值，详见 baseline_scores 的 _formula_version 字段。
 *
 * ─── 校准记录（2026-05-25）───
 *
 * 1. claude CLI result.usage 语义：input 取最后一次 API 调用（含全部历史），
 *    output / cache_creation / cache_read 是各 turn 累加。stream-json 模式下 assistant event
 *    的 usage 是 message_delta 累积快照，累加会重复计数（不要用）。
 *
 * 2. sid-code raw.jsonl response.usage 同语义。旧 sid-code-live.ts 直接 sum() 是错的
 *    （case_028 实测累加 1.5M / 实际 94k，15 倍虚高）。已修复为"input 取 last，其它累加"。
 *    源码层 src/trace/collector.ts handleAfterModel 同样 bug 也已修。
 *
 * 3. 横向对比 case_028 实测（修复后）：
 *    - sid-code (deepseek): 94k tokens
 *    - claude-code (opus-4-7): 170k tokens（含大量 cache_read，opus 默认开启 cache）
 *    新阈值 200k / 500k / 1.5M：两者都拿 1.0（合理，因为 case_028 用工具次数少）
 *
 * 调整阈值时记得同步：
 *   - 跑 `bun run evals/eval-runner.ts --provider sid-code,claude-code --sync` 全量刷新 baseline_scores
 *   - bump COST_FORMULA_VERSION 字符串（让旧 baseline 自动标 legacy）
 *   - evals/scripts/migrate-cost-formula.ts 可重跑标记旧版本（v2/v1）的旧 entries
 */
export const COST_FORMULA_VERSION = "v3";

export function gradeCost(meta: AgentMeta): DimScore {
  const { total_tokens } = meta;

  // 无 token 数据：给 null 而非 1.0。原因同 efficiency——
  // wrapper 没读到 trajectory 时 total_tokens=0，旧实现兜底 1.0
  // 会让挂掉的 case 白拿"低消耗"的满分。
  if (total_tokens === 0) {
    return { pass: false, score: null, reason: "无 token 数据，跳过成本评估" };
  }

  let score: number;
  let level: string;

  // v3 阈值（2026-05-25 校准后）：200k / 500k / 1.5M
  if (total_tokens <= 200_000) {
    score = 1.0;
    level = "低消耗";
  } else if (total_tokens <= 500_000) {
    score = 0.7;
    level = "中等";
  } else if (total_tokens <= 1_500_000) {
    score = 0.4;
    level = "偏高";
  } else {
    score = 0.2;
    level = "严重超标";
  }

  const reason = `[cost-${COST_FORMULA_VERSION}] token ${(total_tokens / 1000).toFixed(0)}k(含cache) ${level}`;
  return { pass: score >= 0.6, score, reason };
}

/**
 * 加权聚合：跳过 score === null 的维度，按剩余权重归一化。
 *
 * 例：anchor=0, rubric=null（限流）, tool=null（无 traj）, eff=null, cost=null
 *   → 只有 anchor 一维有效，归一化后总分 = 0 / 1.5 × 5 = 0.0
 *   旧实现：anchor=0 + rubric=0(judge 0) + tool=1 + eff=1 + cost=1 → ~2.5（白拿 3 维）
 *
 * 全部维度 null 的极端 case → 返回 score: null（无法评分），调用方决定写入策略。
 */
export function aggregate(
  dims: Record<string, DimScore>,
  weights?: Record<string, number>
): { score: number | null; namedScores: Record<string, number | null> } {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  let weightedSum = 0;
  let totalWeight = 0;
  const namedScores: Record<string, number | null> = {};

  for (const [name, dim] of Object.entries(dims)) {
    namedScores[name] = dim.score;
    if (dim.score === null) continue; // 跳过：不计入加权
    const weight = w[name] ?? 1.0;
    weightedSum += dim.score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return { score: null, namedScores };
  const normalized = (weightedSum / totalWeight) * 5;
  return { score: Math.round(normalized * 100) / 100, namedScores };
}
