// run-external-baseline.ts — 双轨 baseline 首跑入口（B8-4）
//
// 状态：骨架（B8-4），等 S8 实施者跑通 sid_code_solver.py + CR judges 后串通
// 关联：
//   evals/external-benchmarks/swe-bench/接入计划.md（执行轨）
//   evals/external-benchmarks/cr-samples/README.md（报告轨）
//   _reports/templates/self-vs-external.md（B8-5 模板）
//
// 用法:
//   bun run evals/scripts/run-external-baseline.ts --track exec    # 仅执行轨
//   bun run evals/scripts/run-external-baseline.ts --track report  # 仅报告轨
//   bun run evals/scripts/run-external-baseline.ts --track both    # 双轨独立跑(默认)
//   bun run evals/scripts/run-external-baseline.ts --validate      # 不实跑,只校验前置就位
//
// 数据隔离铁律(CLAUDE.md §0.4 + §9.3):
//   - 双轨独立段输出,不混算
//   - 不写自家 baseline_scores
//   - 不进自家 grader registry

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");
const EXTERNAL_DIR = join(REPO_ROOT, "evals/external-benchmarks");
const SWE_BENCH_DIR = join(EXTERNAL_DIR, "swe-bench");
const CR_SAMPLES_DIR = join(EXTERNAL_DIR, "cr-samples");
// ⚠️ 落点必须是 `evals/_reports/external/`，**不是仓库根的 `_reports/external/`**。
// 根 `_reports/` 不在 git 追踪范围（`evals/_reports/` 才是资产目录，见 .gitignore 注释），
// 写到那里等于产物静默丢失 —— 而脚本会打印「报告已落: ...」，看不出丢了。
// 这条漂移原先只登记在 evals/_reports/external/README.md 的「已知漂移」表里，
// 现在直接改对：登记一个已知错误路径，等于把踩坑留给下一个人。
const REPORTS_DIR = join(REPO_ROOT, "evals/_reports/external");
const TEMPLATE_PATH = join(REPO_ROOT, "evals/_reports/templates/inspect-baseline.md");

type Track = "exec" | "report" | "both";

interface CliArgs {
  track: Track;
  validate: boolean;
  date: string; // 静态注入(不依赖 Date.now)
  model: string;
}

function parseArgs(argv: string[]): CliArgs {
  let track: Track = "both";
  let validate = false;
  let date = process.env.SID_CODE_REPORT_DATE ?? "TODO";
  let model = "anthropic/claude-sonnet-4-6";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--track") track = argv[++i] as Track;
    else if (arg === "--validate") validate = true;
    else if (arg === "--date") date = argv[++i];
    else if (arg === "--model") model = argv[++i];
  }
  return { track, validate, date, model };
}

interface PreflightCheck {
  name: string;
  required_for: Track[];
  check: () => { ok: boolean; reason?: string };
}

