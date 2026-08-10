/**
 * 生成 CASES.md — 所有 eval case 的人类可读详情文档
 *
 * 用法: bun run evals/gen-cases-md.ts
 * 输出: evals/CASES.md
 */

import { resolve, join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dir);
const CASE_DIRS = [
  { dir: join(ROOT, "general", "p0-core"), label: "P0 核心" },
  { dir: join(ROOT, "general", "p1-common"), label: "P1 常见" },
  { dir: join(ROOT, "general", "p2-edge"), label: "P2 边缘" },
  { dir: join(ROOT, "holdout"), label: "Holdout 保留" },
];

const PROMPTFOO_REPORT = join(ROOT, "_reports/promptfoo-latest.json");
const EVAL_REPORT = join(ROOT, "_reports/eval-latest.json");

import type { CaseYaml, CaseBaselineEntry } from "eval-framework/core/types.ts";

interface PromptfooResult {
  provider: { label?: string; id?: string };
  testCase: { vars?: { case_id?: string } };
  response?: { output?: string };
  latencyMs?: number;
  score?: number;
  gradingResult?: {
    componentResults?: Array<{
      assertion?: { metric?: string; type?: string };
      pass?: boolean;
      score?: number;
      reason?: string;
    }>;
  };
}

function makeFence(content: string): string {
  let level = 3;
  const matches = content.match(/`{3,}/g);
  if (matches) {
    const max = Math.max(...matches.map(m => m.length));
    level = max + 1;
  }
  return "`".repeat(level);
}

function scoreEmoji(score: number | null | undefined): string {
  if (score == null) return "–";
  if (score >= 4.5) return `${score} ✅`;
  if (score >= 3.5) return `${score} 🟢`;
  if (score >= 2.5) return `${score} 🟡`;
  if (score >= 1.5) return `${score} 🟠`;
  return `${score} 🔴`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function stripMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, "")         // ## 标题 → 纯文本
    .replace(/^---+$/gm, "")              // --- 分割线
    .replace(/\*\*([^*]+)\*\*/g, "$1")    // **加粗** → 纯文本
    .replace(/^`{3,}.*$/gm, "")           // ```xxx 和 ``` 代码块标记全部去掉
    .replace(/`([^`]+)`/g, "$1")          // `行内代码` → 纯文本
    .replace(/\n{3,}/g, "\n\n");          // 多余空行
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function loadPromptfooResults(): Promise<Map<string, PromptfooResult[]>> {
  const map = new Map<string, PromptfooResult[]>();

  for (const reportPath of [EVAL_REPORT, PROMPTFOO_REPORT]) {
    try {
      const raw = await Bun.file(reportPath).text();
      const data = JSON.parse(raw);
      const results: PromptfooResult[] = data?.results?.results || [];
      for (const r of results) {
        const caseId = r.testCase?.vars?.case_id;
        if (!caseId) continue;
        if (!map.has(caseId)) map.set(caseId, []);
        map.get(caseId)!.push(r);
      }
      if (results.length > 0) break;
    } catch {
      // 文件不存在时静默跳过，尝试下一个
    }
  }
  return map;
}

function renderProviderDetail(
  name: string,
  baseline: CaseBaselineEntry,
  pfResult?: PromptfooResult,
): string[] {
  const lines: string[] = [];
  const score = baseline.score;
  const emoji = scoreEmoji(score);

  lines.push(`#### ${name} — ${emoji}`);
  lines.push("");

  // 元信息行
  const metaParts: string[] = [];
  if (baseline.tested_at) metaParts.push(`🕐 ${baseline.tested_at}`);
  if (baseline.tested_by) metaParts.push(`评分方式: ${baseline.tested_by}`);
  if (pfResult?.latencyMs) metaParts.push(`耗时: ${formatDuration(pfResult.latencyMs)}`);
  if (baseline.run_status && baseline.run_status !== "success") metaParts.push(`状态: ${baseline.run_status}`);
  if (metaParts.length > 0) {
    lines.push(metaParts.join(" | "));
    lines.push("");
  }

  // 维度拆解表
  if (baseline.dimensions) {
    lines.push(`| 维度 | 得分 | 说明 |`);
    lines.push(`| --- | --- | --- |`);
    const dimLabels: Record<string, string> = {
      anchor_hit: "锚点命中",
      rubric_score: "LLM 评判",
      tool_compliance: "工具合规",
      efficiency: "效率",
      cost: "成本",
    };
    const dimWeights: Record<string, number> = {
      anchor_hit: 1.5,
      rubric_score: 4.0,
      tool_compliance: 1.5,
      negative_anchor: 2.0,
      // 5d-v2 起 efficiency / cost 权重为 0（诊断维度，不进总分）
      efficiency: 0,
      cost: 0,
    };

    // 从 promptfoo componentResults 提取各维度的 reason
    const dimReasons: Record<string, string> = {};
    if (pfResult?.gradingResult?.componentResults) {
      for (const comp of pfResult.gradingResult.componentResults) {
        const metric = comp.assertion?.metric;
        if (metric && comp.reason) {
          dimReasons[metric] = comp.reason;
        }
      }
    }

    for (const [dim, val] of Object.entries(baseline.dimensions)) {
      const label = dimLabels[dim] || dim;
      const weight = dimWeights[dim] || 1;
      let reason = dimReasons[dim] || "";

      if (val >= 1.0) {
        // 满分：简短显示，不占注意力
        lines.push(`| ${label} (×${weight}) | ✅ ${val} | — |`);
      } else if (val >= 0.6) {
        // 通过但有扣分
        reason = reason ? `⚠️ **${truncate(reason, 150)}**` : "轻微扣分";
        lines.push(`| ${label} (×${weight}) | ⚡ ${val} | ${reason} |`);
      } else {
        // 未通过，严重扣分
        reason = reason ? `🚨 **${truncate(reason, 200)}**` : "严重不足";
        lines.push(`| ${label} (×${weight}) | ❌ ${val} | ${reason} |`);
      }
    }
    lines.push("");
  }

  // 实际回答摘要
  if (pfResult?.response?.output) {
    const output = pfResult.response.output.trim();
    const cleaned = stripMarkdown(truncate(output, 1500));
    lines.push(`<details><summary>💬 实际回答（${output.length} 字）</summary>`);
    lines.push("");
    lines.push("```");
    lines.push(cleaned);
    lines.push("```");
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  // 备注
  if (baseline.notes?.trim()) {
    lines.push(`> 📌 ${baseline.notes.trim()}`);
    lines.push("");
  }

  // transcript 链接
  if (baseline.transcript_path) {
    lines.push(`> 📄 轨迹: \`${baseline.transcript_path}\``);
    lines.push("");
  }

  return lines;
}

function renderHoldoutCaseSummary(c: CaseYaml, dir: string): string {
  const lines: string[] = [];
  lines.push(`### ${c.id} 🔒 — ${c.category}`);
  lines.push("");
  lines.push(`| 字段 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 优先级 | **${c.priority}** |`);
  lines.push(`| 类别 | ${c.category} |`);
  lines.push(`| 目录 | \`${basename(dir)}/\` |`);
  lines.push("");
  lines.push(`> 🔒 **holdout** — 题面 / 锚点 / 反例 / 参考答案 / rubric 已隔离，不在 CASES.md 渲染。`);
  lines.push(`> 详情仅可在私有路径 \`evals/holdout/\` 直接 cat yaml 查看；跑分见 \`evals/_meta/_private/\`（如有）。`);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

function renderCase(c: CaseYaml, dir: string, pfResults: PromptfooResult[]): string {
  if (c.holdout) {
    return renderHoldoutCaseSummary(c, dir);
  }

  const lines: string[] = [];

  lines.push(`### ${c.id} — ${c.category}`);
  lines.push("");
  lines.push(`| 字段 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 优先级 | **${c.priority}** |`);
  lines.push(`| 类别 | ${c.category} |`);
  lines.push(`| 目录 | \`${basename(dir)}/\` |`);
  lines.push(`| 创建日期 | ${c.created_date} |`);
  lines.push(`| 评测类型 | ${c.eval_type} |`);
  lines.push(`| 目标分 | ${c.target_score} |`);
  if (c.related_subsystem?.length) {
    lines.push(`| 关联子系统 | ${c.related_subsystem.join(", ")} |`);
  }
  lines.push("");

  // 题面
  lines.push(`**📝 题面（user_query）**`);
  lines.push("");
  lines.push(`> ${c.input.user_query}`);
  lines.push("");

  // 期望输出
  lines.push(`**🎯 期望输出**`);
  lines.push("");
  lines.push(`- outcome: \`${c.expected.outcome}\``);
  if (c.expected.must_include_any_of?.length) {
    lines.push(`- 锚点关键词（命中任一即可）:`);
    for (const k of c.expected.must_include_any_of) {
      lines.push(`  - \`${k}\``);
    }
  }
  if (c.expected.must_not_include?.length) {
    lines.push(`- 禁止出现:`);
    for (const k of c.expected.must_not_include) {
      lines.push(`  - \`${k}\``);
    }
  }
  if (c.expected.must_call_tools?.length) {
    lines.push(`- 必须调用工具: ${c.expected.must_call_tools.map(t => `\`${t}\``).join(", ")}`);
  }
  if (c.expected.must_not_call_tools?.length) {
    lines.push(`- 禁止调用工具: ${c.expected.must_not_call_tools.map(t => `\`${t}\``).join(", ")}`);
  }
  if (c.expected.must_not_modify_files?.length) {
    lines.push(`- 禁止修改文件: ${c.expected.must_not_modify_files.map(f => `\`${f}\``).join(", ")}`);
  }
  if (c.expected.max_steps) {
    lines.push(`- 最大步数: ${c.expected.max_steps}`);
  }
  lines.push("");

  // 参考答案
  if (c.expected.reference_answer?.trim()) {
    const refText = c.expected.reference_answer.trim();
    const refFence = makeFence(refText);
    lines.push(`<details><summary>📖 参考答案（展开）</summary>`);
    lines.push("");
    lines.push(refFence);
    lines.push(refText);
    lines.push(refFence);
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  // Rubric
  if (c.rubric) {
    lines.push(`**📐 评判维度（Rubric）**`);
    lines.push("");
    lines.push(`| 维度 | 标准 |`);
    lines.push(`| --- | --- |`);
    if (c.rubric.completeness) lines.push(`| completeness | ${c.rubric.completeness} |`);
    if (c.rubric.precision) lines.push(`| precision | ${c.rubric.precision} |`);
    if (c.rubric.helpfulness) lines.push(`| helpfulness | ${c.rubric.helpfulness} |`);
    lines.push("");
  }

  // 评分权重说明
  lines.push(`**⚖️ 评分公式**`);
  lines.push("");
  lines.push(`\`anchor_hit(×1.5) + rubric_score(×4.0) + tool_compliance(×1.5) + negative_anchor(×2.0) + efficiency(×0) + cost(×0) = 总权 9.0 → 归一化 5 分\` (grader 5d-v2)`);
  lines.push("");

  // 各 Provider 详细得分
  if (c.baseline_scores) {
    const providers = Object.entries(c.baseline_scores).filter(
      ([_, v]) => v && (v.score != null || v.run_status !== "pending")
    );
    if (providers.length > 0) {
      lines.push(`**📊 各 Provider 评分详情**`);
      lines.push("");

      // 先来一个快速对比表
      lines.push(`| Provider | 分数 | 状态 | 评分时间 |`);
      lines.push(`| --- | --- | --- | --- |`);
      for (const [name, v] of providers) {
        const time = v.tested_at ? v.tested_at.replace("T", " ").slice(0, 19) : "–";
        lines.push(`| ${name} | ${scoreEmoji(v.score)} | ${v.run_status} | ${time} |`);
      }
      lines.push("");

      // 有维度数据的 provider 展开详情
      const _detailProviders = providers.filter(
        ([_, v]) => v.dimensions || v.notes?.trim() || v.transcript_path
      );

      // 也找 promptfoo 里有实际回答的
      const pfProviderMap = new Map<string, PromptfooResult>();
      for (const r of pfResults) {
        const label = r.provider?.label || "";
        pfProviderMap.set(label, r);
      }

      const expandProviders = providers.filter(([name, v]) => {
        // 有维度 or 有 promptfoo 回答
        const pfKey = name.replace(/_/g, "-");
        return v.dimensions || pfProviderMap.has(pfKey) || pfProviderMap.has(name) || v.notes?.trim() || v.transcript_path;
      });

      if (expandProviders.length > 0) {
        lines.push(`<details><summary>🔍 展开各 Provider 维度拆解 + 实际回答</summary>`);
        lines.push("");

        for (const [name, v] of expandProviders) {
          // 匹配 promptfoo result（YAML 用下划线 sid_code_opus47，promptfoo 用连字符 sid-code-opus47）
          const pfKey = name.replace(/_/g, "-");
          const pfr = pfProviderMap.get(pfKey) || pfProviderMap.get(name);
          const detail = renderProviderDetail(name, v, pfr);
          lines.push(...detail);
        }

        lines.push(`</details>`);
        lines.push("");
      }
    }
  }

  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const allCases: { case_: CaseYaml; dir: string }[] = [];

  for (const { dir } of CASE_DIRS) {
    const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));
    for (const f of files.sort()) {
      const content = await Bun.file(join(dir, f)).text();
      const c = parseYaml(content) as CaseYaml;
      allCases.push({ case_: c, dir });
    }
  }

  allCases.sort((a, b) => {
    const numA = parseInt(a.case_.id.replace("case_", ""));
    const numB = parseInt(b.case_.id.replace("case_", ""));
    return numA - numB;
  });

  // 加载 promptfoo 结果
  const pfMap = await loadPromptfooResults();

  // 生成文档
  const out: string[] = [];
  out.push(`# Eval Cases 详情手册`);
  out.push("");
  out.push(`> 自动生成，请勿手动编辑。运行 \`bun run evals/gen-cases-md.ts\` 刷新。`);
  out.push(`> 生成时间: ${new Date().toISOString()}`);
  out.push(`> 数据源: case YAML + \`_reports/promptfoo-latest.json\``);
  out.push("");

  // 总览表
  out.push(`## 总览`);
  out.push("");
  out.push(`共 **${allCases.length}** 条 case。`);
  out.push("");
  out.push(`| # | ID | 类别 | 优先级 | 目标分 | 题面摘要 |`);
  out.push(`| --- | --- | --- | --- | --- | --- |`);
  for (let i = 0; i < allCases.length; i++) {
    const c = allCases[i].case_;
    const lock = c.holdout ? " 🔒" : "";
    const summary = c.holdout
      ? "🔒 题面已隔离"
      : c.input.user_query.slice(0, 50) + (c.input.user_query.length > 50 ? "…" : "");
    const anchor = `${c.id}--${c.category}`.toLowerCase().replace(/[^\w一-鿿-]/g, "-");
    out.push(`| ${i + 1} | [${c.id}${lock}](#${anchor}) | ${c.category} | ${c.priority} | ${c.target_score} | ${summary} |`);
  }
  out.push("");

  // 按层级分组输出详情
  for (const { dir, label } of CASE_DIRS) {
    const groupCases = allCases.filter(x => x.dir === dir);
    if (groupCases.length === 0) continue;

    out.push(`## ${label}（${basename(dir)}/）`);
    out.push("");

    for (const { case_ } of groupCases) {
      const pfResults = pfMap.get(case_.id) || [];
      out.push(renderCase(case_, dir, pfResults));
    }
  }

  const outPath = join(ROOT, "CASES.md");
  await Bun.write(outPath, out.join("\n"));
  console.log(`✅ 已生成 ${allCases.length} 条 case 详情 → ${outPath}`);
  console.log(`   含 promptfoo 结果: ${pfMap.size} 个 case 有跑分数据`);
}

main();
