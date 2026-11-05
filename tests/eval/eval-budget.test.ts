/**
 * `scripts/eval/lib/eval-budget.ts` + CLI 的单测（任务 T19 / 方案 §5.4-6）。
 *
 * ## 判据是什么（写在最前面，免得后来的人只看到一堆 expect）
 *
 * 方案 §5.4 第 6 条原文：每次 L1/L2 开跑前读本月账本，
 * **`本月已花 + 本次上限 > $150` 即拒绝开跑并判 `INVALID`**；
 * 完成判据是「**账本写到 $149 再开跑必须被拒，且零模型调用**」。
 *
 * 所以下面最核心的一组是：
 *   · `$149 + $2 = $151 > $150` → 拒绝（第 3 组）
 *   · `$149 + $1 = $150` → 允许（严格大于才拒绝，边界不能写成 `>=`）
 *   · 拒绝时 `withBudgetGate` 的 runner **一次都不执行**（第 6 组）——
 *     这就是「零模型调用」的结构性证明：模型调用只能发生在 runner 里。
 *
 * ## 落盘隔离（CONTRIBUTING「测试约定」）
 *
 * 账本会写 `~/.sid-code/eval-gate/ledger.jsonl`。本文件**显式**把 `SID_CONFIG_DIR`
 * 指到 tmpdir 并**存/恢复原值**（不是无条件 delete —— 同批测试同进程跑，删掉会
 * 把 preload 的兜底一起抹掉）。CLI 子进程也显式传 `SID_CONFIG_DIR`
 * ——子进程不继承进程内的 env 改动。
 *
 * 日期一律用**本地时间构造**（`new Date(2026, 10, 15)`），不写 `+08:00` 字面量：
 * 后者在 UTC runner 上会被解析成前一天，月初/月末的用例会跨时区飘。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_PER_TASK_CAP_USD,
  LEDGER_SCHEMA_VERSION,
  MONTHLY_CAP_USD,
  checkBudget,
  currentMonth,
  effectiveRunCost,
  isoWithLocalOffset,
  ledgerPath,
  monthOf,
  readLedger,
  recordRun,
  summarizeMonth,
  withBudgetGate,
  type LedgerEntry,
} from "../../scripts/eval/lib/eval-budget.ts";

const CLI = join(import.meta.dir, "..", "..", "scripts", "eval", "eval-budget.ts");

let sandbox: string;
/** 原始值：必须存下来恢复，不能无条件 delete。 */
const originalConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "sid-eval-budget-"));
  process.env.SID_CONFIG_DIR = sandbox;
});

afterEach(() => {
  // 恢复原值而不是 delete：delete 会把 bunfig preload 的兜底一起抹掉（同进程多文件）。
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(sandbox, { recursive: true, force: true });
});

function ledgerFile(): string {
  return join(sandbox, "eval-gate", "ledger.jsonl");
}

/** 本地时间构造，避开跨时区时「本地月 ≠ 字面量月」的坑。 */
function localDate(year: number, month1: number, day = 15): Date {
  return new Date(year, month1 - 1, day, 12, 0, 0);
}

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, "actual_usd">): LedgerEntry {
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    ts: isoWithLocalOffset(localDate(2026, 11)),
    pool: "routine",
    layer: "L2",
    version: "0.1.615",
    planned_cap_usd: 40,
    null_cost_tasks: 0,
    ...over,
  };
}

function writeLedger(lines: Array<LedgerEntry | string>): void {
  mkdirSync(join(sandbox, "eval-gate"), { recursive: true });
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  writeFileSync(ledgerFile(), `${body}\n`, "utf8");
}

// ───────────────────────────────────────────────────────── ① 时间与月份口径

