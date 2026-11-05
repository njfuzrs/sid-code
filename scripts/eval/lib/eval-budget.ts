/**
 * 评测预算账本与硬熔断 —— 方案《评测接入 CI/CD》§5.4-6 与 §7.1 D2 的落地（任务 T19）。
 *
 * ## 它回答的问题
 *
 * §5.4 第 6 条：「每次 L1/L2 开跑前读本月账本，`本月已花 + 本次上限 > $150` 即拒绝开跑
 * 并判 `INVALID`」。D2 把这句话定死了两件事：账本位置 `~/.sid-code/eval-gate/ledger.jsonl`，
 * 以及**硬熔断的意思是「超了就不跑」**——不做「超了先跑完再说」，否则上限只是一个数字。
 *
 * 所以本模块是**纯读的判定**加**append-only 的记账**，不含任何模型调用：
 * 拒绝路径在 `withBudgetGate` 里返回 `ran: false`，调用方的 runner 一次都不会被调。
 *
 * ## 三个刻意写死的口径（改之前先读这几段）
 *
 * ① **「本月」按写入端的本地自然月**，不是 UTC 月。
 *    账本行的 `ts` 写成带本地偏移的 ISO 8601（`2026-11-05T10:23:00.000+08:00`），
 *    月份直接从 `ts` 前 7 位取。这样「哪次运行算哪个月」在**写入那一刻就定死**了，
 *    事后读的人用什么时区都不会漂——比读时按本地时区重算稳。
 *    （代价：本机 UTC+8 的月初 0–8 点写下的行算当月，UTC 那边还是上月末。
 *      单机维护者场景可以接受，且写进 Agent Note 了。）
 *
 * ② **坏行 fail-closed，不静默跳过**。
 *    账本里有一行解析不了，就**无法知道本月已花多少**。这时候放行 = 熔断失效，
 *    而这正是本仓反复踩的形态（`null` 在下游被当 0 求和，见 `evals/CLAUDE.md` §3.6）。
 *    所以坏行一律判 `INVALID` 并点名行号，交给人修账本。
 *
 * ③ **成本为 null 的题按单题上限记，不按 0**（§5.4-6 原文）。
 *    `effectiveRunCost()` 是这条口径的唯一实现：`null` → `perTaskCapUsd`，
 *    同时把「哪些钱是折算出来的」单独报出来（`assumedUsd` / `nullCostTasks`），
 *    免得事后当成真实花费引用。这正是 §3.6 那条「`session-traj-fallback` ≠
 *    `stream-json-result`、混成一个标签就等于宣称补全了」的同一条纪律。
 *
 * ## 为什么账本行要分 `pool`
 *
 * D2 把预算分成两笔：**例行 $150/月**（P3 起）与 **P2 一次性 $130**（k=3 基线那批。
 * 原文：「单独批，不占例行预算」）。只记一个总数的话，T15 跑完 k=3（≈$78）就吃掉了
 * 例行额度的一半，之后的 L2 会被一条本该无关的预算拦住。
 *
 * 所以账本行带 `pool: "routine" | "oneoff"`：月上限只汇总 `routine`；
 * `oneoff` 照常记账（可审计、可复算）但不参与判定。这是**记账口径**不是**新预算**——
 * 一次性那 $130 的总量由人批，本模块不对它做熔断（D2 没要求，别在这里发明）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidHomePath } from "../../../packages/core/src/config/paths.ts";

/** 例行预算月度上限（美元）。§7.1 D2 裁决值，⛔ 不改命令行可覆盖——硬熔断不能被随手放宽。 */
export const MONTHLY_CAP_USD = 150;

/**
 * 单题预算上限默认值（美元）——成本拿不到时按它计入，而不是按 0。
 *
 * 取 §5.4 第 2 条里那个 `MAX_BUDGET_USD=1.8`。它是**记账上界**不是真实花费：
 * 用真实分布的上界记，账本只会偏保守（多算），不会漏算。
 */
export const DEFAULT_PER_TASK_CAP_USD = 1.8;

/** 账本行格式版本。加字段不必 bump；改既有字段的**语义**必须 bump。 */
export const LEDGER_SCHEMA_VERSION = 1;

export const LAYERS = ["L1", "L2"] as const;
export type EvalLayer = (typeof LAYERS)[number];

export const POOLS = ["routine", "oneoff"] as const;
export type BudgetPool = (typeof POOLS)[number];

