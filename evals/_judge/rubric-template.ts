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
 */

interface CaseYaml {
  id: string;
  category: string;
  priority: string;
  input: { user_query: string };
  expected: {
    must_include_any_of?: string[];
    must_not_include?: string[];
    reference_answer?: string;
  };
  rubric?: {
    completeness?: string;
    precision?: string;
    helpfulness?: string;
  };
}

export function buildRubricPrompt(c: CaseYaml): string {
  const must = c.expected.must_include_any_of || [];
  const mustNot = c.expected.must_not_include || [];
  const refAns = c.expected.reference_answer?.trim() || "(无)";
  const r = c.rubric || {};

  const mustNotSection = mustNot.length > 0
    ? [
        "禁止内容(语义判断):",
        "  以下词如果只是作为「对比提及」或「拒绝声明」中出现，不扣分。",
        "  只有当输出错误地将其作为正确答案、或泄露了敏感内部信息时才扣分：",
        ...mustNot.map((k) => `  - ${k}`),
        "",
      ]
    : [];

  const mustSection = must.length > 0
    ? [
        "关键词命中(参考，非强制，至少 1 个):",
        "  必须包含(any_of):",
        ...must.map((k) => `  - ${k}`),
        "  → 如果输出用等价表达覆盖了相同概念但未精确匹配这些词，不应因此扣分",
        "",
      ]
    : [];

  return [
    `任务类别: ${c.category}(${c.priority})`,
    `用户问题: ${c.input.user_query}`,
    "",
    "参考答案(仅为一种可能的正确路径，不是唯一标准):",
    refAns,
    "",
    "=== 评判规则 ===",
    "",
    "【最重要】事实正确性优先：",
    "- 如果输出的核心结论与代码实际状态一致（即使表述不同于参考答案），应给予高分",
    "- 如果参考答案假设某功能不存在但实际已存在，输出回答「已存在」是正确的",
    "- 如果参考答案假设某字段存在但实际不存在，输出回答「不存在」是正确的",
    "",
    ...mustSection,
    ...mustNotSection,
    "评分维度:",
    "  - factual_accuracy: 输出的核心结论是否与代码/事实实际状态一致（优先级最高）",
    `  - completeness: ${r.completeness || "(本 case 未指定)"}`,
    `  - precision: ${r.precision || "(本 case 未指定)"}`,
    `  - helpfulness: ${r.helpfulness || "(本 case 未指定)"}`,
    "",
    "评分标准(0.0-1.0, threshold 0.6):",
    "  1.0 = 事实正确 + 完全满足用户需求 + 表达清晰",
    "  0.8 = 事实正确 + 核心需求满足，有小瑕疵",
    "  0.6 = 方向正确，核心事实无误(threshold)",
    "  0.4 = 部分正确但有明显错误或严重遗漏",
    "  0.2 = 方向错误或严重事实偏差",
    "  0.0 = 完全偏题或有害输出",
    "",
    '输出严格 JSON: {"pass": bool, "score": 0.0-1.0, "reason": "简要理由"}',
  ].join("\n");
}
