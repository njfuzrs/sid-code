#!/usr/bin/env bun
/**
 * pr-auto-update —— 「穷人版合并队列」：每次只给队首的一个 PR 做 update-branch。
 *
 * ## 它解决的问题
 *
 * ruleset 开了 strict 必需检查，而个人账户仓库开不了 merge queue（422，见 CONTRIBUTING
 * 「合并队列用不了」）。于是每合入一个 PR，其余挂了 auto-merge 的 PR 全部变 BEHIND，
 * **auto-merge 不会自己 update-branch**，只能人去点。实测（2026-11-03）一天合 15 个 PR，
 * 最大的浪费不是 CI 时长，而是「BEHIND 挂着等人点按钮」。
 *
 * 由 `.github/workflows/pr-auto-update.yml` 在 push main / CI 跑完 / 每 15 分钟触发。
 *
 * ## 为什么一次只更新一个
 *
 * 全部同时 update 会让 N 个 PR 各跑一轮 CI，然后只有第一个能合，其余 N-1 轮全白跑
 * （下一个合入后又 BEHIND）。只更新队首，CI 跑的就是「最新 main + 它」，绿了 auto-merge
 * 直接合，合完 push 事件再触发下一次。这与 `scripts/pr-merge-chain.sh` 的「严格串行」
 * 同一判据，区别是它常驻在 GitHub 侧，不需要人开着终端。
 *
 * ## 队列口径
 *
 * - 入队 = 挂了 auto-merge 且不是 draft。没挂 auto-merge 的 PR 视为「还没准备好合」，不碰。
 * - 顺序 = auto-merge 的 `enabledAt` 升序（先挂先合），不是 PR 编号——编号反映的是开 PR
 *   的时间，不是「准备好合」的时间。
 * - 有 PR 正在飞（已与 main 同步且检查未跑完，或已可合待 auto-merge 动手）→ 什么都不做。
 *   这条是串行的关键：否则队首刚 update，下一次触发又去 update 第二个。
 * - 检查已失败 / 有冲突的 PR 跳过，不阻塞后面的（与 pr-merge-chain 的「失败即停」不同：
 *   那里是一批互相可能依赖的 PR，这里是彼此独立排队的 PR，一个红了不该卡死全仓）。
 *
 * ## 不做的事
 *
 * 不合并（交给 auto-merge，必需检查仍由 ruleset 判）、不改 PR 内容、不 force push。
 * 所以这个脚本不存在绕过分支保护的路径：它能做的最坏的事是多触发一轮 CI。
 */

export type CheckState = "pending" | "success" | "failure";

export interface PrSnapshot {
  number: number;
  isDraft: boolean;
  /** GitHub 的 mergeStateStatus：BEHIND / BLOCKED / CLEAN / DIRTY / UNSTABLE / HAS_HOOKS / UNKNOWN / DRAFT */
  mergeStateStatus: string;
  /** auto-merge 挂上的时间；null = 没挂 */
  autoMergeEnabledAt: string | null;
  /** 检查汇总：没有任何检查时为 "pending"（刚 update 完、CI 还没建 run 的那几秒） */
  checks: CheckState;
}

export type Decision =
  | { action: "wait"; pr: number; reason: string }
  | { action: "update"; pr: number }
  | { action: "idle"; reason: string }
  | { action: "retry"; reason: string };

/** 已经在「最新 main + 自己」上、正在等结论的状态。它们存在时队列不前进。 */
const IN_FLIGHT_READY = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

