#!/usr/bin/env bun
/**
 * 账单对账脚本（方案 §5.6 · 档 C 兜底层）
 *
 * ## 为什么是"对账"而不是"定期同步价格"
 *
 * 「定期去官网抄价格」解决不了根本问题：它靠人记得跑，而且**跑没跑、抄对没抄对
 * 都没有信号**。2026-08-21 那次失效能潜伏 5 天（厂商 08-16 涨价、08-21 才发现），
 * 正是因为唯一的判据是"有人去看一眼"。
 *
 * 本脚本反过来：拿**官方账单金额**比我们的账本金额。它测的是**最终结果**，
 * 因此能同时抓住三类成因完全不同的问题 —— 而定期同步只能抓第一类：
 *
 * | 成因 | 定期同步能抓 | 本脚本能抓 |
 * | --- | --- | --- |
 * | 单价过期 / 币种错 / 时段没接（D1） | ✓ | ✓ |
 * | 幽灵流漏采（D2，22/39 未入账） | ✗ | ✓ |
 * | 影子调用漏计 | ✗ | ✓ |
 *
 * ## 它抓不住什么（如实标注）
 *
 * 偏差落在阈值内时它说"通过"，但**两个方向相反的错误可以互相掩护** ——
 * 2026-08-11 那次就是单价 ×4.94、用量 ×0.74，抵消成 ×3.63。所以：
 *   · 本脚本按**模型 / 端点分解**输出，不只给一个总数；
 *   · 单价本身另有逐项门禁（`tests/api/pricing-channel-mismatch.test.ts` D 组）。
 * 两层都要，缺一层就会被抵消骗过。
 *
 * ## 用法
 *
 * ```bash
 * # 官方账单 ¥7.23，区间 2026-08-21 全天
 * bun scripts/pricing-reconcile.ts --bill 7.23 --currency CNY \
 *   --from 2026-08-21 --to 2026-08-22
 *
 * # 只看账本、不比账单（先摸清自己这边的数）
 * bun scripts/pricing-reconcile.ts --from 2026-08-21 --to 2026-08-22
 * ```
 *
 * 退出码：偏差超阈值 → 1（可进 CI）；其余 → 0。
 */

import { readUsageLedger } from "../packages/core/src/telemetry/usage-ledger.ts";
import { getRegistryEntries } from "../packages/core/src/llm/model-registry.ts";

/** 偏差阈值：超过即判"价格口径失效"（方案 §5.6 定的 10%）。 */
const DEVIATION_THRESHOLD = 0.1;

/**
 * 对账用汇率（1 CNY = ? USD）。
 *
 * 与 `model-registry.ts` 的 `DEEPSEEK_CNY_TO_USD` **刻意保持同一个数**但不共享常量：
 * 对账的意义在于**独立**核对我们的计价，引用被测方的汇率等于用同一个可能错的数
 * 去验证它自己。两处不一致时应当人工判断哪个该改，而不是让它们自动同步。
 */
const CNY_TO_USD = 1 / 7.1;

/**
 * `asOf` 陈旧阈值（天）。超过即**提示**该重新核价。
 *
 * 取 90 天而不是 30：单价的变更频率远低于北极星快照（那个是 30 天）。
 * 卡太紧会让这条提示每周都出现，人就开始忽略它 —— 一个被忽略的提示
 * 等价于没有这个提示，而这正是 §5.6 要避免的形态。
 */
const ASOF_STALE_DAYS = 90;

