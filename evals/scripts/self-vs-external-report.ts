// self-vs-external-report.ts — Sprint 末 self_score vs external 双轨 gap 报告自动生成(B8-5)
//
// 状态:骨架(B8-5),等 S8 实施者跑通双轨 baseline 后串通真实数据
// 关联:
//   _reports/templates/self-vs-external.md(本脚本输出模板)
//   evals/scripts/run-external-baseline.ts(外部锚双轨数据源)
//   evals/_runs/{provider}.jsonl(self_score 数据源)
//
// 用法:
//   bun run evals/scripts/self-vs-external-report.ts --sprint S8
//   bun run evals/scripts/self-vs-external-report.ts --sprint S8 --provider sid_code_deepseek_v4_pro
//   bun run evals/scripts/self-vs-external-report.ts --validate  # 不实跑,只校验前置就位
//
// 数据隔离铁律(CLAUDE.md §0.4 + §9.3):
//   - self_score 仅取 5d-v4 grader entries(legacy 自动过滤)
//   - 不污染 evals/DASHBOARD.md / evals/_scores/wNN/
//   - 输出独立到 _reports/external/self-vs-external-{date}.md
//
// Sprint 末必跑流程(M5 Gate 起,§10.3 监控指标第 4 项):
//   不报 → Sprint 报告作废

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");
const RUNS_DIR = join(REPO_ROOT, "evals/_runs");
const REPORTS_DIR = join(REPO_ROOT, "_reports/external");
const TEMPLATE_PATH = join(REPO_ROOT, "_reports/templates/self-vs-external.md");

interface CliArgs {
  sprint: string; // 如 "S8"
  provider: string;
  date: string;
  validate: boolean;
  external_report: string; // _reports/external/inspect-{date}.md
}

function parseArgs(argv: string[]): CliArgs {
  let sprint = "S8";
  let provider = "sid_code_deepseek_v4_pro";
  let date = process.env.SID_CODE_REPORT_DATE ?? "TODO";
  let validate = false;
  let external_report = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sprint") sprint = argv[++i];
    else if (arg === "--provider") provider = argv[++i];
    else if (arg === "--date") date = argv[++i];
    else if (arg === "--validate") validate = true;
    else if (arg === "--external-report") external_report = argv[++i];
  }
  if (!external_report) {
    external_report = join(REPORTS_DIR, `inspect-${date}.md`);
  }
  return { sprint, provider, date, validate, external_report };
}

interface PreflightCheck {
  name: string;
  check: () => { ok: boolean; reason?: string };
}

function preflight(args: CliArgs): { allOk: boolean; report: string[] } {
  const checks: PreflightCheck[] = [
    {
      name: `evals/_runs/${args.provider}.jsonl 存在(self_score 数据源)`,
      check: () => {
        const path = join(RUNS_DIR, `${args.provider}.jsonl`);
        if (!existsSync(path)) return { ok: false, reason: `缺文件: ${path}` };
        return { ok: true };
      },
    },
    {
      name: `${args.external_report} 存在(external 双轨数据源)`,
      check: () => {
        if (!existsSync(args.external_report))
          return {
            ok: false,
            reason: `缺文件: ${args.external_report}(先跑 run-external-baseline.ts)`,
          };
        return { ok: true };
      },
    },
    {
      name: `_reports/templates/self-vs-external.md 模板存在`,
      check: () => {
        if (!existsSync(TEMPLATE_PATH)) return { ok: false, reason: `缺模板: ${TEMPLATE_PATH}` };
        return { ok: true };
      },
    },
    {
      name: "_reports/external/ 目录可写",
      check: () => {
        if (!existsSync(REPORTS_DIR)) {
          try {
            mkdirSync(REPORTS_DIR, { recursive: true });
          } catch (err) {
            return { ok: false, reason: `mkdir 失败: ${err}` };
          }
        }
        return { ok: true };
      },
    },
  ];

  const report: string[] = [];
  let allOk = true;
  for (const c of checks) {
    const r = c.check();
    if (r.ok) {
      report.push(`  ✅ ${c.name}`);
    } else {
      allOk = false;
      report.push(`  ❌ ${c.name}  →  ${r.reason}`);
    }
  }
  return { allOk, report };
}

interface SelfStats {
  avg_score_5d_v4: number | null;
  pass_rate: number | null;
  hard_subset_avg: number | null;
  report_type_avg: number | null; // 报告型 case 平均
  exec_type_avg: number | null; // 修改型 case 平均
  count_5d_v4: number;
  count_legacy: number;
}

