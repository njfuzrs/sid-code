#!/usr/bin/env bun
/**
 * eval-budget — 评测预算账本的命令行入口（任务 T19 / 方案 §5.4-6）。
 *
 * ## 三个子命令各管一件事
 *
 * ```bash
 * # 开跑前：本月已花 + 本次上限 > $150 就拒绝（退出码 2 = INVALID）
 * bun run scripts/eval/eval-budget.ts check --layer L2 --planned-cap-usd 40
 *
 * # 跑完：记一行账（实付含 null 成本的折算，折算量单独记 null_cost_tasks）
 * bun run scripts/eval/eval-budget.ts record --layer L2 --version 0.1.615 \
 *   --planned-cap-usd 40 --actual-usd 26.21
 * # 逐题成本（可含 null）也能直接喂进来，折算口径由库里的 effectiveRunCost 统一
 * bun run scripts/eval/eval-budget.ts record --layer L2 --planned-cap-usd 40 \
 *   --costs-json '[1.21,null,0.87]'
 *
 * # 看本月：例行/一次性分别用了多少
 * bun run scripts/eval/eval-budget.ts summary
 * ```
 *
 * ## 退出码就是判据（调用方只管看数字，不用解析文案）
 *
 * | 码 | 含义 | 调用方该做什么 |
 * | --- | --- | --- |
 * | 0 | `check` 允许 / `record` `summary` 成功 | 继续 |
 * | 2 | `check` 拒绝开跑（`INVALID`） | **一次模型调用都不要发**，按 reason 修（等预算 / 修账本） |
 * | 1 | 用法错误 | 读 stderr |
 *
 * `2` 沿用 `run_fingerprint.py` 的 INVALID 约定，两个工具在 `release-gate.sh` 里的
 * 错误处理可以写成同一种形态。**「拒绝」和「用法错误」必须分开**：前者要等人做决定
 * （补预算或修账本），后者是脚本自己写错了。
 *
 * ## 为什么 --monthly-cap-usd 不存在
 *
 * 月上限是 D2 的裁决值（$150），硬熔断的全部意义就是**不能被开跑的人随手放宽**。
 * 单测要测边界就喂 `checkBudget({monthlyCapUsd})`，CLI 不暴露这个开关。
 */

import {
  DEFAULT_PER_TASK_CAP_USD,
  LAYERS,
  MONTHLY_CAP_USD,
  POOLS,
  checkBudget,
  currentMonth,
  effectiveRunCost,
  ledgerPath,
  readLedger,
  recordRun,
  summarizeMonth,
  type BudgetPool,
  type EvalLayer,
} from "./lib/eval-budget.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;

const USAGE = `eval-budget — 评测预算账本与硬熔断（方案 §5.4-6）

用法:
  eval-budget check   --layer <L1|L2> --planned-cap-usd <n> [--pool <routine|oneoff>] [--json] [--now <iso>]
  eval-budget record  --layer <L1|L2> --planned-cap-usd <n>
                      (--actual-usd <n> [--null-cost-tasks <n>] | --costs-json '<json 数组>')
                      [--per-task-cap-usd <n>] [--version <v>] [--pool <routine|oneoff>]
                      [--note <text>] [--json] [--now <iso>]
  eval-budget summary [--json] [--now <iso>]
  eval-budget --help

判定（§5.4-6 原文，严格大于才拒绝）:
  本月已花 + 本次上限 > $${MONTHLY_CAP_USD}  → 拒绝开跑，退出码 ${EXIT_REFUSED}（INVALID）

口径:
  · 账本 ${ledgerPath()}（跟随 SID_CONFIG_DIR）
  · 成本为 null 的题按单题上限（默认 $${DEFAULT_PER_TASK_CAP_USD}）记账，不按 0
  · pool=oneoff 只记账、不参与月上限判定（P2 一次性预算由人单独批）

退出码: 0 允许/成功 · 2 拒绝开跑（INVALID） · 1 用法错误
`;

interface Flags {
  [key: string]: string | boolean;
}

/** 极简 flag 解析：`--k v` 与 `--flag`。未知 flag 直接报错，不静默忽略。 */
function parseFlags(argv: string[], known: Set<string>): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) usageError(`多余的参数: ${token}`);
    const key = token.slice(2);
    if (!known.has(key)) usageError(`未知参数: --${key}`);
    if (key === "json" || key === "help") {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) usageError(`--${key} 需要一个值`);
    out[key] = value;
  }
  return out;
}

