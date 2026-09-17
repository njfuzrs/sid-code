#!/usr/bin/env bun
/**
 * 删除账本里按**错误定价口径**记下的历史行（D3 的收尾动作）
 *
 * ## 为什么是「删」而不是「回填修正」
 *
 * 这些行的 `costUSD` 是用网关**残留旧字段**算出来的（`model_ratio × 2`），而当前生效的
 * 计费口径是 `billing_expr`。实测偏差**有正有负**（12 个受损模型里既有高报 500 倍的，
 * 也有低报到 0.3x 的），所以：
 *
 * - **不能只删"贵得离谱"的**：低报的那些同样是错数，且任何"找异常大的价"的思路都漏掉它们；
 * - **不能原地重算 `costUSD`**：账本是 append-only 事实源，原地改写等于销毁证据 ——
 *   事后再也分不清"这行本来记了多少"与"我们后来算成了多少"；
 * - **回填一列 `corrected_cost_usd` 也不选**：两列并存意味着每个消费侧都要选一列，
 *   而选错的形态是静默的（图照样出、数照样有）。
 *
 * ⇒ 决定是**整行删除**。判据：这些行的 `costUSD` 没有任何正确解读方式，
 * 留着只会让"更省"方向的历史曲线上有一段无法归因的错数；删掉则那段是**缺口**，
 * 而缺口是诚实的 —— `n` 会变小，看图的人知道这里没有数据，
 * 而不是拿到一个看起来正常的错数。
 *
 * ## 安全设计
 *
 * - **默认 dry-run**，`--apply` 才真写；
 * - 写之前**必然**先备份到 `usage-ledger.jsonl.bak-<时间戳>`，备份失败即中止；
 * - 只删「model 命中受损清单」且 `ts` 落在受损窗口内的行，其余行**逐字节原样保留**
 *   （包括无法解析的损坏行 —— 它们不属于本次任务，见 CLAUDE.md §0 铁律）；
 * - 受损模型清单**从网关实时返回推导**（`billing_mode === "tiered_expr"`），
 *   不硬编码模型名：硬编码会在网关新增渠道时静默漏删。
 *
 * ## 用法
 *
 * ```bash
 * bun scripts/ledger-purge-bad-pricing.ts                    # dry-run，只报告
 * bun scripts/ledger-purge-bad-pricing.ts --apply            # 真删（先自动备份）
 * bun scripts/ledger-purge-bad-pricing.ts --until 2026-09-17 # 只删这个日期之前的
 * ```
 *
 * 退出码：0 = 正常（含 dry-run）；1 = 参数/备份/写盘失败。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { ledgerPath } from "../packages/core/src/telemetry/usage-ledger.ts";
import { derivePricingURL } from "../packages/core/src/llm/gateway-pricing.ts";

/** 默认网关端点 —— 只用于**推导受损模型清单**，不参与计价。 */
const DEFAULT_GATEWAY = "https://uniapi.ruijie.com.cn/v1";

/**
 * 账本路径 —— 复用 `usage-ledger.ts` 的 `ledgerPath()` 而不是自己拼。
 * 它会应用 `SID_CODE_USAGE_LEDGER` 覆盖，自己拼会在测试/隔离环境里指到真实账本上。
 */
function ledgerFile(): string {
  return ledgerPath();
}