function loadSelfStats(provider: string): SelfStats {
  const path = join(RUNS_DIR, `${provider}.jsonl`);
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  const v4 = lines.filter(
    (e) => (e._formula_version as Record<string, string> | undefined)?.grader === "5d-v4",
  );
  const legacy = lines.length - v4.length;

  if (v4.length === 0) {
    return {
      avg_score_5d_v4: null,
      pass_rate: null,
      hard_subset_avg: null,
      report_type_avg: null,
      exec_type_avg: null,
      count_5d_v4: 0,
      count_legacy: legacy,
    };
  }

  const successEntries = v4.filter((e) => (e.status as string) === "success");
  const scores = successEntries
    .map((e) => Number(e.total_score ?? NaN))
    .filter((n) => !Number.isNaN(n));

  const avg_score_5d_v4 = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const pass_count = successEntries.filter((e) => {
    const mp = e.mandatory_pass;
    if (mp === false) return false;
    const ts = Number(e.total_score ?? 0);
    return ts >= 3.5; // GA 阈值
  }).length;
  const pass_rate = successEntries.length ? pass_count / successEntries.length : null;

  // 难度 hard 子集 / 报告型 / 修改型 — 等 case yaml 落 difficulty / category 后启用
  // 骨架阶段返回 null,S8 实施者按 case yaml 字段分类聚合
  return {
    avg_score_5d_v4,
    pass_rate,
    hard_subset_avg: null,
    report_type_avg: null,
    exec_type_avg: null,
    count_5d_v4: v4.length,
    count_legacy: legacy,
  };
}

interface ExternalStats {
  exec_pass_at_1: number | null;
  exec_total: number | null;
  exec_pass: number | null;
  report_pass_rate: number | null;
  report_avg_total: number | null;
  report_must_flag_recall: number | null;
  report_precision: number | null;
  disagreement_rate: number | null;
}

function parseExternalReport(path: string): ExternalStats {
  const content = readFileSync(path, "utf-8");
  const exec_match = content.match(/\*\*pass@1\*\*:\s*([\d.]+)%\s*\((\d+)\/(\d+)\)/);
  const report_match = content.match(/\*\*pass_rate\*\*:\s*([\d.]+)%\s*\((\d+)\/(\d+)\)/);

  return {
    exec_pass_at_1: exec_match ? Number(exec_match[1]) / 100 : null,
    exec_pass: exec_match ? Number(exec_match[2]) : null,
    exec_total: exec_match ? Number(exec_match[3]) : null,
    report_pass_rate: report_match ? Number(report_match[1]) / 100 : null,
    report_avg_total: null,
    report_must_flag_recall: null,
    report_precision: null,
    disagreement_rate: null,
  };
}

function gapStatus(gap: number | null): string {
  if (gap === null) return "—";
  if (Math.abs(gap) <= 0.2) return "✅";
  if (Math.abs(gap) <= 0.4) return "⚠️";
  return "❌";
}

