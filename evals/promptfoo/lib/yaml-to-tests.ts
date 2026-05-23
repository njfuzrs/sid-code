/**
 * yaml-to-tests: 把 evals/p0-core/case_*.yaml 转成 promptfoo tests 数组
 *
 * 转换规则:
 *   user_query                → vars.user_query / prompt 直接用
 *   must_include_any_of       → contains-any 断言(确定性命中数 ≥ minHits)
 *   must_not_include          → 融入 rubric prompt，由 LLM judge 语义判断
 *   rubric.{completeness,...} → llm-rubric 断言(模型评判,复用 calibration-v3 prompt)
 *   reference_answer          → vars.reference_answer(供 rubric 模板插值)
 *   id / category / priority  → metadata(promptfoo filter / dashboard 用)
 *
 * 权重分配(5 维):
 *   anchor_hit(1.5) + rubric_score(4.0) + tool_compliance(1.5) + efficiency(1.0) + cost(0.5)
 *   总 8.5，其中过程维度占 35%(3.0/8.5)
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
    /** 工具检查模式：all_of(默认，所有都必须用) | any_of(任一即可) */
    must_call_tools_mode?: "all_of" | "any_of";
    must_not_call_tools?: string[];
    must_not_modify_files?: string[];
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

  const mustNotSection =
    mustNot.length > 0
      ? [
          "禁止内容(语义判断):",
          "  以下词如果只是作为「对比提及」或「拒绝声明」中出现，不扣分。",
          "  只有当输出错误地将其作为正确答案、或泄露了敏感内部信息时才扣分：",
          ...mustNot.map((k) => `  - ${k}`),
          "",
        ]
      : [];

  const mustSection =
    must.length > 0
      ? [
          `关键词命中(参考，非强制，至少 ${minHits} 个):`,
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
    "输出严格 JSON: {\"pass\": bool, \"score\": 0.0-1.0, \"reason\": \"简要理由\"}",
  ].join("\n");
}

// ─── sideband metadata 路径（provider 写入，断言读取） ───

const METADATA_DIR_ABS = resolve(import.meta.dir, "../.eval-metadata");

function metaReaderSnippet(): string {
  return `
    const _fs = process.mainModule.require("fs");
    const _path = process.mainModule.require("path");
    const _metaDir = ${JSON.stringify(METADATA_DIR_ABS)};
    const _caseId = context.vars?.case_id || "unknown";
    const _providerLabel = (context.provider?.label || context.provider?.id?.() || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");

    function _readMeta() {
      try {
        const files = _fs.readdirSync(_metaDir).filter(function(f) { return f.startsWith(_caseId + "__"); });
        if (_providerLabel) {
          const exact = files.find(function(f) { return f.includes(_providerLabel); });
          if (exact) return JSON.parse(_fs.readFileSync(_path.join(_metaDir, exact), "utf-8"));
        }
        if (files.length > 0) {
          var newest = files[0], newestMtime = 0;
          for (var i = 0; i < files.length; i++) {
            var mt = _fs.statSync(_path.join(_metaDir, files[i])).mtimeMs;
            if (mt > newestMtime) { newestMtime = mt; newest = files[i]; }
          }
          return JSON.parse(_fs.readFileSync(_path.join(_metaDir, newest), "utf-8"));
        }
      } catch(e) {}
      return {};
    }
    const meta = _readMeta();
  `;
}

// ─── 过程维度断言生成函数 ───

function buildToolComplianceAssertion(
  mustCall: string[], mustNotCall: string[], mustNotModify: string[],
  mustCallMode: "all_of" | "any_of" = "all_of",
): string {
  return `
    ${metaReaderSnippet()}
    const toolsUsed = meta.tools_used || [];
    const filesEdited = meta.files_edited || [];
    const mustCallTools = ${JSON.stringify(mustCall)};
    const mustCallMode = ${JSON.stringify(mustCallMode)};
    const mustNotCallTools = ${JSON.stringify(mustNotCall)};
    const mustNotModifyFiles = ${JSON.stringify(mustNotModify)};

    let score = 1.0;
    const reasons = [];

    if (mustCallTools.length > 0) {
      const hits = mustCallTools.filter(function(t) { return toolsUsed.includes(t); });
      if (mustCallMode === "any_of") {
        // any_of：命中任一即满分；一个都没命中扣 0.4
        if (hits.length === 0) {
          score -= 0.4;
          reasons.push("未使用任何要求的工具(any_of): " + mustCallTools.join("|"));
        }
      } else {
        // all_of（默认）：按命中比例扣分
        if (hits.length < mustCallTools.length) {
          score -= 0.4 * (1 - hits.length / mustCallTools.length);
          reasons.push("未使用要求的工具: " + mustCallTools.filter(function(t) { return !toolsUsed.includes(t); }).join(", "));
        }
      }
    }

    for (const t of mustNotCallTools) {
      if (toolsUsed.includes(t)) {
        score -= 0.3;
        reasons.push("使用了禁止的工具: " + t);
      }
    }

    for (const pattern of mustNotModifyFiles) {
      const violations = filesEdited.filter(function(f) { return f.startsWith(pattern) || f === pattern; });
      if (violations.length > 0) {
        score -= 0.5;
        reasons.push("修改了禁止的文件: " + violations.join(", "));
      }
    }

    // sideband metadata 缺失时的兜底：当 tools_used 数组为空且没有任何文件被编辑、step 为 0，
    // 说明 wrapper 没读到 trajectory（不是模型没合规）。这种情况下不应扣分，
    // 否则 22/25 case tool_compliance=0.6 的系统性偏差会持续。
    if (toolsUsed.length === 0 && filesEdited.length === 0 && (meta.total_steps || 0) === 0) {
      return {
        pass: true,
        score: 1.0,
        reason: "sideband metadata 缺失（trajectory 未落盘或读取失败），跳过工具合规检查",
      };
    }

    score = Math.max(0, score);
    return {
      pass: score >= 0.6,
      score,
      reason: reasons.length > 0 ? reasons.join("; ") : "工具使用合规",
    };
  `;
}