export function pickNext(prs: PrSnapshot[], opts: { ignoreUnknown?: boolean } = {}): Decision {
  const queue = prs
    .filter((p) => p.autoMergeEnabledAt !== null && !p.isDraft)
    .sort(
      (a, b) => a.autoMergeEnabledAt!.localeCompare(b.autoMergeEnabledAt!) || a.number - b.number,
    );

  if (queue.length === 0) return { action: "idle", reason: "没有挂 auto-merge 的 PR" };

  // UNKNOWN 是 GitHub 懒计算的中间态，拿它做判断等于猜。先交给调用方重取；
  // 重取仍算不出时（ignoreUnknown）把它们排除在外继续排队——否则一个算不出状态的 PR
  // 会卡死全仓。代价是它若恰好在飞，会多一路 CI 并行，最坏多跑一轮 CI，不影响正确性。
  const unknown = queue.filter((p) => p.mergeStateStatus === "UNKNOWN");
  if (unknown.length > 0 && !opts.ignoreUnknown) {
    return {
      action: "retry",
      reason: `mergeStateStatus 未算出: #${unknown.map((p) => p.number).join(" #")}`,
    };
  }

  for (const p of queue) {
    if (p.mergeStateStatus === "UNKNOWN") continue;
    if (IN_FLIGHT_READY.has(p.mergeStateStatus)) {
      return { action: "wait", pr: p.number, reason: `${p.mergeStateStatus}，等 auto-merge 合入` };
    }
    // BLOCKED 且检查还在跑 = 已同步 main、CI 进行中。
    // 检查已失败的 BLOCKED 不算在飞：它要等人修，不能卡住队列。
    if (p.mergeStateStatus === "BLOCKED" && p.checks === "pending") {
      return { action: "wait", pr: p.number, reason: "已与 main 同步，CI 进行中" };
    }
  }

  // 只看检查没失败过的 BEHIND。检查红了的 PR 再 update 一次也只是再红一次，
  // 而它会占住串行队列的唯一槽位约 10 分钟——要修的是代码，不是 base。
  const next = queue.find((p) => p.mergeStateStatus === "BEHIND" && p.checks !== "failure");
  if (next) return { action: "update", pr: next.number };

  return {
    action: "idle",
    reason: "队列里没有可更新的 BEHIND PR（其余为冲突 / 检查失败 / 待人处理）",
  };
}

interface RawCheck {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/** 把 statusCheckRollup 压成三态。CheckRun 看 status/conclusion，StatusContext 看 state。 */
export function summarizeChecks(rollup: RawCheck[] | null | undefined): CheckState {
  if (!rollup || rollup.length === 0) return "pending";
  let pending = false;
  for (const c of rollup) {
    if (c.__typename === "StatusContext") {
      const s = (c.state ?? "").toUpperCase();
      if (s === "FAILURE" || s === "ERROR") return "failure";
      if (s !== "SUCCESS") pending = true;
      continue;
    }
    if ((c.status ?? "").toUpperCase() !== "COMPLETED") {
      pending = true;
      continue;
    }
    // 白名单：与 ci.yml 汇聚门同一判据，没见过的 conclusion 一律算失败（fail-closed）
    const conc = (c.conclusion ?? "").toUpperCase();
    if (!["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conc)) return "failure";
  }
  return pending ? "pending" : "success";
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} 失败（exit ${code}）: ${err.trim()}`);
  return out;
}

async function snapshot(base: string): Promise<PrSnapshot[]> {
  const raw = await gh([
    "pr",
    "list",
    "--base",
    base,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,isDraft,mergeStateStatus,autoMergeRequest,statusCheckRollup",
  ]);
  const rows = JSON.parse(raw) as Array<{
    number: number;
    isDraft: boolean;
    mergeStateStatus: string;
    autoMergeRequest: { enabledAt?: string } | null;
    statusCheckRollup: RawCheck[] | null;
  }>;
  return rows.map((r) => ({
    number: r.number,
    isDraft: r.isDraft,
    mergeStateStatus: r.mergeStateStatus,
    autoMergeEnabledAt: r.autoMergeRequest ? (r.autoMergeRequest.enabledAt ?? "") : null,
    checks: summarizeChecks(r.statusCheckRollup),
  }));
}

async function main(): Promise<number> {
  const base = process.env.PR_AUTO_UPDATE_BASE ?? "main";
  const dryRun = process.argv.includes("--dry-run");

  // UNKNOWN 通常在第一次 list 触发计算后几秒内就算出来，重取 3 次足够；
  // 最后一次仍算不出就排除那几个 PR 再判（见 pickNext 的 ignoreUnknown）。
  const ATTEMPTS = 4;
  let decision: Decision = { action: "retry", reason: "未开始" };
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i > 0) await Bun.sleep(5000);
    decision = pickNext(await snapshot(base), { ignoreUnknown: i === ATTEMPTS - 1 });
    if (decision.action !== "retry") break;
    console.log(`第 ${i + 1} 次取数: ${decision.reason}`);
  }

  switch (decision.action) {
    case "retry":
      console.log(`本轮放弃（${decision.reason}），等下一次触发`);
      return 0;
    case "idle":
      console.log(`空闲: ${decision.reason}`);
      return 0;
    case "wait":
      console.log(`等待 #${decision.pr}: ${decision.reason}`);
      return 0;
    case "update":
      if (dryRun) {
        console.log(`[dry-run] 将 update-branch #${decision.pr}`);
        return 0;
      }
      console.log(`update-branch #${decision.pr}`);
      await gh(["pr", "update-branch", String(decision.pr)]);
      return 0;
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