interface Args {
  bill?: number;
  currency: "CNY" | "USD";
  from?: string;
  to?: string;
  model?: string;
  /** 只跑 asOf 陈旧检查，不读账本（给 hook / CI 用） */
  checkAsOfOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { currency: "USD", checkAsOfOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--bill") out.bill = Number(next());
    else if (a === "--currency") out.currency = (next() ?? "USD").toUpperCase() as Args["currency"];
    else if (a === "--from") out.from = next();
    else if (a === "--to") out.to = next();
    else if (a === "--model") out.model = next();
    else if (a === "--check-asof") out.checkAsOfOnly = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: bun scripts/pricing-reconcile.ts [选项]",
          "  --bill <金额>        官方账单金额（不给则只输出账本侧数字）",
          "  --currency CNY|USD   账单币种，默认 USD",
          "  --from YYYY-MM-DD    区间起（含）",
          "  --to   YYYY-MM-DD    区间止（不含）",
          "  --model <名>         只统计该模型",
          `  --check-asof         只查注册表 asOf 是否超 ${ASOF_STALE_DAYS} 天（只提示，退出码恒 0）`,
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return out;
}

/** 日期字符串 → Unix 秒。非法时返回 undefined（不静默当成 0，那会把全部历史都圈进来）。 */
function toEpochSec(d?: string): number | undefined {
  if (!d) return undefined;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * 注册表 `asOf` 陈旧检查（§5.6 的配套两条之一）。
 *
 * ## 为什么**只提示、不硬拦**（这条是刻意的，不是偷懒）
 *
 * 硬拦会换来一个"每次都红然后被人卸掉"的 hook —— 本仓已经在北极星陈旧检测那里
 * 写下过同一条判据。价格陈旧比那个更不适合硬拦：**核价需要人去官网看**，
 * 一个当下无法自助解决的门禁，唯一的出路就是绕过它。
 *
 * 所以这里的退出码恒为 0，它的作用是**在人已经在看这个脚本输出时**顺带提醒一句。
 *
 * ## 它测的是"多久没核过"，不是"价格对不对"
 *
 * 这两件事必须分开：`asOf` 是**人声称核对过的日期**，脚本无从验证那天核得对不对。
 * 「价格对不对」由本脚本的对账主路径回答（拿账单比账本），
 * `asOf` 只回答「这条价的可信度随时间衰减到什么程度了」。
 *
 * @returns 陈旧的条目数（0 = 全部在期内）
 */
function checkAsOfStaleness(): number {
  const entries = getRegistryEntries();
  const now = Date.now();
  const stale: Array<{ key: string; asOf: string; days: number }> = [];
  let withAsOf = 0;

  for (const [key, entry] of entries) {
    const asOf = entry.pricing?.asOf;
    if (!asOf) continue; // 无 asOf 的条目不报：表里 100+ 条不可能一次补齐，强报会淹掉真信号
    withAsOf += 1;
    const t = Date.parse(`${asOf}T00:00:00Z`);
    if (Number.isNaN(t)) {
      // 日期本身不合法比陈旧更严重（说明有人手写错了），单独列出来
      stale.push({ key, asOf, days: -1 });
      continue;
    }
    const days = Math.floor((now - t) / 86_400_000);
    if (days > ASOF_STALE_DAYS) stale.push({ key, asOf, days });
  }

  console.log(
    `\n单价 as-of 检查：${entries.length} 条模型定价，其中 ${withAsOf} 条带 asOf（阈值 ${ASOF_STALE_DAYS} 天）`,
  );
  if (withAsOf === 0) {
    // 分母为 0 时上面的循环体从不执行 → "0 条陈旧"是个假的好消息，必须点破。
    console.log("  ⚠ 没有任何条目带 asOf —— 本检查此刻等于没跑（不是「全部在期内」）。");
    return 0;
  }
  if (stale.length === 0) {
    console.log(`  ✓ ${withAsOf} 条全部在期内。`);
    return 0;
  }
  console.log(`  ⚠ ${stale.length} 条已陈旧，建议回官方定价页重新核对：`);
  for (const s of stale.sort((a, b) => b.days - a.days)) {
    console.log(
      s.days < 0
        ? `    ${s.key}: asOf="${s.asOf}" 不是合法日期（手写错了）`
        : `    ${s.key}: asOf=${s.asOf}（${s.days} 天前）`,
    );
  }
  console.log(
    "  提示不阻断：核价必须人去官网看，一个当下无法自助解决的门禁只会被绕过\n" +
      "  （与北极星陈旧检测同一条判据）。",
  );
  return stale.length;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.checkAsOfOnly) {
    checkAsOfStaleness();
    process.exit(0); // 恒 0：见 checkAsOfStaleness 的"只提示不硬拦"一节
  }
  const from = toEpochSec(args.from);
  const to = toEpochSec(args.to);
  if (args.from && from === undefined) {
    console.error(`--from 不是合法日期: ${args.from}`);
    process.exit(2);
  }
  if (args.to && to === undefined) {
    console.error(`--to 不是合法日期: ${args.to}`);
    process.exit(2);
  }

  const all = readUsageLedger();
  const rows = all.filter((e) => {
    if (from !== undefined && e.ts < from) return false;
    if (to !== undefined && e.ts >= to) return false;
    if (args.model && e.model !== args.model) return false;
    return true;
  });

  if (rows.length === 0) {
    console.log("账本内无匹配记录（检查 --from/--to/--model，或该区间确实没有会话）");
    process.exit(0);
  }

  // ── 按 (model, endpoint) 分解 ──
  // 分解维度必须含 endpoint：同一模型名经不同网关是**不同的价**，
  // 合并成一行会让"某一个渠道价错了"被其余渠道的正确值稀释掉。
  interface Bucket {
    costUSD: number;
    sideCostUSD: number;
    promptTotal: number;
    output: number;
    sessions: number;
  }
  const buckets = new Map<string, Bucket>();
  let totalMain = 0;
  let totalSide = 0;
  for (const e of rows) {
    const key = `${e.model}@${e.endpointHost ?? "(默认/官方)"}`;
    const b = buckets.get(key) ?? {
      costUSD: 0,
      sideCostUSD: 0,
      promptTotal: 0,
      output: 0,
      sessions: 0,
    };
    // ⚠ 口径：`costUSD` 走 getEffectiveTotalCostUSD()，**已含**影子调用成本；
    // 而 `sideCostUSD` 是其中影子那部分。两者相加会把影子算两遍。
    // 这个坑在 usage-ledger.ts 的字段注释里写着，对账时最容易踩。
    b.costUSD += e.costUSD ?? 0;
    b.sideCostUSD += e.sideCostUSD ?? 0;
    b.promptTotal += e.promptTotal ?? 0;
    b.output += e.output ?? 0;
    b.sessions += 1;
    buckets.set(key, b);
    totalMain += e.costUSD ?? 0;
    totalSide += e.sideCostUSD ?? 0;
  }

  console.log(`\n对账区间: ${args.from ?? "(不限)"} → ${args.to ?? "(不限)"}`);
  console.log(`会话数: ${rows.length}\n`);
  console.log("按 模型@端点 分解:");
  for (const [key, b] of [...buckets.entries()].sort((a, c) => c[1].costUSD - a[1].costUSD)) {
    const sidePct = b.costUSD > 0 ? (b.sideCostUSD / b.costUSD) * 100 : 0;
    console.log(
      `  ${key}\n` +
        `    会话 ${b.sessions}  成本 ${fmtUSD(b.costUSD)}` +
        `（其中影子调用 ${fmtUSD(b.sideCostUSD)} = ${sidePct.toFixed(1)}%）\n` +
        `    prompt ${(b.promptTotal / 1e6).toFixed(2)}M  output ${(b.output / 1e6).toFixed(2)}M`,
    );
  }

  console.log(`\n账本合计（含影子调用）: ${fmtUSD(totalMain)}`);
  console.log(`  其中影子调用: ${fmtUSD(totalSide)}`);

  if (args.bill === undefined || !Number.isFinite(args.bill)) {
    console.log("\n未提供 --bill，跳过偏差判定。");
    process.exit(0);
  }

  const billUSD = args.currency === "CNY" ? args.bill * CNY_TO_USD : args.bill;
  console.log(
    `\n官方账单: ${args.currency === "CNY" ? `¥${args.bill}` : `$${args.bill}`}` +
      (args.currency === "CNY"
        ? ` → ${fmtUSD(billUSD)}（汇率 1/${(1 / CNY_TO_USD).toFixed(2)}）`
        : ""),
  );

  if (billUSD <= 0) {
    console.log("账单金额 ≤ 0，无法算偏差。");
    process.exit(0);
  }
  const ratio = totalMain / billUSD;
  const deviation = Math.abs(ratio - 1);
  console.log(
    `\n我们/官方 = ${ratio.toFixed(4)}（偏差 ${(deviation * 100).toFixed(1)}%，阈值 ${DEVIATION_THRESHOLD * 100}%）`,
  );

  if (deviation > DEVIATION_THRESHOLD) {
    console.error(
      `\n✗ 价格口径失效：偏差 ${(deviation * 100).toFixed(1)}% 超阈值。\n` +
        `  ${ratio < 1 ? "我们低估" : "我们高估"}了 ${(1 / Math.min(ratio, 1 / ratio)).toFixed(2)}×。\n` +
        `  排查顺序（按 2026-08-21 事故的经验，三类成因会叠乘）：\n` +
        `    1. 单价：model-registry.ts 的 asOf 是否过期？币种/时段是否标注？\n` +
        `    2. 漏采：轨迹里 HttpConnected 数 == 计费事件数吗？（判据 1）\n` +
        `    3. 影子调用：上面"其中影子调用"占比是否明显偏低？\n` +
        `  ⚠ 别只查第 1 类 —— 那次三类同时存在，只修单价仍差 1.44×。`,
    );
    process.exit(1);
  }
  console.log("\n✓ 偏差在阈值内。");
  console.log(
    "  注意：这只说明**总额**吻合。方向相反的两个错误可以互相掩护\n" +
      "  （2026-08-11：单价 ×4.94 与用量 ×0.74 抵消成 ×3.63），\n" +
      "  所以单价另有逐项门禁（tests/api/pricing-channel-mismatch.test.ts D 组）。",
  );
  process.exit(0);
}

main();