describe("① 月份口径：从带本地偏移的 ts 派生，不经 UTC", () => {
  test("isoWithLocalOffset 带本地偏移，不是 Z", () => {
    const iso = isoWithLocalOffset(localDate(2026, 11, 5));
    expect(iso).toStartWith("2026-11-05T");
    expect(iso).not.toContain("Z");
    expect(iso).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  test("monthOf 取前 7 位；非法 ts 抛错而不是猜一个月份", () => {
    expect(monthOf("2026-11-05T10:00:00.000+08:00")).toBe("2026-11");
    expect(monthOf("2025-01-31T23:59:59.000-05:00")).toBe("2025-01");
    expect(() => monthOf("2026/11/05")).toThrow();
  });

  test("currentMonth 与写入端的本地月一致", () => {
    expect(currentMonth(localDate(2026, 3, 1))).toBe("2026-03");
    expect(currentMonth(localDate(2026, 3, 31))).toBe("2026-03");
  });
});

// ───────────────────────────────────────────────────────── ② 账本读写

describe("② 账本读取：坏行 fail-closed，空行跳过", () => {
  test("文件不存在 = 空账本，不是错误", () => {
    expect(readLedger(ledgerFile())).toEqual({ entries: [], corrupt: [] });
  });

  test("空行跳过，合法行读回", () => {
    writeLedger([entry({ actual_usd: 1 }), "", entry({ actual_usd: 2 })]);
    const r = readLedger(ledgerFile());
    expect(r.entries).toHaveLength(2);
    expect(r.corrupt).toEqual([]);
  });

  test("坏行进 corrupt 并点名行号（不静默跳过）", () => {
    writeLedger([
      entry({ actual_usd: 1 }),
      "{ 不是 json",
      JSON.stringify({ ...entry({ actual_usd: 2 }), schema_version: 99 }),
      JSON.stringify({ ...entry({ actual_usd: 3 }), pool: "other" }),
      JSON.stringify({ ...entry({ actual_usd: 4 }), actual_usd: null }),
    ]);
    const r = readLedger(ledgerFile());
    expect(r.entries).toHaveLength(1);
    expect(r.corrupt.map((c) => c.line)).toEqual([2, 3, 4, 5]);
    expect(r.corrupt[1]!.reason).toContain("schema_version");
    expect(r.corrupt[2]!.reason).toContain("pool");
    expect(r.corrupt[3]!.reason).toContain("actual_usd");
  });

  test("summarizeMonth 只汇总指定月，且按池分开", () => {
    const entries = [
      entry({ actual_usd: 10 }),
      entry({ actual_usd: 20, pool: "oneoff" }),
      entry({ actual_usd: 5, ts: isoWithLocalOffset(localDate(2026, 10)) }),
      entry({ actual_usd: 7 }),
    ];
    const s = summarizeMonth(entries, "2026-11");
    expect(s.routine_usd).toBe(17);
    expect(s.routine_runs).toBe(2);
    expect(s.oneoff_usd).toBe(20);
    expect(s.oneoff_runs).toBe(1);
  });
});

// ───────────────────────────────────────────────────────── ③ 熔断判定

describe("③ 熔断：本月已花 + 本次上限 > $150 才拒绝（判据是完成判据原文）", () => {
  test("空账本 → 允许", () => {
    const d = checkBudget({ layer: "L2", plannedCapUsd: 40, now: localDate(2026, 11) });
    expect(d.allowed).toBe(true);
    expect(d.verdict).toBe("ALLOW");
    expect(d.spent_usd).toBe(0);
    expect(d.remaining_usd).toBe(MONTHLY_CAP_USD);
  });

  test("账本写到 $149 + 本次上限 $2 → 拒绝（INVALID / over-monthly-cap）", () => {
    writeLedger([entry({ actual_usd: 100 }), entry({ actual_usd: 49 })]);
    const d = checkBudget({ layer: "L2", plannedCapUsd: 2, now: localDate(2026, 11) });
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe("INVALID");
    expect(d.code).toBe("over-monthly-cap");
    expect(d.spent_usd).toBe(149);
    expect(d.reason).toContain("$149.00");
    expect(d.reason).toContain("$151.00");
  });

  test("边界：$149 + $1 = $150 → 允许（严格大于才拒绝）", () => {
    writeLedger([entry({ actual_usd: 149 })]);
    const d = checkBudget({ layer: "L2", plannedCapUsd: 1, now: localDate(2026, 11) });
    expect(d.allowed).toBe(true);
    expect(d.remaining_usd).toBe(1);
  });

  test("上个月的花费不占本月（同一账本、只差月份）", () => {
    writeLedger([
      entry({ actual_usd: 149, ts: isoWithLocalOffset(localDate(2026, 10)) }),
      entry({ actual_usd: 149, ts: isoWithLocalOffset(localDate(2026, 10, 31)) }),
    ]);
    const d = checkBudget({ layer: "L2", plannedCapUsd: 40, now: localDate(2026, 11) });
    expect(d.allowed).toBe(true);
    expect(d.spent_usd).toBe(0);
  });

  test("本次上限本身就超过余额（$149 + $40）→ 拒绝", () => {
    writeLedger([entry({ actual_usd: 149 })]);
    const d = checkBudget({ layer: "L2", plannedCapUsd: 40, now: localDate(2026, 11) });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("$189.00");
  });

  test("坏行 → INVALID(ledger-corrupt)，点名行号（不能把坏行当 0）", () => {
    writeLedger([entry({ actual_usd: 10 }), "{坏行"]);
    const d = checkBudget({ layer: "L2", plannedCapUsd: 1, now: localDate(2026, 11) });
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe("INVALID");
    expect(d.code).toBe("ledger-corrupt");
    expect(d.reason).toContain("第 2 行");
  });

  test("本次上限非法（负数/NaN）→ INVALID(invalid-input)", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = checkBudget({ layer: "L2", plannedCapUsd: bad, now: localDate(2026, 11) });
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("invalid-input");
    }
  });

  test("oneoff 池不参与月上限判定，但照实报出已用", () => {
    writeLedger([entry({ actual_usd: 149 }), entry({ actual_usd: 78, pool: "oneoff" })]);
    const d = checkBudget({
      layer: "L2",
      plannedCapUsd: 40,
      pool: "oneoff",
      now: localDate(2026, 11),
    });
    expect(d.allowed).toBe(true);
    expect(d.monthly_cap_usd).toBeNull();
    expect(d.spent_usd).toBe(78);
  });

  test("oneoff 的花费不占例行预算（否则 k=3 一次 $78 就吃掉半年的例行额度）", () => {
    writeLedger([entry({ actual_usd: 149 }), entry({ actual_usd: 78, pool: "oneoff" })]);
    const d = checkBudget({ layer: "L2", plannedCapUsd: 1, now: localDate(2026, 11) });
    // 例行仍是 149，oneoff 的 78 不参与 → 149 + 1 = 150 ≤ 150 允许。
    expect(d.allowed).toBe(true);
    expect(d.spent_usd).toBe(149);
  });
});

