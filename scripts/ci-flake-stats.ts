#!/usr/bin/env bun
/**
 * ci-flake-stats —— CI 失败密度统计（按分片归一，且**把重跑转绿的 run 算进来**）
 *
 * ## 它解决的两个问题
 *
 * **① 每次统计都要手工 `gh api` + 逐个取 job。** 方案文档 §二 的那组数字（macOS 是
 * ubuntu 的 2.3 倍）是手工跑出来的，没有可复现的入口 —— 这意味着一周后没人能重算它，
 * 拿不出「改完有没有变好」的对照。
 *
 * **② 重跑转绿的 run 被系统性漏掉，这是当前口径最大的盲区。** 只看「当前仍 failure 的
 * run」会漏掉一类：某个 run 首跑红了、`gh run rerun --failed` 之后绿了，它在列表里
 * 显示 success，于是「红过一次」这段事实彻底消失。2026-11-15 实测：近 100 次 run 里
 * 当前 failure 只有 2 个，但重跑转绿的有 4 个 —— 真实失败事件是 6 个而非 2 个，
 * 漏报率 67%。**只看当前结论的统计会把改善量算大。**
 *
 * ## 口径（写死在代码里，改口径要连分母一起改）
 *
 * - **分子**：该平台「有测试结论的 run」中失败过的 run 数（一个 run 只算一次，
 *   不按 job 数算 —— 一个 run 里 193 条用例失败与 1 条失败都是同一次事件）。
 * - **分母**：`有结论的 run 数 × 该平台分片数`。排除 `cancelled` / 进行中（`null`）：
 *   它们没有测试结论，算进分母会把密度稀释成假改善。
 * - **两种口径并列输出**：`current`（只看当前结论）与 `incl-rescued`（含重跑转绿）。
 *   前者是历史文档用的口径（便于对账），后者才是真实事件数。
 *
 * ## 为什么数据获取与计算分离
 *
 * 计算层是纯函数（`computeFlakeStats`），输入是 `RunRecord[]`。这样：
 * - 测试可以**造数据**跑，不需要 gh 权限、不需要网络（`--runs <file>`）；
 * - 判据依赖「等真实样本触发」时不会永远等不到 —— 造一条 `run_attempt=2 + success +
 *   firstAttemptShards 有失败` 的记录就能覆盖「重跑转绿」这条分支。
 *
 * 用法：
 * ```bash
 * bun run scripts/ci-flake-stats.ts                  # 拉最近 100 次 run
 * bun run scripts/ci-flake-stats.ts --limit 30       # 最近 30 次
 * bun run scripts/ci-flake-stats.ts --runs x.json    # 离线：从文件读（测试/复算）
 * bun run scripts/ci-flake-stats.ts --json           # 机器可读输出
 * ```
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 单个分片 job 的结论。`failed` 只表示这个 job 真的红过。 */
export interface ShardResult {
  os: string;
  failed: boolean;
}

/** 一次 run 的统计输入。字段名对齐 `gh api .../actions/runs` 的响应。 */
export interface RunRecord {
  id: number;
  conclusion: "success" | "failure" | "cancelled" | null;
  run_attempt: number;
  created_at: string;
  event: string;
  /** 最新 attempt 的每个分片 job */
  shards: ShardResult[];
  /**
   * attempt 1 的每个分片 job。
   *
   * 只在「`run_attempt > 1` 且当前成功」时才有意义 —— 它承载「重跑转绿」那段事实。
   * 没提供时视为「不知道」，不参与 incl-rescued 口径（并在输出里提示覆盖率）。
   */
  firstAttemptShards?: ShardResult[];
}

export interface DensityRow {
  os: string;
  /** 该平台失败过的 run 数 */
  failedRuns: number;
  /** 有结论的 run 数（分母的 run 部分） */
  runCount: number;
  /** 该平台分片数（分母的分片部分） */
  shardCount: number;
  /** failedRuns / (runCount * shardCount) */
  density: number;
}

export interface FlakeStats {
  window: { from: string; to: string; runCount: number; skipped: number };
  /** 只看当前结论（历史文档口径，便于对账） */
  current: DensityRow[];
  /** 含重跑转绿（真实事件口径） */
  inclRescued: DensityRow[];
  /** 重跑转绿的 run（首跑红过、最终绿） */
  rescued: Array<{ runId: number; platforms: string[]; createdAt: string }>;
  /** attempt 1 数据缺失的 run 数（incl-rescued 口径的覆盖率缺口） */
  rescuedUnknown: number;
}