/** 账本一次运行一行。字段语义见文件头「三个刻意写死的口径」。 */
export interface LedgerEntry {
  schema_version: number;
  /** 带本地偏移的 ISO 8601，月份由它前 7 位派生。 */
  ts: string;
  pool: BudgetPool;
  layer: EvalLayer;
  /** 被测版本号；L1 冒烟可能没有，写 null 而不是编一个。 */
  version: string | null;
  planned_cap_usd: number;
  /** 实付（已含 null 成本的折算，折算量单独记在 null_cost_tasks）。 */
  actual_usd: number;
  /** 本次有多少题的成本是 null、按单题上限折算的。0 表示实付全部来自真实上报。 */
  null_cost_tasks: number;
  note?: string;
}

export type BudgetRefusalCode = "ok" | "over-monthly-cap" | "ledger-corrupt" | "invalid-input";

export interface BudgetDecision {
  allowed: boolean;
  /** 与方案 §5.2 对齐：账本拒绝开跑判 INVALID。 */
  verdict: "ALLOW" | "INVALID";
  code: BudgetRefusalCode;
  /** 人类可读的一条理由（拒绝时给出该改什么）。 */
  reason: string;
  month: string;
  layer: EvalLayer;
  pool: BudgetPool;
  /** 判定所依据的「本月已花」（routine 池；oneoff 池恒为 0 且不参与判定）。 */
  spent_usd: number;
  planned_cap_usd: number;
  /** oneoff 池没有月上限，这里落 null 而不是编一个 $150。 */
  monthly_cap_usd: number | null;
  remaining_usd: number | null;
  ledger_path: string;
}

/** 账本路径。走 `sidHomePath` 派生，所以 `SID_CONFIG_DIR` 重定向对它天然生效。 */
export function ledgerPath(): string {
  return sidHomePath("eval-gate", "ledger.jsonl");
}

/**
 * 本地时区偏移的 ISO 8601（`2026-11-05T10:23:00.000+08:00`）。
 *
 * ⛔ 不要换成 `toISOString()`：它给的是 UTC，而账本的「月」是本地自然月，
 * 两者在月初/月末会差一天，直接读前 7 位就会归错月。
 */
export function isoWithLocalOffset(date: Date): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

/** 月份键 `YYYY-MM`。来源只有一个：行上的 `ts` 前 7 位。 */
export function monthOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}T/.exec(iso);
  if (!m) throw new Error(`不是合法的 ISO 8601 时间戳: ${iso}`);
  return `${m[1]}-${m[2]}`;
}

/** 当前月份的键。测试注入 `now`，不要直接读系统时钟。 */
export function currentMonth(now: Date = new Date()): string {
  return monthOf(isoWithLocalOffset(now));
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export interface LedgerReadResult {
  entries: LedgerEntry[];
  /** 坏行：行号（1-based）+ 原因。非空即 fail-closed。 */
  corrupt: Array<{ line: number; reason: string }>;
}

/**
 * 读账本。**不抛异常**：坏行收集进 `corrupt` 由调用方判 INVALID。
 *
 * 空行跳过（尾部空行是正常的）；其余每一行都必须能完整解释——见文件头口径②。
 */
export function readLedger(path: string = ledgerPath()): LedgerReadResult {
  if (!existsSync(path)) return { entries: [], corrupt: [] };

  const raw = readFileSync(path, "utf8");
  const entries: LedgerEntry[] = [];
  const corrupt: Array<{ line: number; reason: string }> = [];

  raw.split("\n").forEach((line, idx) => {
    if (line.trim() === "") return;
    const lineNo = idx + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt.push({ line: lineNo, reason: "不是合法 JSON" });
      return;
    }
    const reason = validateEntry(parsed);
    if (reason) {
      corrupt.push({ line: lineNo, reason });
      return;
    }
    entries.push(parsed as LedgerEntry);
  });

  return { entries, corrupt };
}

/** 逐字段校验一行账本。返回 null 表示合法；否则返回具体原因（点名到字段）。 */
function validateEntry(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "不是对象";
  const e = value as Record<string, unknown>;

  if (e.schema_version !== LEDGER_SCHEMA_VERSION) {
    // 比当前版本大 = 这一行用了本文件读不懂的格式，不能猜；小 = 迁升没做。
    return `schema_version=${String(e.schema_version)}（本模块只认 ${LEDGER_SCHEMA_VERSION}）`;
  }
  if (typeof e.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(e.ts))
    return "ts 缺失或不是 ISO 8601";
  if (!LAYERS.includes(e.layer as EvalLayer))
    return `layer=${String(e.layer)} 不在 ${LAYERS.join("/")}`;
  if (!POOLS.includes(e.pool as BudgetPool))
    return `pool=${String(e.pool)} 不在 ${POOLS.join("/")}`;
  if (!isFiniteNonNegative(e.planned_cap_usd)) return "planned_cap_usd 不是非负有限数";
  if (!isFiniteNonNegative(e.actual_usd)) return "actual_usd 不是非负有限数";
  const nullTasks = e.null_cost_tasks ?? 0;
  if (!Number.isInteger(nullTasks) || (nullTasks as number) < 0) {
    return "null_cost_tasks 不是非负整数";
  }
  return null;
}