// ───────────────────────────────────────────────────────── ④ null 成本口径

describe("④ 成本为 null 的题按单题上限记，不按 0（§5.4-6 原文）", () => {
  test("null → 单题上限；折算量单独报出", () => {
    const c = effectiveRunCost([1.2, null, 0.8]);
    expect(c.reportedUsd).toBe(2);
    expect(c.assumedUsd).toBe(DEFAULT_PER_TASK_CAP_USD);
    expect(c.totalUsd).toBe(2 + DEFAULT_PER_TASK_CAP_USD);
    expect(c.nullCostTasks).toBe(1);
  });

  test("负数 / NaN 与 null 同档（都不是可信花费，按 0 记会偏乐观）", () => {
    const c = effectiveRunCost([1, -3, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(c.reportedUsd).toBe(1);
    expect(c.nullCostTasks).toBe(3);
    expect(c.assumedUsd).toBe(3 * DEFAULT_PER_TASK_CAP_USD);
  });

  test("全部为 null 时不返回 0", () => {
    const c = effectiveRunCost([null, null]);
    expect(c.reportedUsd).toBe(0);
    expect(c.totalUsd).toBe(2 * DEFAULT_PER_TASK_CAP_USD);
    expect(c.totalUsd).toBeGreaterThan(0);
  });

  test("空数组 = 0（没有题就没有花费，这一支允许为 0）", () => {
    const c = effectiveRunCost([]);
    expect(c.totalUsd).toBe(0);
    expect(c.nullCostTasks).toBe(0);
  });

  test("单题上限本身非法时抛错", () => {
    expect(() => effectiveRunCost([null], -1)).toThrow();
  });
});

// ───────────────────────────────────────────────────────── ⑤ 记账

describe("⑤ 记账：append-only，路径跟随 SID_CONFIG_DIR", () => {
  test("ledgerPath 落在 SID_CONFIG_DIR 之下（不写真实 ~/.sid-code）", () => {
    expect(ledgerPath()).toBe(ledgerFile());
    expect(ledgerPath().startsWith(sandbox)).toBe(true);
  });

  test("recordRun 自动建目录并追加，读回逐字段一致", () => {
    const written = recordRun({
      layer: "L2",
      plannedCapUsd: 40,
      actualUsd: 26.21,
      version: "0.1.615",
      now: localDate(2026, 11),
    });
    const r = readLedger(ledgerFile());
    expect(r.corrupt).toEqual([]);
    expect(r.entries).toEqual([written]);
    expect(r.entries[0]!.actual_usd).toBe(26.21);
    expect(r.entries[0]!.version).toBe("0.1.615");
    expect(monthOf(r.entries[0]!.ts)).toBe("2026-11");
  });

  test("两次 recordRun = 两行（不覆盖历史）", () => {
    recordRun({ layer: "L1", plannedCapUsd: 2, actualUsd: 0.4, now: localDate(2026, 11) });
    recordRun({ layer: "L2", plannedCapUsd: 40, actualUsd: 26, now: localDate(2026, 11) });
    const lines = readFileSync(ledgerFile(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("recordRun 校验入参，非法值抛错而不是静默写坏行", () => {
    const base = { layer: "L2" as const, plannedCapUsd: 40, actualUsd: 1 };
    expect(() => recordRun({ ...base, plannedCapUsd: -1 })).toThrow();
    expect(() => recordRun({ ...base, actualUsd: Number.NaN })).toThrow();
    expect(() => recordRun({ ...base, nullCostTasks: 1.5 })).toThrow();
  });

  test("记账后熔断立刻看得到（record → check 闭环）", () => {
    recordRun({ layer: "L2", plannedCapUsd: 40, actualUsd: 149, now: localDate(2026, 11) });
    const d = checkBudget({ layer: "L2", plannedCapUsd: 2, now: localDate(2026, 11) });
    expect(d.allowed).toBe(false);
    expect(d.spent_usd).toBe(149);
  });
});

// ───────────────────────────────────────────────────────── ⑥ 零模型调用

describe("⑥ 零模型调用：拒绝时 runner 一次都不执行", () => {
  test("拒绝 → runner 不被调用（不是「先跑再判」）", () => {
    writeLedger([entry({ actual_usd: 149 })]);
    const decision = checkBudget({ layer: "L2", plannedCapUsd: 2, now: localDate(2026, 11) });
    expect(decision.allowed).toBe(false);

    let calls = 0;
    const run = () => {
      calls += 1;
      return "ran";
    };
    const outcome = withBudgetGate(decision, run);
    expect(outcome.ran).toBe(false);
    expect(outcome.result).toBeUndefined();
    expect(calls).toBe(0); // ← 这就是「零模型调用」
  });

  test("允许 → runner 恰好一次", () => {
    const decision = checkBudget({ layer: "L2", plannedCapUsd: 40, now: localDate(2026, 11) });
    let calls = 0;
    const outcome = withBudgetGate(decision, () => {
      calls += 1;
      return "ok";
    });
    expect(outcome).toEqual({ ran: true, result: "ok" });
    expect(calls).toBe(1);
  });
});

// ───────────────────────────────────────────────────────── ⑦ CLI

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 子进程**显式**传 SID_CONFIG_DIR（不继承进程内 env 改动，CONTRIBUTING 坑 4）。 */
function runCli(args: string[]): CliResult {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, SID_CONFIG_DIR: sandbox },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("⑦ CLI：退出码就是判据（0 允许 / 2 拒绝 / 1 用法错）", () => {
  test("--help 退出 0", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("eval-budget");
  });

  test("空账本 check → 0，且 --json 可解析", () => {
    const r = runCli(["check", "--layer", "L2", "--planned-cap-usd", "40", "--json"]);
    expect(r.status).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.allowed).toBe(true);
    expect(d.ledger_path).toBe(ledgerFile());
  });

  test("账本写到 $149 再开跑 → 退出码 2，且账本一行都没多（零模型调用）", () => {
    writeLedger([entry({ actual_usd: 149 })]);
    const before = readFileSync(ledgerFile(), "utf8");

    const r = runCli(["check", "--layer", "L2", "--planned-cap-usd", "2"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("INVALID");
    expect(r.stdout).toContain("$149.00");

    // 拒绝路径不记账：没开跑就没有花费，账本必须逐字节不变。
    expect(readFileSync(ledgerFile(), "utf8")).toBe(before);
  });

  test("record 用 --costs-json 时按单题上限折算，并记下 null 题数", () => {
    const r = runCli([
      "record",
      "--layer",
      "L2",
      "--planned-cap-usd",
      "40",
      "--costs-json",
      "[1.5,null]",
      "--json",
    ]);
    expect(r.status).toBe(0);
    const written = JSON.parse(r.stdout);
    expect(written.actual_usd).toBe(1.5 + DEFAULT_PER_TASK_CAP_USD);
    expect(written.null_cost_tasks).toBe(1);
  });

  test("record 后 summary 看得到当月花费", () => {
    runCli(["record", "--layer", "L2", "--planned-cap-usd", "40", "--actual-usd", "26.21"]);
    const r = runCli(["summary", "--json"]);
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.routine_usd).toBe(26.21);
    expect(s.routine_runs).toBe(1);
  });

  test("用法错误 → 退出 1（与「拒绝开跑」的 2 分开，两者处置不同）", () => {
    expect(runCli(["check", "--layer", "L9", "--planned-cap-usd", "1"]).status).toBe(1);
    expect(runCli(["check", "--layer", "L2"]).status).toBe(1);
    expect(runCli(["record", "--layer", "L2", "--planned-cap-usd", "40"]).status).toBe(1);
    expect(runCli(["bogus"]).status).toBe(1);
  });

  test("--actual-usd 与 --costs-json 同时给 → 退出 1（口径不能混）", () => {
    const r = runCli([
      "record",
      "--layer",
      "L2",
      "--planned-cap-usd",
      "40",
      "--actual-usd",
      "1",
      "--costs-json",
      "[1]",
    ]);
    expect(r.status).toBe(1);
  });

  test("summary 遇到坏行退出 2 并点名（它就是下次 check 被拒的原因）", () => {
    writeLedger([entry({ actual_usd: 1 }), "{坏行"]);
    const r = runCli(["summary"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("第 2 行");
  });
});