function buildEfficiencyAssertion(maxSteps: number): string {
  return `
    ${metaReaderSnippet()}
    const totalSteps = meta.total_steps || 0;
    const expectedMax = ${maxSteps};

    if (totalSteps === 0) return { pass: true, score: 1.0, reason: "无轨迹数据，跳过效率评估" };

    const ratio = totalSteps / expectedMax;
    let score = 1.0;
    let reason = "";

    if (ratio <= 1.0) {
      score = 1.0;
      reason = "步数 " + totalSteps + "/" + expectedMax + " 在预期内";
    } else if (ratio <= 1.5) {
      score = 0.7;
      reason = "步数偏多 " + totalSteps + "/" + expectedMax + " (" + ratio.toFixed(1) + "x)";
    } else if (ratio <= 2.0) {
      score = 0.4;
      reason = "步数超标 " + totalSteps + "/" + expectedMax + " (" + ratio.toFixed(1) + "x)";
    } else {
      score = 0.1;
      reason = "步数严重超标 " + totalSteps + "/" + expectedMax + " (" + ratio.toFixed(1) + "x)";
    }

    return { pass: score >= 0.6, score, reason };
  `;
}

function buildCostAssertion(): string {
  return `
    ${metaReaderSnippet()}
    const totalTokens = meta.total_tokens || 0;

    if (totalTokens === 0) return { pass: true, score: 1.0, reason: "无 token 数据，跳过成本评估" };

    let score = 1.0;
    let reason = "";

    if (totalTokens <= 200000) {
      score = 1.0;
      reason = "token 使用 " + (totalTokens/1000).toFixed(0) + "k，低消耗";
    } else if (totalTokens <= 500000) {
      score = 0.7;
      reason = "token 使用 " + (totalTokens/1000).toFixed(0) + "k，中等";
    } else if (totalTokens <= 1000000) {
      score = 0.4;
      reason = "token 使用 " + (totalTokens/1000).toFixed(0) + "k，偏高";
    } else {
      score = 0.2;
      reason = "token 使用 " + (totalTokens/1000).toFixed(0) + "k，严重超标";
    }

    return { pass: score >= 0.6, score, reason };
  `;
}

// ─── 主构建逻辑 ───

function buildTest(c: CaseYaml, minHits: number): PromptfooTest {
  const must = c.expected.must_include_any_of || [];

  const asserts: PromptfooAssert[] = [];

  // 1. 确定性断言: must_include_any_of(锚点命中)
  if (must.length > 0) {
    asserts.push({
      type: "contains-any",
      value: must,
      weight: 1.5,
      metric: "anchor_hit",
    });
  }

  // 2. must_not_include 融入 rubric prompt，由 LLM judge 做语义判断

  // 3. 模型评判: 综合 rubric
  asserts.push({
    type: "llm-rubric",
    value: buildRubricValue(c, minHits),
    weight: 4.0,
    metric: "rubric_score",
    threshold: 0.6,
  });

  // 4. 过程断言: tool_compliance（工具使用合规性）
  const mustCallTools = c.expected.must_call_tools || [];
  const mustCallMode = c.expected.must_call_tools_mode ?? "all_of";
  const mustNotCallTools = c.expected.must_not_call_tools || [];
  const mustNotModifyFiles = c.expected.must_not_modify_files || [];

  if (mustCallTools.length > 0 || mustNotCallTools.length > 0 || mustNotModifyFiles.length > 0) {
    asserts.push({
      type: "javascript",
      value: buildToolComplianceAssertion(mustCallTools, mustNotCallTools, mustNotModifyFiles, mustCallMode),
      weight: 1.5,
      metric: "tool_compliance",
    });
  }

  // 5. 过程断言: efficiency（效率）
  const maxSteps = c.expected.max_steps;
  if (maxSteps) {
    asserts.push({
      type: "javascript",
      value: buildEfficiencyAssertion(maxSteps),
      weight: 1.0,
      metric: "efficiency",
    });
  }

  // 6. 过程断言: cost（成本合理性）
  asserts.push({
    type: "javascript",
    value: buildCostAssertion(),
    weight: 0.5,
    metric: "cost",
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