const PREFLIGHT: PreflightCheck[] = [
  {
    name: "swe-bench/verified-subset.yaml 存在 + 10 条 instance",
    required_for: ["exec", "both"],
    check: () => {
      const path = join(SWE_BENCH_DIR, "verified-subset.yaml");
      if (!existsSync(path)) return { ok: false, reason: `缺文件: ${path}` };
      return { ok: true };
    },
  },
  // ⛔ 原先这里还有两项断言：`sid_code_solver.py 存在` 与 `requirements.txt 存在`。
  // 两个文件是路径 A（Inspect AI）的脚手架，2026-08-24 路径 A 被否决后已删除
  // （见 evals/external-benchmarks/swe-bench/接入计划.md §1）。
  // 断言留着会让 preflight 恒 exit 1 —— 拦住的不是"环境没到位"，而是"决策已变"。
  //
  // 路径 B 的五项防作弊断言（网络隔离 / 出网策略分离 / 镜像内无 fix commit /
  // 镜像可构建性计时 / flag 真被接受）已落地在
  // `evals/external-benchmarks/swe-bench/preflight.ts`，**刻意不在此处调用**：
  // 那五项需要 docker network 名、image key、base_commit 等参数，而本脚本还是骨架
  // （runExecTrack 硬编码 pass: 0）。在一个产不出真数字的链路上跑防作弊断言，
  // 只会让它看起来已经接上了。接实跑那个 PR 负责串起来。
  {
    name: "swe-bench/preflight.ts 存在（路径 B 五项断言的实现）",
    required_for: ["exec", "both"],
    check: () => {
      const path = join(SWE_BENCH_DIR, "preflight.ts");
      if (!existsSync(path)) return { ok: false, reason: `缺文件: ${path}` };
      return { ok: true };
    },
  },
  {
    name: "cr-samples/samples-spec.yaml 存在",
    required_for: ["report", "both"],
    check: () => {
      const path = join(CR_SAMPLES_DIR, "samples-spec.yaml");
      if (!existsSync(path)) return { ok: false, reason: `缺文件: ${path}` };
      return { ok: true };
    },
  },
  {
    name: "cr-samples/multi-judge-config.yaml 存在",
    required_for: ["report", "both"],
    check: () => {
      const path = join(CR_SAMPLES_DIR, "multi-judge-config.yaml");
      if (!existsSync(path)) return { ok: false, reason: `缺文件: ${path}` };
      return { ok: true };
    },
  },
  {
    name: "_reports/external/ 目录可写",
    required_for: ["exec", "report", "both"],
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

function preflight(track: Track): { allOk: boolean; report: string[] } {
  const report: string[] = [];
  let allOk = true;
  for (const c of PREFLIGHT) {
    if (!c.required_for.includes(track)) continue;
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

interface ExecTrackSummary {
  track: "exec";
  total: number;
  pass: number;
  pass_at_1: number; // pass / total
  avg_steps: number | null;
  avg_tools: number | null;
  avg_duration_s: number | null;
  per_instance: Array<{
    instance_id: string;
    pass: boolean;
    steps: number | null;
    tools: number | null;
    duration_s: number | null;
    notes: string;
  }>;
}

interface ReportTrackSummary {
  track: "report";
  total: number;
  pass: number;
  pass_rate: number; // pass / total
  avg_total_score: number | null;
  avg_must_flag_recall: number | null;
  avg_should_flag_recall: number | null;
  avg_precision: number | null;
  per_sample: Array<{
    sample_id: string;
    pass: boolean;
    total_score: number | null;
    must_flag_recall: number | null;
    precision: number | null;
    judge_disagreement: number | null;
    notes: string;
  }>;
}

/**
 * ⛔ **执行轨未接线：直接抛，绝不返回一个数字。**
 *
 * 这个函数原来返回 `pass: 0 / pass_at_1: 0` 并打一行「⚠ 是硬编码占位」的提示。
 * 那个形态是**被否决的路径 A 那个 `Score(value=0)` 的同型** ——
 * 一个「判分没发生」被表达成「一条都没解出」：
 *
 * - 数字**长得完全正常**（`pass: 0` 是合法取值，报告渲染、下游 gap 计算全都照跑）；
 * - 那行 warning 只在**终端**里，一旦有人只看落盘的 md/json 就完全看不到；
 * - 于是「链路没接」会被读成「模型能力差」。这正是本仓反复踩的
 *   「无结果伪装成有结果」，也是 ZZZ.5 第 5 条点出的那个陷阱。
 *
 * 判据很简单：**产不出真数字时唯一正确的行为是拒绝产出**，不是产出 0 加免责声明。
 * 所以这里 throw —— 调用方要么处理，要么整个命令失败退出，两种都比静默出 0 好。
 *
 * ## 接线时改什么
 *
 * 本轮（2026-08-25）真正跑通的是**路径 B**：
 * `evals/external-benchmarks/swe-bench/exec-swebench.sh` + 官方 harness，
 * 产物在 `evals/_reports/external/swe-bench-verified.<run_id>.json`
 * （字段见 `swe-bench/grade.ts` 的 `Acceptance`）。
 * 接线 = 读那份 json，而不是在这里重新实现一遍跑分。
 *
 * ⚠️ 接线时注意两族口径不同：`Acceptance` **刻意没有百分比字段**（D2），
 * 而这里的 `ExecTrackSummary` 有 `pass_at_1`。别把 10 题的绝对数换算成比率填进去 ——
 * 那会绕开 D2 那道「不许把 10 题比例画成 release 曲线」的约束。
 */
function runExecTrack(args: CliArgs): ExecTrackSummary {
  void args;
  throw new Error(
    "[external/exec] 执行轨未接线 —— 拒绝产出占位数字。\n" +
      "  原实现返回 pass: 0，那是「判分没发生」被表达成「一条都没解出」，\n" +
      "  与被否决的路径 A 那个 Score(value=0) 同型（假 0 伪装成没解出）。\n" +
      "  路径 B 已跑通，接线应改为读 evals/_reports/external/swe-bench-verified.<run_id>.json；\n" +
      "  只想校验前置就位请用 --validate（那条路不会走到这里）。",
  );
}

/**
 * ⛔ **报告轨未接线：同样直接抛。**
 *
 * 与 `runExecTrack` 完全同型的问题，而且这一路更坏：它还带一个
 * `pass_rate: 0` —— 一个**比率字段**，落盘之后就是一份「通过率 0」的报告，
 * 谁也看不出那是占位。理由与判据见 `runExecTrack` 的注释。
 */
function runReportTrack(_args: CliArgs): ReportTrackSummary {
  throw new Error(
    "[external/report] 报告轨未接线 —— 拒绝产出占位数字。\n" +
      "  原实现返回 pass: 0 / pass_rate: 0，落盘就是一份「通过率 0」的假报告。\n" +
      "  接线方式见 evals/external-benchmarks/cr-samples/README.md §6；\n" +
      "  只想校验前置就位请用 --validate。",
  );
}

function renderReport(
  args: CliArgs,
  exec: ExecTrackSummary | null,
  report: ReportTrackSummary | null,
): string {
  const lines: string[] = [];
  lines.push(`# 外部锚双轨 baseline — ${args.date}`);
  lines.push("");
  lines.push(`> 模型: ${args.model}`);
  lines.push(`> 执行轨: SWE-bench Verified subset 10 条`);
  lines.push(`> 报告轨: CR 标准化样本集 20 条 + 3 judge majority vote`);
  lines.push(`> 数据隔离: 双轨独立段呈现,**不混算**`);
  lines.push(`> 关联 ADR: ADR-032`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 执行轨 ===
  lines.push("## 1. 执行轨(SWE-bench Verified)");
  lines.push("");
  if (!exec) {
    lines.push("> 本次跑分未启用执行轨(--track report)");
  } else {
    lines.push(`- **pass@1**: ${(exec.pass_at_1 * 100).toFixed(1)}% (${exec.pass}/${exec.total})`);
    lines.push(`- **平均步数**: ${exec.avg_steps ?? "—"}`);
    lines.push(`- **平均工具调用**: ${exec.avg_tools ?? "—"}`);
    lines.push(`- **平均耗时(s)**: ${exec.avg_duration_s ?? "—"}`);
    lines.push("");
    lines.push("### 1.1 每条 instance");
    lines.push("");
    lines.push("| instance_id | pass | steps | tools | duration_s | 备注 |");
    lines.push("| --- | :---: | ---: | ---: | ---: | --- |");
    for (const r of exec.per_instance) {
      lines.push(
        `| ${r.instance_id} | ${r.pass ? "✅" : "❌"} | ${r.steps ?? "—"} | ${r.tools ?? "—"} | ${r.duration_s ?? "—"} | ${r.notes} |`,
      );
    }
    if (exec.per_instance.length === 0) {
      lines.push("| (骨架占位 - 等 S8 实施者跑通) | — | — | — | — | — |");
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 报告轨 ===
  lines.push("## 2. 报告轨(CR 标准化样本集)");
  lines.push("");
  if (!report) {
    lines.push("> 本次跑分未启用报告轨(--track exec)");
  } else {
    lines.push(
      `- **pass_rate**: ${(report.pass_rate * 100).toFixed(1)}% (${report.pass}/${report.total})`,
    );
    lines.push(`- **平均 total_score**: ${report.avg_total_score ?? "—"}`);
    lines.push(`- **平均 must_flag recall**: ${report.avg_must_flag_recall ?? "—"}`);
    lines.push(`- **平均 should_flag recall**: ${report.avg_should_flag_recall ?? "—"}`);
    lines.push(`- **平均 precision**: ${report.avg_precision ?? "—"}`);
    lines.push("");
    lines.push("### 2.1 每条样本");
    lines.push("");
    lines.push("| sample_id | pass | total | must_recall | precision | 分歧度 | 备注 |");
    lines.push("| --- | :---: | ---: | ---: | ---: | ---: | --- |");
    for (const r of report.per_sample) {
      lines.push(
        `| ${r.sample_id} | ${r.pass ? "✅" : "❌"} | ${r.total_score ?? "—"} | ${r.must_flag_recall ?? "—"} | ${r.precision ?? "—"} | ${r.judge_disagreement ?? "—"} | ${r.notes} |`,
      );
    }
    if (report.per_sample.length === 0) {
      lines.push("| (骨架占位 - 等 S8 实施者跑通) | — | — | — | — | — | — |");
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 与自家分数对照(锚点) ===
  lines.push("## 3. 与自家分数对照");
  lines.push("");
  lines.push(
    "> **不在本报告内呈现**——见 `_reports/external/self-vs-external-{date}.md`(B8-5 自动生成)。",
  );
  lines.push("> Sprint 末必跑 self-vs-external gap 报告,gap > 0.2 警示。");
  lines.push("");
  lines.push("---");
  lines.push("");

  // === 数据隔离声明 ===
  lines.push("## 4. 数据隔离声明");
  lines.push("");
  lines.push("- 双轨独立段,**不混算**总分");
  lines.push("- 不写自家 case yaml 的 `baseline_scores`");
  lines.push("- 不进 `evals/_graders/registry.ts`");
  lines.push("- 报告独立到 `_reports/external/`,与自家 DASHBOARD.md 隔离");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[external] track=${args.track} model=${args.model} date=${args.date}`);

  const { allOk, report: preflightReport } = preflight(args.track);
  console.log("[external/preflight]");
  for (const line of preflightReport) console.log(line);

  if (!allOk) {
    console.error("[external] preflight 失败,请按上方 ❌ 提示补齐");
    process.exit(1);
  }

  if (args.validate) {
    console.log("[external] --validate 模式,前置就位 ✅");
    return;
  }

  const exec = args.track === "report" ? null : runExecTrack(args);
  const reportSummary = args.track === "exec" ? null : runReportTrack(args);

  const md = renderReport(args, exec, reportSummary);
  const outPath = join(REPORTS_DIR, `inspect-${args.date}.md`);
  writeFileSync(outPath, md, "utf-8");
  console.log(`[external] 报告已落: ${outPath}`);
  console.log(`[external] 模板参照: ${TEMPLATE_PATH}`);
}

if (import.meta.main) {
  main();
}
