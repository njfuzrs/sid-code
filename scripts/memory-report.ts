#!/usr/bin/env bun
/**
 * 记忆覆盖与抽取成本报告（记忆横向剖析 T1.3）—— 只读，不改任何文件。
 *
 * 回答两个此前答不了的问题：
 *   1. 每个记忆目录里「从没被读过 / 30 天没被读过」的有多少条（取数：`.read-stats.json`，T1.1）；
 *   2. 后台抽取（`fork:memory-extract`）最近 7 天花了多少请求与 token（取数：账本 `byAgent`，T1.2）。
 *
 * 口径（写死，改了要同步改 tests/scripts/memory-report.test.ts）：
 * - 条数：`enumerateMemoryFiles` 枚举（与 store / scan 同源，跳过 MEMORY.md、archive/ 等）
 * - 进索引：MEMORY.md 里 `- [key](文件)` 链接指向的文件
 * - 读过：`.read-stats.json` 里 readCount ≥ 1；30 天未读 = 从未读 + lastRead 早于 30 天前
 * - 抽取成本：账本行 `ts`（epoch 秒）落在最近 7 天内的会话，`byAgent[agentKey]` 求和。
 *   账本是每会话一行的累计值（stock），跨天会话整行计入其结束日 —— 是会话口径，不是请求口径。
 *
 * ⚠️ 读计数从 T1.1 上线才开始累计：上线前读过的记忆一律显示为「从未读」。报告会打印
 * 读计数文件的存在情况，`stats=无` 的目录不要拿去下「没人读」的结论。
 *
 * 用法：
 *   bun scripts/memory-report.ts                  # 全部项目记忆目录 + 全局记忆
 *   bun scripts/memory-report.ts <memory目录>      # 只看一个目录
 *   bun scripts/memory-report.ts --json
 *   bun scripts/memory-report.ts --agent fork:session-memory-update   # 换一个调用方看成本
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { enumerateMemoryFiles } from "../packages/core/src/memory/scan.ts";
import { readMemoryReadStats, READ_STATS_FILE } from "../packages/core/src/memory/read-stats.ts";
import { readUsageLedger } from "../packages/core/src/telemetry/usage-ledger.ts";
import type { UsageLedgerEntry } from "../packages/core/src/telemetry/usage-ledger.ts";
import { sidPaths, sidHomePath } from "../packages/core/src/config/paths.ts";

const DAY_MS = 86_400_000;

export interface DirReport {
  dir: string;
  files: number;
  inIndex: number;
  readAtLeastOnce: number;
  unread30d: number;
  hasReadStats: boolean;
}

export interface ExtractCost {
  agent: string;
  days: number;
  sessions: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

/** MEMORY.md 里的链接目标（相对路径），与 store.writeIndex 的行格式同形 */
export function indexLinks(dir: string): Set<string> {
  const p = join(dir, "MEMORY.md");
  const out = new Set<string>();
  if (!existsSync(p)) return out;
  for (const m of readFileSync(p, "utf8").matchAll(/^\s*-\s*\[[^\]]*\]\(([^)]+)\)/gm)) {
    out.add(m[1]!);
  }
  return out;
}

export async function dirReport(dir: string, now = Date.now()): Promise<DirReport> {
  const files = (await enumerateMemoryFiles(dir)).map((f) => f.split("\\").join("/"));
  const links = indexLinks(dir);
  const stats = readMemoryReadStats(dir);
  let inIndex = 0;
  let read = 0;
  let unread30 = 0;
  for (const f of files) {
    if (links.has(f)) inIndex++;
    const s = stats[f];
    if (s && s.readCount >= 1) read++;
    if (!s || now - s.lastRead > 30 * DAY_MS) unread30++;
  }
  return {
    dir,
    files: files.length,
    inIndex,
    readAtLeastOnce: read,
    unread30d: unread30,
    hasReadStats: existsSync(join(dir, READ_STATS_FILE)),
  };
}

export function extractCost(
  entries: UsageLedgerEntry[],
  opts: { agent?: string; days?: number; now?: number } = {},
): ExtractCost {
  const agent = opts.agent ?? "fork:memory-extract";
  const days = opts.days ?? 7;
  const sinceSec = Math.floor(((opts.now ?? Date.now()) - days * DAY_MS) / 1000);
  const r: ExtractCost = {
    agent,
    days,
    sessions: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  };
  for (const e of entries) {
    if (e.ts < sinceSec) continue;
    const a = e.byAgent?.[agent];
    if (!a) continue;
    r.sessions++;
    r.requests += a.requests;
    r.inputTokens += a.inputTokens;
    r.outputTokens += a.outputTokens;
    r.costUSD += a.costUSD;
  }
  return r;
}

function defaultDirs(): string[] {
  const dirs: string[] = [];
  const root = sidPaths.projects();
  if (existsSync(root)) {
    for (const p of readdirSync(root)) {
      const d = join(root, p, "memory");
      if (existsSync(d) && statSync(d).isDirectory()) dirs.push(d);
    }
  }
  const global = sidHomePath("memory");
  if (existsSync(global)) dirs.push(global);
  return dirs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const ai = args.indexOf("--agent");
  const agent = ai >= 0 ? args[ai + 1] : undefined;
  const explicit = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--agent");

  const dirs = explicit ? [explicit] : defaultDirs();
  const reports = (await Promise.all(dirs.map((d) => dirReport(d)))).filter((r) => r.files > 0);
  const ledger = readUsageLedger();
  const cost = extractCost(ledger, { agent });
  const ledgerWithByAgent = ledger.filter((e) => e.byAgent).length;

  if (json) {
    console.log(JSON.stringify({ dirs: reports, extract: cost, ledgerWithByAgent }, null, 2));
    return;
  }
  console.log("## 记忆覆盖（条数 / 进索引 / 读过≥1 次 / 30 天未读）");
  for (const r of reports) {
    console.log(
      `${r.files}\t${r.inIndex}\t${r.readAtLeastOnce}\t${r.unread30d}\t` +
        `stats=${r.hasReadStats ? "有" : "无"}\t${r.dir}`,
    );
  }
  const sum = (k: keyof DirReport) => reports.reduce((s, r) => s + (r[k] as number), 0);
  console.log(
    `合计\t${sum("files")}\t${sum("inIndex")}\t${sum("readAtLeastOnce")}\t${sum("unread30d")}`,
  );
  console.log("");
  console.log(`## ${cost.agent} 最近 ${cost.days} 天（账本会话口径）`);
  if (ledgerWithByAgent === 0) {
    console.log("（账本里还没有带 byAgent 的行：该字段随 T1.2 上线才开始写）");
  }
  console.log(
    `会话 ${cost.sessions}  请求 ${cost.requests}  输入 token ${cost.inputTokens}  ` +
      `输出 token ${cost.outputTokens}  成本 $${cost.costUSD.toFixed(4)}`,
  );
}

if (import.meta.main) await main();