function usageError(msg: string): never {
  console.error(`eval-budget: ${msg}\n\n${USAGE}`);
  process.exit(EXIT_USAGE);
}

function requireString(flags: Flags, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || v.trim() === "") usageError(`--${key} 必填`);
  return v;
}

function numberFlag(flags: Flags, key: string): number {
  const raw = requireString(flags, key);
  const n = Number(raw);
  if (!Number.isFinite(n)) usageError(`--${key} 需要是数字，收到 ${raw}`);
  return n;
}

function optionalNumberFlag(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") usageError(`--${key} 需要一个值`);
  const n = Number(v);
  if (!Number.isFinite(n)) usageError(`--${key} 需要是数字，收到 ${v}`);
  return n;
}

function layerFlag(flags: Flags): EvalLayer {
  const raw = requireString(flags, "layer");
  if (!(LAYERS as readonly string[]).includes(raw)) {
    usageError(`--layer 只能是 ${LAYERS.join(" | ")}，收到 ${raw}`);
  }
  return raw as EvalLayer;
}

function poolFlag(flags: Flags): BudgetPool {
  const v = flags.pool;
  if (v === undefined) return "routine";
  if (typeof v !== "string") usageError("--pool 需要一个值");
  if (!(POOLS as readonly string[]).includes(v)) {
    usageError(`--pool 只能是 ${POOLS.join(" | ")}，收到 ${v}`);
  }
  return v as BudgetPool;
}

/** `--now` 只用于测试与补记历史；不给就用系统时钟。 */
function nowFlag(flags: Flags): Date | undefined {
  const v = flags.now;
  if (v === undefined) return undefined;
  if (typeof v !== "string") usageError("--now 需要一个 ISO 8601 时间");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) usageError(`--now 不是合法时间: ${v}`);
  return d;
}

function stringOrUndefined(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") usageError(`--${key} 需要一个值`);
  return v;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// ─────────────────────────────────────────────────────────────── check

function cmdCheck(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["layer", "planned-cap-usd", "pool", "json", "now"]));
  const decision = checkBudget({
    layer: layerFlag(flags),
    plannedCapUsd: numberFlag(flags, "planned-cap-usd"),
    pool: poolFlag(flags),
    now: nowFlag(flags),
  });

  if (flags.json) {
    printJson(decision);
  } else {
    const tag = decision.allowed ? "ALLOW" : `INVALID(${decision.code})`;
    console.log(
      `${tag} layer=${decision.layer ?? "?"} pool=${decision.pool} month=${decision.month} ` +
        `spent=$${decision.spent_usd.toFixed(2)} planned=$${decision.planned_cap_usd.toFixed(2)} ` +
        `remaining=${decision.remaining_usd === null ? "n/a" : `$${decision.remaining_usd.toFixed(2)}`}`,
    );
    console.log(decision.reason);
    console.log(`账本: ${decision.ledger_path}`);
  }
  return decision.allowed ? EXIT_OK : EXIT_REFUSED;
}

// ─────────────────────────────────────────────────────────────── record