/** 有测试结论的 run：cancelled 与进行中（null）没有结论，不进分母。 */
function hasVerdict(r: RunRecord): boolean {
  return r.conclusion === "success" || r.conclusion === "failure";
}

/** 某次 run 在某平台是否真的失败过（该平台任意分片红）。 */
function failedOn(shards: ShardResult[] | undefined, os: string): boolean {
  return (shards ?? []).some((s) => s.os === os && s.failed);
}

/** 从数据里发现平台与各自的分片数（取各 run 里该平台条目数的最大值，防某次 run 缺片）。 */
function discoverShards(runs: RunRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const perOs = new Map<string, number>();
    for (const s of [...r.shards, ...(r.firstAttemptShards ?? [])]) {
      perOs.set(s.os, (perOs.get(s.os) ?? 0) + 1);
    }
    for (const [os, n] of perOs) counts.set(os, Math.max(counts.get(os) ?? 0, n));
  }
  return counts;
}

/**
 * 纯计算层：给定 run 记录，算两种口径的失败密度。
 *
 * 不读文件、不调网络、不读 env —— 这样测试可以直接造数据。
 */
export function computeFlakeStats(runs: RunRecord[]): FlakeStats {
  const verdicts = runs.filter(hasVerdict);
  const shardCounts = discoverShards(verdicts);

  const sorted = [...verdicts].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const window = {
    from: sorted[0]?.created_at ?? "",
    to: sorted[sorted.length - 1]?.created_at ?? "",
    runCount: verdicts.length,
    skipped: runs.length - verdicts.length,
  };

  const rescued: FlakeStats["rescued"] = [];
  let rescuedUnknown = 0;
  for (const r of verdicts) {
    // 只有「重跑过」的 run 才可能承载「首跑红、最终绿」这段事实。
    if (r.run_attempt <= 1) continue;
    if (r.conclusion === "failure") continue; // 最终还红着，已经算进 current 口径
    if (!r.firstAttemptShards) {
      rescuedUnknown++; // 没拉 attempt 1 的数据，不能断言「没红过」
      continue;
    }
    const platforms = [...shardCounts.keys()].filter((os) => failedOn(r.firstAttemptShards, os));
    if (platforms.length > 0) {
      rescued.push({ runId: r.id, platforms, createdAt: r.created_at });
    }
  }

  const build = (includeRescued: boolean): DensityRow[] =>
    [...shardCounts.entries()]
      .map(([os, shardCount]) => {
        const failedRuns = verdicts.filter((r) => {
          if (failedOn(r.shards, os)) return true; // 当前就红（含最终仍失败）
          if (!includeRescued) return false;
          // 重跑转绿：首跑该平台红过
          return r.run_attempt > 1 && failedOn(r.firstAttemptShards, os);
        }).length;
        const denom = verdicts.length * shardCount;
        return {
          os,
          failedRuns,
          runCount: verdicts.length,
          shardCount,
          density: denom === 0 ? 0 : failedRuns / denom,
        };
      })
      .sort((a, b) => b.density - a.density);

  return { window, current: build(false), inclRescued: build(true), rescued, rescuedUnknown };
}

/** 把密度表渲染成 markdown（`|` 在终端里也能读，且可以直接粘进文档）。 */
function renderTable(rows: DensityRow[], label: string): string {
  if (rows.length === 0) return `${label}：无数据`;
  const lines = [
    `**${label}**`,
    "",
    "| 平台 | 失败 run | 有结论 run | 分片数 | 失败密度 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.os} | ${r.failedRuns} | ${r.runCount} | ${r.shardCount} | ${(r.density * 100).toFixed(2)}% |`,
    );
  }
  // 相对比值：只在与 ubuntu 对比时有意义（历史文档的 2.3 倍就是这个比值）。
  const ubuntu = rows.find((r) => r.os.startsWith("ubuntu"));
  if (ubuntu && ubuntu.density > 0) {
    const others = rows.filter((r) => !r.os.startsWith("ubuntu"));
    if (others.length > 0) {
      lines.push("");
      lines.push(
        `相对 ubuntu：${others
          .map((r) => `${r.os} ${(r.density / ubuntu.density).toFixed(2)}×`)
          .join("，")}（历史判据 ≤ 1.5× 视为达标）`,
      );
    }
  }
  return lines.join("\n");
}

