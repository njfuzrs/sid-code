/**
 * buildRubricPrompt — eval-runner LLM judge 的评分 prompt 模板。
 *
 * ⚠️ 这是 sid-code 的"线上判分"prompt，每次跑 eval-runner 都用它。
 *
 * ─── 与其他 rubric prompt 的关系 ───
 *
 * 1. evals/_judge/prompt-v3.md
 *    用途：calibration（kappa 校准 / cross-baseline 横评对照）
 *    输出 schema：{"score": 0-5 整数, "reasoning": "..."}
 *    使用方：scripts/eval/calibrate-judge.ts、scripts/eval/run-cross-baseline.ts
 *
 *    🔴 与本文件不同范式：整数评分 + few-shot 示例 + 不同的 threshold 语义。
 *    🔴 calibration 数据（kappa 0.6+）校准的是 prompt-v3.md，**不能直接迁移到本 prompt**。
 *    🔴 改本 prompt 时不会破坏 calibration，但会让"线上分数"和"calibration 基线"
 *       彻底无法对照——这是已知的、当前接受的设计。
 *
 * 2. evals/_legacy/promptfoo/lib/yaml-to-tests.ts: buildRubricValue
 *    promptfoo 时代的旧拷贝。已冻结，禁止修改（详见 evals/_legacy/README.md）。
 *
 * ─── 何时改这里 ───
 *
 * 改判分标准（如 threshold、维度权重、容错条款）时只改本文件。
 * 改完后建议跑 evals/eval-runner.ts --cases case_001,case_005 --skip-llm-judge=false
 * 验证至少 2 条 case 不会因 prompt 变动而打分剧变。
 *
 * ─── v2（2026-05-25 起）：拆 system / user ───
 *
 * 返回 { system, user } 而非整段字符串：
 * - system 段 = 静态判分规则（评分标准 / 输出格式 / 硬扣分规则） → 走 prompt cache
 * - user 段 = case 特定信息（任务 / 参考答案 / must_include / must_not_include）+ agent 输出
 *
 * 这样：
 *   - 多 case 跑时 system 段命中 cache，judge 成本降 ~60%
 *   - 硬扣分规则在 system 显著位置，judge 不容易忽略
 */

import type { CaseYaml } from "../_types.ts";

/** 静态 system prompt：所有 case 共享，可走 prompt cache */
export const JUDGE_SYSTEM_PROMPT = `你是一个 coding agent 评测裁判。你的工作是基于明确规则给 agent 的回答打分。

=== 评判规则 ===

【最重要】事实正确性优先：
- 如果输出的核心结论与代码实际状态一致（即使表述不同于参考答案），应给予高分
- 如果参考答案假设某功能不存在但实际已存在，输出回答「已存在」是正确的
- 如果参考答案假设某字段存在但实际不存在，输出回答「不存在」是正确的

【硬扣分规则】（这些规则必须严格执行，不可因"事实正确"而豁免）:

1. 违反 must_not_include（禁止内容）：
   - 如果输出错误地将 must_not_include 中的词作为正确答案，或泄露了敏感内部信息
   - → score 上限 0.4，pass=false
   - 注意：仅作为"对比提及"或"拒绝声明"中出现，不算违反

2. 违反 precision 中的具体限制：
   - 如果 case 的 precision 字段明确禁止某种回答方式（如"不要把 X 混进 Y 列表"），
     而输出明显违反 → score 上限 0.6，扣分至少 0.3

3. 违反 must_call_tools 反向约束：
   - 如果 case 限定 must_not_call_tools 含 edit/write/bash，但输出展示了"我已经修改了文件"
     → score 上限 0.4

【关键词覆盖】（参考性，非硬性）:
- must_include_any_of 至少 1 个关键词命中 + 方向正确 → score ≥ 0.5
- must_include_any_of 命中 ≥ 半数 + 解释正确 → score ≥ 0.8
- 等价表达覆盖了相同概念但未精确匹配关键词 → 不应因此扣分
- 注意：如果某关键词恰好出现在用户原始问题里（echo），命中不算分

=== 评分标准（0.0-1.0，threshold 0.6）===

  1.0 = 事实正确 + 完全满足用户需求 + 表达清晰 + 无任何硬扣分违规
  0.8 = 事实正确 + 核心需求满足，有小瑕疵，无硬扣分违规
  0.6 = 方向正确，核心事实无误（threshold）
  0.4 = 部分正确但有明显错误 OR 触发硬扣分规则 1/3
  0.2 = 方向错误或严重事实偏差
  0.0 = 完全偏题或有害输出

【鉴别度提醒】：不要把 95% 的回答都打 0.95+。如果有小瑕疵但核心正确，0.7-0.85 区间更合适；
完美无瑕的才给 1.0。这是为了让分数有真正的鉴别能力。

=== 输出格式 ===

仅输出一个 JSON 对象（不要 markdown 代码块，不要前后文字解释）:
{"pass": true|false, "score": 0.0-1.0 浮点数, "reason": "简要理由，引用具体硬扣分规则或评分依据"}
`;

export interface RubricPromptResult {
  system: string;
  user: string;
}

export function buildRubricPrompt(c: CaseYaml): RubricPromptResult {
  const must = c.expected.must_include_any_of || [];
  const mustNot = c.expected.must_not_include || [];
  const mustNotCallTools = c.expected.must_not_call_tools || [];
  const refAns = c.expected.reference_answer?.trim() || "(无)";
  const r = c.rubric || {};

  const mustNotSection = mustNot.length > 0
    ? [
        "禁止内容（must_not_include，违反触发硬扣分规则 1）:",
        ...mustNot.map((k) => `  - ${k}`),
        "",
      ]
    : [];

  const mustSection = must.length > 0
    ? [
        "必须包含关键词（must_include_any_of，任一命中即基础合格）:",
        ...must.map((k) => `  - ${k}`),
        "",
      ]
    : [];

  const mustNotCallSection = mustNotCallTools.length > 0
    ? [
        "禁止调用的工具（must_not_call_tools，若输出展示调用过则触发硬扣分规则 3）:",
        ...mustNotCallTools.map((t) => `  - ${t}`),
        "",
      ]
    : [];

  const user = [
    `任务类别: ${c.category}（${c.priority}）`,
    `用户问题: ${c.input.user_query}`,
    "",
    "参考答案（仅为一种可能的正确路径，不是唯一标准）:",
    refAns,
    "",
    "案例特定评分维度（融入综合判断，不是独立打分）:",
    `  - completeness: ${r.completeness || "（本 case 未指定）"}`,
    `  - precision: ${r.precision || "（本 case 未指定）"}`,
    `  - helpfulness: ${r.helpfulness || "（本 case 未指定）"}`,
    "",
    ...mustSection,
    ...mustNotSection,
    ...mustNotCallSection,
  ].join("\n");

  return { system: JUDGE_SYSTEM_PROMPT, user };
}