function cmdRecord(argv: string[]): number {
  const flags = parseFlags(
    argv,
    new Set([
      "layer",
      "planned-cap-usd",
      "actual-usd",
      "costs-json",
      "null-cost-tasks",
      "per-task-cap-usd",
      "version",
      "pool",
      "note",
      "json",
      "now",
    ]),
  );

  const layer = layerFlag(flags);
  const plannedCapUsd = numberFlag(flags, "planned-cap-usd");
  const explicitActual = optionalNumberFlag(flags, "actual-usd");
  const costsJson = stringOrUndefined(flags, "costs-json");

  if (explicitActual !== undefined && costsJson !== undefined) {
    // 两种口径同时给会让人分不清账本里那个数是怎么来的，直接拒。
    usageError("--actual-usd 与 --costs-json 只能给一个");
  }
  if (explicitActual === undefined && costsJson === undefined) {
    usageError("必须给 --actual-usd 或 --costs-json");
  }

  let actualUsd: number;
  let nullCostTasks = optionalNumberFlag(flags, "null-cost-tasks") ?? 0;

  if (costsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(costsJson);
    } catch {
      usageError(`--costs-json 不是合法 JSON: ${costsJson}`);
    }
    if (!Array.isArray(parsed)) usageError("--costs-json 必须是数组");
    const perTaskCap = optionalNumberFlag(flags, "per-task-cap-usd") ?? DEFAULT_PER_TASK_CAP_USD;
    const cost = effectiveRunCost(parsed as Array<number | null>, perTaskCap);
    actualUsd = cost.totalUsd;
    if (flags["null-cost-tasks"] !== undefined && nullCostTasks !== cost.nullCostTasks) {
      // 手填的题数与折算出来的不一致 = 有人算错了；账本里那个数字宁可不要。
      usageError(
        `--null-cost-tasks=${nullCostTasks} 与 --costs-json 里实际折算出的 ${cost.nullCostTasks} 不一致`,
      );
    }
    nullCostTasks = cost.nullCostTasks;
    if (!flags.json) {
      console.error(
        `eval-budget: 实付 $${cost.totalUsd.toFixed(6)} = 上报 $${cost.reportedUsd.toFixed(6)} ` +
          `+ 折算 $${cost.assumedUsd.toFixed(6)}（${cost.nullCostTasks} 题成本缺失，按单题上限 $${perTaskCap} 记）`,
      );
    }
  } else {
    actualUsd = explicitActual as number;
  }

  if (optionalNumberFlag(flags, "per-task-cap-usd") !== undefined && costsJson === undefined) {
    usageError("--per-task-cap-usd 只在 --costs-json 下有意义");
  }

  const entry = recordRun({
    layer,
    plannedCapUsd,
    actualUsd,
    pool: poolFlag(flags),
    version: stringOrUndefined(flags, "version") ?? null,
    nullCostTasks,
    note: stringOrUndefined(flags, "note"),
    now: nowFlag(flags),
  });

  if (flags.json) {
    printJson(entry);
  } else {
    console.log(`已记账: ${JSON.stringify(entry)}`);
    console.log(`账本: ${ledgerPath()}`);
  }
  return EXIT_OK;
}

// ─────────────────────────────────────────────────────────────── summary

function cmdSummary(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["json", "now"]));
  const month = currentMonth(nowFlag(flags) ?? new Date());
  const { entries, corrupt } = readLedger();
  const summary = summarizeMonth(entries, month);
  const remaining = Math.round((MONTHLY_CAP_USD - summary.routine_usd) * 1e6) / 1e6;

  if (flags.json) {
    printJson({
      ...summary,
      monthly_cap_usd: MONTHLY_CAP_USD,
      remaining_usd: remaining,
      ledger_path: ledgerPath(),
      corrupt_lines: corrupt,
    });
    return corrupt.length > 0 ? EXIT_REFUSED : EXIT_OK;
  }

  console.log(
    `${summary.month}  例行 $${summary.routine_usd.toFixed(2)} / $${MONTHLY_CAP_USD.toFixed(2)}` +
      `（${summary.routine_runs} 次，剩 $${remaining.toFixed(2)}）`,
  );
  console.log(
    `          一次性（oneoff，不占例行预算）$${summary.oneoff_usd.toFixed(2)}（${summary.oneoff_runs} 次）`,
  );
  console.log(`账本: ${ledgerPath()}`);
  if (corrupt.length > 0) {
    // summary 不做熔断，但坏行必须让人看见——它就是下次 check 会被拒的原因。
    console.error(`⚠️ 账本有 ${corrupt.length} 处坏行（下一次 check 会判 INVALID）:`);
    for (const c of corrupt) console.error(`  第 ${c.line} 行：${c.reason}`);
    return EXIT_REFUSED;
  }
  return EXIT_OK;
}

// ─────────────────────────────────────────────────────────────── main

function main(argv: string[]): number {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return argv.length === 0 ? EXIT_USAGE : EXIT_OK;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "check":
      return cmdCheck(rest);
    case "record":
      return cmdRecord(rest);
    case "summary":
      return cmdSummary(rest);
    default:
      usageError(`未知子命令: ${sub}`);
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    // 库层抛错（输入非法 / 写盘失败）一律按用法错误退出，⛔ 不要吞成 0：
    // 一次没记上的花费会让后面的熔断整个失效。
    console.error(`eval-budget: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_USAGE);
  }
}