/** 从 jobs 响应里抽出分片结论（job 名形如 `test (macos-latest, 1/2)`）。 */
export function shardsFromJobs(
  jobs: Array<{ name: string; conclusion: string | null }>,
): ShardResult[] {
  const out: ShardResult[] = [];
  for (const j of jobs) {
    const m = /^test \((.+?), \d+\/\d+\)$/.exec(j.name);
    if (!m) continue;
    out.push({ os: m[1], failed: j.conclusion === "failure" });
  }
  return out;
}

function ghJson(args: string[]): any {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

/** 拉取模式：默认仓库取当前 git remote，可用 --repo 覆盖。 */
function defaultRepo(): string {
  const r = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return "njfuzrs/sid-code";
}

/** 拉最近 N 次 run，并按需补 attempt 1 的 jobs（只为「重跑过且最终绿」的 run 拉）。 */
export function fetchRuns(
  repo: string,
  limit: number,
  log: (s: string) => void = () => {},
): RunRecord[] {
  const list = ghJson([
    "api",
    `repos/${repo}/actions/workflows/ci.yml/runs?per_page=${limit}`,
    "--paginate",
  ]) as { workflow_runs: Array<Record<string, any>> };

  const runs: RunRecord[] = [];
  for (const wr of list.workflow_runs) {
    const latest = ghJson([
      "api",
      `repos/${repo}/actions/runs/${wr.id}/jobs?per_page=100`,
      "-q",
      ".jobs",
    ]) as Array<{ name: string; conclusion: string | null }>;
    const rec: RunRecord = {
      id: wr.id,
      conclusion: wr.conclusion,
      run_attempt: wr.run_attempt ?? 1,
      created_at: wr.created_at,
      event: wr.event,
      shards: shardsFromJobs(latest),
    };
    // 只为「重跑过且最终成功」的 run 补 attempt 1 —— 其余 run 要么没重跑，
    // 要么最终仍红（已经在 current 口径里），拉了也白拉。
    if (rec.run_attempt > 1 && rec.conclusion === "success") {
      const first = ghJson([
        "api",
        `repos/${repo}/actions/runs/${wr.id}/attempts/1/jobs?per_page=100`,
        "-q",
        ".jobs",
      ]) as Array<{ name: string; conclusion: string | null }>;
      rec.firstAttemptShards = shardsFromJobs(first);
    }
    runs.push(rec);
    log(`  已取 run ${wr.id} (${rec.conclusion}, attempt=${rec.run_attempt})`);
  }
  return runs;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  let runs: RunRecord[];
  const runsFile = arg("--runs");
  if (runsFile) {
    // 离线模式：文件形如 { "runs": RunRecord[] } 或直接 RunRecord[]。
    const raw = JSON.parse(readFileSync(runsFile, "utf8"));
    runs = Array.isArray(raw) ? raw : raw.runs;
  } else {
    const limit = Number(arg("--limit") ?? "100");
    const repo = arg("--repo") ?? defaultRepo();
    runs = fetchRuns(repo, limit);
  }

  const stats = computeFlakeStats(runs);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log("## CI 失败密度（按分片归一）");
  console.log("");
  console.log(
    `窗口：${stats.window.from} ~ ${stats.window.to}，有结论 run ${stats.window.runCount} 个` +
      `（另有 ${stats.window.skipped} 个 cancelled/进行中，不进分母）`,
  );
  console.log("");
  console.log(renderTable(stats.current, "① current：只看当前结论（历史文档口径）"));
  console.log("");
  console.log(renderTable(stats.inclRescued, "② incl-rescued：含重跑转绿的 run（真实事件口径）"));
  console.log("");
  if (stats.rescued.length > 0) {
    console.log(`重跑转绿 ${stats.rescued.length} 个（只看当前结论会漏掉它们）：`);
    for (const r of stats.rescued) {
      console.log(`  · run ${r.runId}（${r.createdAt}）首跑红在：${r.platforms.join(", ")}`);
    }
  } else {
    console.log("重跑转绿：0 个");
  }
  if (stats.rescuedUnknown > 0) {
    console.log(
      `⚠️ 有 ${stats.rescuedUnknown} 个重跑过的 run 缺 attempt 1 数据 —— ② 口径可能偏低（不是「没红过」）。`,
    );
  }
}

if (import.meta.main) {
  await main();
}
