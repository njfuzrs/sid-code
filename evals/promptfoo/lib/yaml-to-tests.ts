/**
 * yaml-to-tests: 把 evals/p0-core/case_*.yaml 转成 promptfoo tests 数组
 *
 * 转换规则:
 *   user_query                → vars.user_query / prompt 直接用
 *   must_include_any_of       → contains-any 断言(确定性命中数 ≥ minHits)
 *   must_not_include          → not-contains-any 断言
 *   rubric.{completeness,...} → llm-rubric 断言(模型评判,复用 calibration-v3 prompt)
 *   reference_answer          → vars.reference_answer(供 rubric 模板插值)
 *   id / category / priority  → metadata(promptfoo filter / dashboard 用)
 *
 * 用法:
 *   bun run evals/promptfoo/lib/yaml-to-tests.ts \
 *     --cases case_001,case_002,case_005 \
 *     --out evals/promptfoo/tests/generated-tests.yaml
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const ROOT = resolve(import.meta.dir, "../../..");
const CASE_DIRS = [
  join(ROOT, "evals/p0-core"),
  join(ROOT, "evals/p1-common"),
  join(ROOT, "evals/p2-edge"),
];

interface CaseYaml {
  id: string;
  category: string;
  priority: string;
  holdout?: boolean;
  input: { user_query: string };
  expected: {
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    must_not_call_tools?: string[];
    max_steps?: number;
    reference_answer?: string;
  };
  rubric?: {
    completeness?: string;
    precision?: string;
    helpfulness?: string;
  };
}

interface PromptfooAssert {
  type: string;
  value?: unknown;
  weight?: number;
  metric?: string;
  threshold?: number;
}

interface PromptfooTest {
  description: string;
  vars: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  assert: PromptfooAssert[];
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cases: { type: "string", default: "case_001,case_002,case_005" },
    out: { type: "string", default: "evals/promptfoo/tests/generated-tests.yaml" },
    "min-hits": { type: "string", default: "1" },
    "skip-holdout": { type: "boolean", default: true },
  },
  strict: false,
});

async function loadCases(): Promise<CaseYaml[]> {
  const wantSet = new Set((values.cases as string).split(",").map((s) => s.trim()));
  const cases: CaseYaml[] = [];
  for (const dir of CASE_DIRS) {
    const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));
    for (const f of files) {
      const content = await Bun.file(join(dir, f)).text();
      const c = parseYaml(content) as CaseYaml;
      if (values["skip-holdout"] && c.holdout) continue;
      if (wantSet.size > 0 && !wantSet.has(c.id)) continue;
      cases.push(c);
    }
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function buildRubricValue(c: CaseYaml, minHits: number): string {
  const must = c.expected.must_include_any_of || [];
  const mustNot = c.expected.must_not_include || [];
  const refAns = c.expected.reference_answer?.trim() || "(无)";
  const r = c.rubric || {};

  return [
    `任务类别: ${c.category}(${c.priority})`,
    `用户问题: ${c.input.user_query}`,
    "",
    "参考答案(锚点):",
    refAns,
    "",
    "必须命中关键词(any_of, 至少 " + minHits + " 个):",
    ...must.map((k) => `  - ${k}`),
    ...(mustNot.length > 0 ? ["禁止出现:", ...mustNot.map((k) => `  - ${k}`)] : []),
    "",
    "评分维度(参考 calibration-v3 prompt-v3.md):",
    `  - completeness: ${r.completeness || "(本 case 未指定)"}`,
    `  - precision: ${r.precision || "(本 case 未指定)"}`,
    `  - helpfulness: ${r.helpfulness || "(本 case 未指定)"}`,
    "",
    "评分标准(0.0-1.0, threshold 0.6):",
    "  1.0 = 完全命中所有锚点 + 解释清晰准确",
    "  0.8 = 命中关键锚点,有小瑕疵",
    "  0.6 = 部分命中,方向正确(threshold 阈值)",
    "  0.4 = 命中少,有明显错误或严重遗漏",
    "  0.2 = 错误路径或泛泛而谈",
    "  0.0 = 完全偏题",
    "",
    "输出严格 JSON: {\"pass\": bool, \"score\": 0.0-1.0, \"reason\": \"简要理由\"}",
  ].join("\n");
}

function buildTest(c: CaseYaml, minHits: number): PromptfooTest {
  const must = c.expected.must_include_any_of || [];
  const mustNot = c.expected.must_not_include || [];

  const asserts: PromptfooAssert[] = [];

  // 1. 确定性断言: must_include_any_of(锚点命中)
  if (must.length > 0) {
    asserts.push({
      type: "contains-any",
      value: must,
      weight: 2.0,
      metric: "anchor_hit",
    });
  }

  // 2. 确定性断言: must_not_include(反向锚点)
  if (mustNot.length > 0) {
    asserts.push({
      type: "not-contains-any",
      value: mustNot,
      weight: 2.0,
      metric: "anchor_violation",
    });
  }

  // 3. 模型评判: 综合 rubric
  asserts.push({
    type: "llm-rubric",
    value: buildRubricValue(c, minHits),
    weight: 3.0,
    metric: "rubric_score",
    threshold: 0.6,
  });

  return {
    description: `[${c.id}] ${c.category} — ${c.input.user_query.slice(0, 60)}${c.input.user_query.length > 60 ? "..." : ""}`,
    vars: {
      user_query: c.input.user_query,
      case_id: c.id,
      category: c.category,
    },
    metadata: {
      case_id: c.id,
      category: c.category,
      priority: c.priority,
      max_steps: c.expected.max_steps ?? null,
    },
    assert: asserts,
  };
}

async function main() {
  const cases = await loadCases();
  if (cases.length === 0) {
    console.error("未找到任何匹配的 case,检查 --cases 参数与 case yaml 路径");
    process.exit(1);
  }

  const minHits = parseInt(values["min-hits"] as string, 10) || 1;
  const tests = cases.map((c) => buildTest(c, minHits));

  const outPath = resolve(ROOT, values.out as string);
  const yamlOut = stringifyYaml(tests, { lineWidth: 0 });
  const header = [
    "# Generated by evals/promptfoo/lib/yaml-to-tests.ts — DO NOT EDIT",
    `# Source cases: ${cases.map((c) => c.id).join(", ")}`,
    `# Generated at: ${new Date().toISOString()}`,
    "",
  ].join("\n");

  await Bun.write(outPath, header + yamlOut);
  console.log(`已生成 ${tests.length} 个 test → ${outPath}`);
  console.log(`Case IDs: ${cases.map((c) => c.id).join(", ")}`);
}

main();