/** 从网关实时返回推导「按 expr 计费」的模型名集合。拿不到就中止 —— 不猜。 */
async function fetchExprModels(baseURL: string): Promise<Set<string>> {
  const url = derivePricingURL(baseURL);
  const resp = await fetch(url, {
    headers: { accept: "application/json", "new-api-user": "-1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`网关返回 HTTP ${resp.status}`);
  const body = (await resp.json()) as { data?: Array<Record<string, unknown>> };
  const list = Array.isArray(body.data) ? body.data : [];
  const out = new Set<string>();
  for (const e of list) {
    if (e.billing_mode === "tiered_expr" && typeof e.model_name === "string") out.add(e.model_name);
  }
  if (out.size === 0)
    throw new Error("网关返回里没有任何 tiered_expr 条目 —— 口径可能又变了，中止");
  return out;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const untilArg = args[args.indexOf("--until") + 1];
  const until =
    args.includes("--until") && untilArg ? Date.parse(`${untilArg}T23:59:59Z`) / 1000 : Infinity;
  if (Number.isNaN(until)) {
    console.error("✗ --until 需要 YYYY-MM-DD 格式");
    return 1;
  }
  const baseURL = args.includes("--base-url")
    ? args[args.indexOf("--base-url") + 1]
    : DEFAULT_GATEWAY;

  const path = ledgerFile();
  if (!existsSync(path)) {
    console.error(`✗ 账本不存在：${path}`);
    return 1;
  }

  let exprModels: Set<string>;
  try {
    exprModels = await fetchExprModels(baseURL!);
  } catch (e) {
    console.error(`✗ 无法从网关推导受损模型清单：${String(e)}`);
    console.error("  受损清单必须来自上游事实，不硬编码也不猜 —— 请确认网络后重试。");
    return 1;
  }
  console.log(`受损模型（billing_mode=tiered_expr，${exprModels.size} 个）：`);
  for (const m of [...exprModels].sort()) console.log(`  · ${m}`);

  // 保留原始行文本：删除是"挑出要删的行、其余原样写回"，不做 JSON 重新序列化 ——
  // 重新序列化会改动键顺序/数字格式，让 diff 里出现大量与本次无关的变化。
  const lines = readFileSync(path, "utf-8").split("\n");
  const kept: string[] = [];
  const removed: Array<{ model: string; ts: number; costUSD: number }> = [];
  let unparsable = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let e: Record<string, unknown> | null = null;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unparsable++;
      kept.push(line); // 损坏行不属于本次任务，原样留着
      continue;
    }
    const model = typeof e.model === "string" ? e.model : "";
    const ts = typeof e.ts === "number" ? e.ts : 0;
    if (exprModels.has(model) && ts <= until) {
      removed.push({ model, ts, costUSD: typeof e.costUSD === "number" ? e.costUSD : 0 });
    } else {
      kept.push(line);
    }
  }

  const byModel = new Map<string, { n: number; cost: number }>();
  for (const r of removed) {
    const cur = byModel.get(r.model) ?? { n: 0, cost: 0 };
    byModel.set(r.model, { n: cur.n + 1, cost: cur.cost + r.costUSD });
  }
  const totalCost = removed.reduce((s, r) => s + r.costUSD, 0);

  console.log(`\n账本 ${path}`);
  console.log(`  总行数 ${lines.filter((l) => l.trim() !== "").length}（无法解析 ${unparsable}）`);
  console.log(
    `  待删 ${removed.length} 行，其 costUSD 合计 $${totalCost.toFixed(4)}（错数，非真实损失）`,
  );
  for (const [m, v] of [...byModel.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${String(v.n).padStart(4)} 行  $${v.cost.toFixed(4)}  ${m}`);
  }
  if (removed.length > 0) {
    const ts = removed.map((r) => r.ts);
    const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ");
    console.log(`  时间范围 ${fmt(Math.min(...ts))} → ${fmt(Math.max(...ts))} (UTC)`);
  }

  if (!apply) {
    console.log("\n（dry-run，未改动任何文件。确认无误后加 --apply）");
    return 0;
  }
  if (removed.length === 0) {
    console.log("\n没有需要删除的行，不动文件。");
    return 0;
  }

  // 备份必须成功才允许写 —— 删除不可逆。
  const backup = `${path}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  try {
    copyFileSync(path, backup);
  } catch (e) {
    console.error(`✗ 备份失败，中止（不在没有备份的情况下删数据）：${String(e)}`);
    return 1;
  }
  try {
    writeFileSync(path, kept.join("\n") + "\n", "utf-8");
  } catch (e) {
    console.error(`✗ 写盘失败：${String(e)}。原文件仍在，备份见 ${backup}`);
    return 1;
  }
  console.log(`\n✓ 已删除 ${removed.length} 行，剩余 ${kept.length} 行`);
  console.log(`  备份：${backup}`);
  console.log("  ⚠️ 「更省」方向的历史曲线在这段时间会出现缺口（n 变小）—— 这是刻意的：");
  console.log("     缺口是诚实的，而一个看起来正常的错数会被当成基线继续用下去。");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`✗ 未预期错误：${String(e)}`);
    process.exit(1);
  });