/** 某月的实付汇总，按池分开。 */
export interface MonthSummary {
  month: string;
  routine_usd: number;
  oneoff_usd: number;
  routine_runs: number;
  oneoff_runs: number;
}

export function summarizeMonth(entries: LedgerEntry[], month: string): MonthSummary {
  const out: MonthSummary = {
    month,
    routine_usd: 0,
    oneoff_usd: 0,
    routine_runs: 0,
    oneoff_runs: 0,
  };
  for (const e of entries) {
    if (monthOf(e.ts) !== month) continue;
    if (e.pool === "routine") {
      out.routine_usd += e.actual_usd;
      out.routine_runs += 1;
    } else {
      out.oneoff_usd += e.actual_usd;
      out.oneoff_runs += 1;
    }
  }
  // 浮点累加在 $150 边界上可能差 1e-13，四舍五入到 6 位小数（远小于 1 美分）。
  out.routine_usd = round6(out.routine_usd);
  out.oneoff_usd = round6(out.oneoff_usd);
  return out;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export interface CheckOptions {
  layer: EvalLayer;
  plannedCapUsd: number;
  pool?: BudgetPool;
  now?: Date;
  /** 仅供单测注入；CLI **不暴露**这个开关（见 MONTHLY_CAP_USD 的注释）。 */
  monthlyCapUsd?: number;
  ledger?: string;
}

/**
 * 开跑前判定。**纯读，不写账本、不调模型。**
 *
 * 判定只有一条规则（§5.4-6 原文）：`本月已花 + 本次上限 > $150` → 拒绝。
 * 严格大于，所以恰好用满 $150 是允许的。
 */
export function checkBudget(opts: CheckOptions): BudgetDecision {
  const pool: BudgetPool = opts.pool ?? "routine";
  const monthlyCap = opts.monthlyCapUsd ?? MONTHLY_CAP_USD;
  const path = opts.ledger ?? ledgerPath();
  const month = currentMonth(opts.now ?? new Date());
  const base = {
    month,
    layer: opts.layer,
    pool,
    planned_cap_usd: opts.plannedCapUsd,
    ledger_path: path,
  };

  if (!isFiniteNonNegative(opts.plannedCapUsd)) {
    return {
      ...base,
      allowed: false,
      verdict: "INVALID",
      code: "invalid-input",
      reason: `本次上限 ${String(opts.plannedCapUsd)} 不是非负有限数，拒绝开跑`,
      spent_usd: 0,
      monthly_cap_usd: null,
      remaining_usd: null,
    };
  }

  const { entries, corrupt } = readLedger(path);
  if (corrupt.length > 0) {
    const detail = corrupt.map((c) => `第 ${c.line} 行：${c.reason}`).join("；");
    return {
      ...base,
      allowed: false,
      verdict: "INVALID",
      code: "ledger-corrupt",
      // 修账本之前一律不放行：读不懂账本 = 不知道本月已花，放行等于熔断失效。
      reason: `账本 ${path} 有 ${corrupt.length} 处坏行，无法判定本月已花，拒绝开跑（${detail}）`,
      spent_usd: 0,
      monthly_cap_usd: null,
      remaining_usd: null,
    };
  }

  const summary = summarizeMonth(entries, month);

  if (pool === "oneoff") {
    // 一次性预算由人单独批（D2），本模块不对它做熔断；照实报出已用多少供审计。
    return {
      ...base,
      allowed: true,
      verdict: "ALLOW",
      code: "ok",
      reason: `oneoff 池不参与月上限判定（本月已用 $${summary.oneoff_usd.toFixed(2)}，仅供审计）`,
      spent_usd: summary.oneoff_usd,
      monthly_cap_usd: null,
      remaining_usd: null,
    };
  }

  const remaining = round6(monthlyCap - summary.routine_usd);
  const wouldSpend = round6(summary.routine_usd + opts.plannedCapUsd);

  if (wouldSpend > monthlyCap) {
    return {
      ...base,
      allowed: false,
      verdict: "INVALID",
      code: "over-monthly-cap",
      reason:
        `本月已花 $${summary.routine_usd.toFixed(2)} + 本次上限 $${opts.plannedCapUsd.toFixed(2)} ` +
        `= $${wouldSpend.toFixed(2)} > $${monthlyCap.toFixed(2)}，拒绝开跑`,
      spent_usd: summary.routine_usd,
      monthly_cap_usd: monthlyCap,
      remaining_usd: remaining,
    };
  }

  return {
    ...base,
    allowed: true,
    verdict: "ALLOW",
    code: "ok",
    reason:
      `本月已花 $${summary.routine_usd.toFixed(2)} + 本次上限 $${opts.plannedCapUsd.toFixed(2)} ` +
      `= $${wouldSpend.toFixed(2)} ≤ $${monthlyCap.toFixed(2)}，允许开跑`,
    spent_usd: summary.routine_usd,
    monthly_cap_usd: monthlyCap,
    remaining_usd: remaining,
  };
}

/**
 * 熔断闸门：判定通过才执行 runner。
 *
 * 存在的理由是**让「零模型调用」可被断言**，而不是靠「check 是纯读函数」这句话自证：
 * 模型调用一定发生在 runner 里，拒绝时 `run` 一次都不会被调用。
 */
export function withBudgetGate<T>(
  decision: BudgetDecision,
  run: () => T,
): { ran: boolean; result?: T } {
  if (!decision.allowed) return { ran: false };
  return { ran: true, result: run() };
}

/**
 * 逐题成本 → 本次实付。
 *
 * 判据（§5.4-6）：**成本为 null 的题按单题上限记，不按 0**。
 * 非 null 的成本必须是有限非负数——负数 / NaN 同样按单题上限记并计入 `nullCostTasks`，
 * 因为它们和 null 一样「不是一笔可信的真实花费」，按 0 记会让账本偏乐观。
 */
export function effectiveRunCost(
  costs: ReadonlyArray<number | null | undefined>,
  perTaskCapUsd: number = DEFAULT_PER_TASK_CAP_USD,
): { totalUsd: number; reportedUsd: number; assumedUsd: number; nullCostTasks: number } {
  if (!isFiniteNonNegative(perTaskCapUsd)) {
    throw new Error(`单题上限 ${String(perTaskCapUsd)} 不是非负有限数`);
  }
  let reportedUsd = 0;
  let assumedUsd = 0;
  let nullCostTasks = 0;
  for (const c of costs) {
    if (isFiniteNonNegative(c)) {
      reportedUsd += c;
    } else {
      assumedUsd += perTaskCapUsd;
      nullCostTasks += 1;
    }
  }
  return {
    totalUsd: round6(reportedUsd + assumedUsd),
    reportedUsd: round6(reportedUsd),
    assumedUsd: round6(assumedUsd),
    nullCostTasks,
  };
}

export interface RecordOptions {
  layer: EvalLayer;
  plannedCapUsd: number;
  actualUsd: number;
  pool?: BudgetPool;
  version?: string | null;
  nullCostTasks?: number;
  note?: string;
  now?: Date;
  ledger?: string;
}

/** 追加一行账本。append-only：不重写、不排序、不改历史行。 */
export function recordRun(opts: RecordOptions): LedgerEntry {
  if (!isFiniteNonNegative(opts.plannedCapUsd)) {
    throw new Error(`planned_cap_usd ${String(opts.plannedCapUsd)} 不是非负有限数`);
  }
  if (!isFiniteNonNegative(opts.actualUsd)) {
    throw new Error(`actual_usd ${String(opts.actualUsd)} 不是非负有限数`);
  }
  const nullCostTasks = opts.nullCostTasks ?? 0;
  if (!Number.isInteger(nullCostTasks) || nullCostTasks < 0) {
    throw new Error(`null_cost_tasks ${String(nullCostTasks)} 不是非负整数`);
  }

  const entry: LedgerEntry = {
    schema_version: LEDGER_SCHEMA_VERSION,
    ts: isoWithLocalOffset(opts.now ?? new Date()),
    pool: opts.pool ?? "routine",
    layer: opts.layer,
    version: opts.version ?? null,
    planned_cap_usd: opts.plannedCapUsd,
    actual_usd: opts.actualUsd,
    null_cost_tasks: nullCostTasks,
  };
  if (opts.note) entry.note = opts.note;

  const path = opts.ledger ?? ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}