function fmt(n: number | null, digits = 3): string {
  if (n === null) return "—";
  return n.toFixed(digits);
}

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function renderReport(args: CliArgs, self: SelfStats, ext: ExternalStats): string {
  // 修改型 gap (执行轨)
  const exec_gap =
    self.exec_type_avg !== null && ext.exec_pass_at_1 !== null
      ? self.exec_type_avg / 5 - ext.exec_pass_at_1 // self 0-5 锚点归一化到 0-1
      : null;

  // 报告型 gap (报告轨)
  const report_gap =
    self.report_type_avg !== null && ext.report_avg_total !== null
      ? self.report_type_avg / 5 - ext.report_avg_total
      : null;

  const lines: string[] = [];
  lines.push(`# self-vs-external gap — Sprint ${args.sprint} (${args.date})`);
  lines.push("");
  lines.push(`> 模型: ${args.provider}`);
  lines.push(`> Sprint: ${args.sprint}`);
  lines.push(
    `> Self 数据源: \`evals/_runs/${args.provider}.jsonl\`(仅 5d-v4 grader,过滤 ${self.count_legacy} 条 legacy)`,
  );
  lines.push(`> External 数据源: \`${args.external_report.replace(REPO_ROOT, ".")}\``);
  lines.push("");
  lines.push("---");
  lines.push("");

  // === TL;DR ===
  lines.push("## 0. TL;DR");
  lines.push("");
  lines.push(
    `- 修改型 Skill: self_avg = ${fmt(self.exec_type_avg)} / external_pass@1 = ${pct(ext.exec_pass_at_1)} / **gap = ${fmt(exec_gap)}** ${gapStatus(exec_gap)}`,
  );
  lines.push(
    `- 报告型 Skill: self_avg = ${fmt(self.report_type_avg)} / cr_majority = ${fmt(ext.report_avg_total)} / **gap = ${fmt(report_gap)}** ${gapStatus(report_gap)}`,
  );
  lines.push(`- gap 阈值 0.2: 执行轨 ${gapStatus(exec_gap)}, 报告轨 ${gapStatus(report_gap)}`);
  lines.push("");
  lines.push("> gap > 0.2 → 警示自家 case 偏向; gap > 0.4 → Sprint 报告作废,必须重跑 + 调整");
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 执行轨 ===
  lines.push("## 1. 修改型 Skill 对照(执行轨)");
  lines.push("");
  lines.push("| 项 | self_score | external | gap | 状态 |");
  lines.push("| --- | ---: | ---: | ---: | :---: |");
  lines.push(
    `| 平均分(归一化) | ${fmt(self.exec_type_avg !== null ? self.exec_type_avg / 5 : null)} | ${fmt(ext.exec_pass_at_1)} | ${fmt(exec_gap)} | ${gapStatus(exec_gap)} |`,
  );
  lines.push(`| pass_rate | ${pct(self.pass_rate)} | ${pct(ext.exec_pass_at_1)} | — | — |`);
  lines.push(`| 难度 hard 子集 | ${fmt(self.hard_subset_avg)} | — | — | — |`);
  lines.push("");
  lines.push("### 1.1 异常解读");
  lines.push("");
  lines.push("> 若 self_avg ↑ 而 external ↓ → 自家 case 漂移信号(警示)");
  lines.push("> 若 self_avg ↓ 而 external ↑ → grader 收紧但能力真实提升(健康)");
  lines.push("> 若 self_avg / external 同步 → 能力真实变化(健康)");
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 报告轨 ===
  lines.push("## 2. 报告型 Skill 对照(报告轨)");
  lines.push("");
  lines.push("| 项 | self_score | external_majority | gap | 状态 |");
  lines.push("| --- | ---: | ---: | ---: | :---: |");
  lines.push(
    `| 平均 total_score | ${fmt(self.report_type_avg)} | ${fmt(ext.report_avg_total)} | ${fmt(report_gap)} | ${gapStatus(report_gap)} |`,
  );
  lines.push(`| must_flag recall | — | ${fmt(ext.report_must_flag_recall)} | — | — |`);
  lines.push(`| precision | — | ${fmt(ext.report_precision)} | — | — |`);
  lines.push(`| judge 分歧度 | — | ${fmt(ext.disagreement_rate)} | — | — |`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 双轨综合判定 ===
  lines.push("## 3. 双轨综合判定");
  lines.push("");
  lines.push("| 维度 | 阈值 | 当前 | 判定 |");
  lines.push("| --- | --- | --- | :---: |");
  lines.push(`| 执行轨 gap ≤ 0.2 | M5 Gate 准入 | ${fmt(exec_gap)} | ${gapStatus(exec_gap)} |`);
  lines.push(`| 报告轨 gap ≤ 0.2 | M5 Gate 准入 | ${fmt(report_gap)} | ${gapStatus(report_gap)} |`);
  const worst_gap = [exec_gap, report_gap]
    .filter((g): g is number => g !== null)
    .reduce<number>((max, g) => Math.max(max, Math.abs(g)), 0);
  const trigger = worst_gap > 0.4 ? "❌" : "✅";
  lines.push(`| 双轨任一 gap > 0.4 | 报告作废 trigger | worst=${fmt(worst_gap)} | ${trigger} |`);
  lines.push("");

  // === 行动项 ===
  lines.push("## 4. 行动项");
  lines.push("");
  if (
    (exec_gap !== null && Math.abs(exec_gap) > 0.2) ||
    (report_gap !== null && Math.abs(report_gap) > 0.2)
  ) {
    lines.push("> gap > 0.2,必须填行动项");
    lines.push("");
    lines.push("- [ ] 行动项 1: ...");
    lines.push("- [ ] 行动项 2: ...");
  } else {
    lines.push("> gap 在阈值内,可省略");
  }
  lines.push("");

  // === 数据隔离 ===
  lines.push("## 5. 数据隔离声明");
  lines.push("");
  lines.push("- self_score 仅取 5d-v4 grader entries(过滤 legacy)");
  lines.push("- external 来源: 双轨独立报告 §1 §2");
  lines.push("- gap 计算口径: 都归一化到 0-1,绝对值比较");
  lines.push("- 不污染 `evals/DASHBOARD.md` / `evals/_scores/wNN/`");
  lines.push("");

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[self-vs-external] sprint=${args.sprint} provider=${args.provider} date=${args.date}`,
  );

  const { allOk, report } = preflight(args);
  console.log("[self-vs-external/preflight]");
  for (const line of report) console.log(line);

  if (!allOk) {
    console.error("[self-vs-external] preflight 失败,请按上方 ❌ 提示补齐");
    process.exit(1);
  }

  if (args.validate) {
    console.log("[self-vs-external] --validate 模式,前置就位 ✅");
    return;
  }

  const self = loadSelfStats(args.provider);
  const ext = parseExternalReport(args.external_report);
  const md = renderReport(args, self, ext);
  const outPath = join(REPORTS_DIR, `self-vs-external-${args.date}.md`);
  writeFileSync(outPath, md, "utf-8");
  console.log(`[self-vs-external] 报告已落: ${outPath}`);
  console.log(
    `[self-vs-external] self_score: avg=${fmt(self.avg_score_5d_v4)} (${self.count_5d_v4} v4 / ${self.count_legacy} legacy 已过滤)`,
  );
}

if (import.meta.main) {
  main();
}
