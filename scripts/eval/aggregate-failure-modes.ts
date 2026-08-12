#!/usr/bin/env bun
/**
 * aggregate-failure-modes.ts — B0-3 MVP-T03 聚合脚本
 *
 * 用法：
 *   bun run scripts/eval/aggregate-failure-modes.ts [_reports/sid-vs-claude/diff-*.json]
 *   不传参数 → 读 _reports/sid-vs-claude/diff-*.json 全部
 *
 * 输出：
 *   - _reports/sid-vs-claude/sprint-S5-gap-report.md
 *   - 含 Top 5 失败模式 + 全量证据 + 修复建议聚类
 *
 * 设计原则：
 *   - 不调 LLM，纯 JS 聚合（避免聚合阶段 cost 爆炸）
 *   - 按 failure_modes[].code 前缀（TS / EX / CTX / TOOL / LOOP / ABORT / OUT）分类
 *   - 输出按出现次数 + 平均 severity 排序
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REPORTS_DIR = join(REPO_ROOT, "_reports/sid-vs-claude");

interface DiffEntry {
  task_id: string;
  task_summary: string;
  task_difficulty: string;
  step_diff: { sid: number; claude: number; ratio: number };
  tool_choice_divergence: Array<{
    step: string;
    sid_used: string;
    claude_used: string;
    verdict: string;
  }>;
  failure_modes: Array<{
    code: string;
    title: string;
    evidence: string;
    severity: "high" | "medium" | "low";
  }>;
  fix_suggestions: Array<{
    type: string;
    target: string;
    content: string;
  }>;
  meta: {
    sid_steps: number;
    claude_steps: number;
    sid_tools: string[];
    claude_tools: string[];
    sid_status: string;
    sid_abnormal_reason?: string;
  };
}

const SEV_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

function loadDiffs(paths: string[]): DiffEntry[] {
  const list: DiffEntry[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.warn(`[aggregate] 跳过不存在: ${p}`);
      continue;
    }
    try {
      const d = JSON.parse(readFileSync(p, "utf-8")) as DiffEntry;
      list.push(d);
    } catch (e) {
      console.warn(`[aggregate] ${p} parse 失败: ${(e as Error).message}`);
    }
  }
  return list;
}

function clusterFailureModes(diffs: DiffEntry[]): Array<{
  prefix: string;
  total_count: number;
  avg_severity: number;
  task_coverage: string[];
  examples: Array<{
    task_id: string;
    code: string;
    title: string;
    evidence: string;
    severity: string;
  }>;
}> {
  const map = new Map<
    string,
    {
      prefix: string;
      total_count: number;
      sev_sum: number;
      tasks: Set<string>;
      examples: Array<{
        task_id: string;
        code: string;
        title: string;
        evidence: string;
        severity: string;
      }>;
    }
  >();

  for (const d of diffs) {
    for (const fm of d.failure_modes ?? []) {
      const prefix = fm.code.split("-")[0] ?? "UNK";
      if (!map.has(prefix)) {
        map.set(prefix, { prefix, total_count: 0, sev_sum: 0, tasks: new Set(), examples: [] });
      }
      const c = map.get(prefix)!;
      c.total_count += 1;
      c.sev_sum += SEV_WEIGHT[fm.severity] ?? 1;
      c.tasks.add(d.task_id);
      if (c.examples.length < 5) {
        c.examples.push({
          task_id: d.task_id,
          code: fm.code,
          title: fm.title,
          evidence: fm.evidence.slice(0, 200),
          severity: fm.severity,
        });
      }
    }
  }
  return [...map.values()]
    .map((c) => ({
      prefix: c.prefix,
      total_count: c.total_count,
      avg_severity: c.total_count > 0 ? Math.round((c.sev_sum / c.total_count) * 100) / 100 : 0,
      task_coverage: [...c.tasks].sort(),
      examples: c.examples,
    }))
    .sort(
      (a, b) =>
        b.total_count * b.avg_severity - a.total_count * a.avg_severity ||
        b.task_coverage.length - a.task_coverage.length,
    );
}

function clusterFixSuggestions(
  diffs: DiffEntry[],
): Array<{ type: string; total_count: number; targets: string[]; sample_contents: string[] }> {
  const map = new Map<string, { total_count: number; targets: Set<string>; samples: string[] }>();
  for (const d of diffs) {
    for (const f of d.fix_suggestions ?? []) {
      if (!map.has(f.type)) map.set(f.type, { total_count: 0, targets: new Set(), samples: [] });
      const v = map.get(f.type)!;
      v.total_count += 1;
      v.targets.add(f.target);
      if (v.samples.length < 3) v.samples.push(`(${d.task_id}) ${f.content.slice(0, 160)}`);
    }
  }
  return [...map.entries()]
    .map(([type, v]) => ({
      type,
      total_count: v.total_count,
      targets: [...v.targets].sort(),
      sample_contents: v.samples,
    }))
    .sort((a, b) => b.total_count - a.total_count);
}

function renderMarkdown(diffs: DiffEntry[]): string {
  const clusters = clusterFailureModes(diffs);
  const top5 = clusters.slice(0, 5);
  const fixes = clusterFixSuggestions(diffs);

  const totalSidSteps = diffs.reduce((s, d) => s + d.step_diff.sid, 0);
  const totalClaudeSteps = diffs.reduce((s, d) => s + d.step_diff.claude, 0);
  const avgRatio =
    diffs.length > 0
      ? Math.round((diffs.reduce((s, d) => s + (d.step_diff.ratio || 0), 0) / diffs.length) * 100) /
        100
      : 0;
  const abnormalCount = diffs.filter((d) => d.meta.sid_status !== "ok").length;

  const lines: string[] = [];
  lines.push(`# sid-vs-claude 差距报告 — Sprint S5 MVP`);
  lines.push("");
  lines.push(`> 自动生成 / paired-trajectory-diff.ts + aggregate-failure-modes.ts`);
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(
    `> 输入：${diffs.length} 条 paired comparison（trajectory-platform/bench/splits/capability.txt 选取）`,
  );
  lines.push(`> 路线对应：B0-3 MVP-T03（agent-eval-真化路线-v1.md §13.8）`);
  lines.push("");
  lines.push("## 1. 总览");
  lines.push("");
  lines.push(`- paired comparison 条数：${diffs.length}`);
  lines.push(
    `- sid-code 总步数：${totalSidSteps}（平均 ${diffs.length > 0 ? (totalSidSteps / diffs.length).toFixed(1) : 0}）`,
  );
  lines.push(
    `- claude primary 总步数：${totalClaudeSteps}（平均 ${diffs.length > 0 ? (totalClaudeSteps / diffs.length).toFixed(1) : 0}）`,
  );
  lines.push(
    `- 平均步数比 (sid / claude)：**${avgRatio}**${avgRatio > 1.5 ? "（sid 步数显著偏多，疑似探索/重试过多）" : avgRatio < 0.5 ? "（sid 步数偏少，疑似过早收尾）" : ""}`,
  );
  lines.push(`- sid-code 异常完成数：${abnormalCount} / ${diffs.length}`);
  lines.push("");
  lines.push(
    "> ⚠️ §15.2 修订：步数差**不等同**错误信号；本节「步数比」仅作整体探索强度参考，不进 grader 总分。",
  );
  lines.push("");

  lines.push("## 2. Top 5 失败模式（按 count × 平均 severity 排序）");
  lines.push("");
  if (top5.length === 0) {
    lines.push("（无失败模式聚合）");
  } else {
    lines.push("| 排名 | 类别 | 出现次数 | 平均 severity | 影响 task 数 | 示例 task |");
    lines.push("| --- | --- | ---: | ---: | ---: | --- |");
    top5.forEach((c, i) => {
      lines.push(
        `| ${i + 1} | **${c.prefix}** | ${c.total_count} | ${c.avg_severity} | ${c.task_coverage.length} | ${c.task_coverage.slice(0, 3).join(", ")} |`,
      );
    });
  }
  lines.push("");

  lines.push("## 3. 失败模式详情（每类 Top 5 证据）");
  lines.push("");
  for (const c of top5) {
    lines.push(`### ${c.prefix}（共 ${c.total_count} 次 / ${c.task_coverage.length} 个 task）`);
    lines.push("");
    if (c.examples.length === 0) {
      lines.push("（无证据）");
    } else {
      for (const ex of c.examples) {
        lines.push(`- **${ex.task_id} / ${ex.code} / ${ex.severity}** — ${ex.title}`);
        lines.push(`  - 证据：${ex.evidence}`);
      }
    }
    lines.push("");
  }

  lines.push("## 4. 修复建议聚类");
  lines.push("");
  if (fixes.length === 0) {
    lines.push("（无修复建议）");
  } else {
    for (const f of fixes) {
      lines.push(`### type=${f.type}（${f.total_count} 次）`);
      lines.push("");
      lines.push(
        `涉及 target：${f.targets.length === 0 ? "(无)" : f.targets.map((t) => `\`${t}\``).join(", ")}`,
      );
      lines.push("");
      if (f.sample_contents.length > 0) {
        lines.push(`样本：`);
        for (const s of f.sample_contents) lines.push(`  - ${s}`);
      }
      lines.push("");
    }
  }

  lines.push("## 5. 逐 task step_diff 表");
  lines.push("");
  lines.push(
    "| task | difficulty | sid steps | claude steps | ratio | sid status | failure modes |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | --- | ---: |");
  for (const d of diffs) {
    lines.push(
      `| ${d.task_id} | ${d.task_difficulty} | ${d.step_diff.sid} | ${d.step_diff.claude} | ${d.step_diff.ratio} | ${d.meta.sid_status}${d.meta.sid_abnormal_reason ? ` (${d.meta.sid_abnormal_reason.slice(0, 40)})` : ""} | ${d.failure_modes.length} |`,
    );
  }
  lines.push("");

  lines.push("## 6. spot-check 指引");
  lines.push("");
  lines.push("人工 spot-check 5 条标注准确率（MVP-T03 出口标准）：");
  lines.push("");
  for (let i = 0; i < Math.min(5, diffs.length); i++) {
    const d = diffs[i];
    lines.push(
      `- [ ] ${d.task_id}（${d.failure_modes.length} 条失败模式）—— 看 \`_reports/sid-vs-claude/diff-${d.task_id}.json\``,
    );
  }
  lines.push("");
  lines.push(
    "准确率合格线：≥ 4/5 标注与 LLM judge 一致 → 报告进入下一步（B0-4 据 Top 失败模式补 SKILL 规则）。",
  );
  lines.push("");

  lines.push("## 7. 下一步");
  lines.push("");
  lines.push(
    "1. B0-4：从 Top 1 失败模式（上表 §2 第 1 行）选最高频的 fix_suggestion → 落到 `packages/core/src/skill/builtin/<skill-name>/SKILL.md`，**走 L3 core_code 审批**",
  );
  lines.push("2. 跑 1507 单测确保 SKILL.md 增量无回归");
  lines.push(
    "3. 下个 Sprint 重跑同样 10 条 paired comparison，看该 Top 失败模式占比是否下降（数据飞轮 v0）",
  );
  lines.push("");

  return lines.join("\n");
}

function main(): void {
  let inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    if (!existsSync(REPORTS_DIR)) {
      console.error(`[aggregate] ${REPORTS_DIR} 不存在；先跑 paired-trajectory-diff.ts`);
      process.exit(1);
    }
    inputs = readdirSync(REPORTS_DIR)
      .filter((n) => n.startsWith("diff-") && n.endsWith(".json"))
      .map((n) => join(REPORTS_DIR, n));
  }
  if (inputs.length === 0) {
    console.error("[aggregate] 没有 diff-*.json 输入");
    process.exit(1);
  }
  console.log(`[aggregate] 输入 ${inputs.length} 条 diff JSON`);
  const diffs = loadDiffs(inputs);
  if (diffs.length === 0) {
    console.error("[aggregate] 无可用 diff，退出");
    process.exit(1);
  }
  const md = renderMarkdown(diffs);
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, "sprint-S5-gap-report.md");
  writeFileSync(outPath, md);
  console.log(`[aggregate] wrote ${outPath} (${md.length} chars / ${diffs.length} diffs)`);
}

if (import.meta.main) {
  main();
}
