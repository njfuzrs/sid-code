#!/usr/bin/env bun
/**
 * cache-bench.ts —— 受控缓存实测（P1-1 / T3）
 *
 * **这是"命中率能到 X%"这类说法的唯一合法来源。** 账本里的跨会话命中率混了太多变量
 *（模型、渠道、会话长短、compact 次数），拿它当"缓存实现好不好"的证据是不成立的；
 * 反过来单次 curl 的命中率又太理想（没有真实会话的前缀扰动）。所以要一个中间物：
 * 固定静态前缀 + 每轮追加真实增量，跑 N 轮，看**逐轮命中率曲线**。
 *
 * 用法：
 *   bun scripts/cache-bench.ts --model glm-5.2                  # 单模型 8 轮（默认）
 *   bun scripts/cache-bench.ts --model glm-5.2 --rounds 12
 *   bun scripts/cache-bench.ts --model a,b,c                    # 多模型对照（成本更高）
 *   bun scripts/cache-bench.ts --model glm-5.2 --json
 *   bun scripts/cache-bench.ts --list
 *
 * 成本护栏（与 provider-canary / cache-trust-probe 同口径）：
 *   - 默认**单模型少轮**（8 轮），多模型要显式逗号传参
 *   - max_tokens ≤ 32（只要 usage，不要模型真的说什么）
 *   - 单次运行硬上限 $0.50，每轮前检查，超了立即中止并报告已花费
 *
 * ⚠️ 与探针同理：脚本在 import 业务模块**之前**自设 SID_CODE_USAGE_LEDGER /
 * SID_CODE_CACHE_BREAKS 到临时目录 —— 否则实测请求会灌进真实账本，
 * 而账本正是本轮要保证干净的度量底座。
 */

import { parseArgs } from "node:util";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 隔离必须先于任何业务 import（模块加载时就会解析路径）
const benchTmp = mkdtempSync(join(tmpdir(), "cache-bench-"));
process.env.SID_CODE_USAGE_LEDGER = join(benchTmp, "usage-ledger.jsonl");
process.env.SID_CODE_CACHE_BREAKS = join(benchTmp, "cache-breaks.jsonl");

const { loadConfig } = await import("@sid-code/core/config/config.ts");

/** 单次运行硬上限（美元） */
const COST_CEILING_USD = 0.5;
const MAX_TOKENS = 32;
const DEFAULT_ROUNDS = 8;
/** 静态前缀长度（token 估算）。必须超过各家最小可缓存长度（1024），否则缓存不生效。 */
const STATIC_PREFIX_TOKENS = 2000;

const { values } = parseArgs({
  options: {
    model: { type: "string", short: "m" },
    rounds: { type: "string", short: "r" },
    json: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`cache-bench.ts —— 受控缓存实测（逐轮命中率曲线）

  --model <a[,b]>  模型（逗号分隔可多模型对照；默认单模型以控成本）
  --rounds <n>     轮数，默认 ${DEFAULT_ROUNDS}
  --json           只输出 JSON
  --list           列出可用模型
  -h, --help       本帮助

成本护栏：默认单模型 ${DEFAULT_ROUNDS} 轮，max_tokens=${MAX_TOKENS}，硬上限 $${COST_CEILING_USD}。
自设 SID_CODE_USAGE_LEDGER/CACHE_BREAKS 到临时目录，不污染真实账本。`);
  process.exit(0);
}

// 类型从 core 引入而**不在这里重新声明**：第一版两边各写了一份 RoundResult，
// core 加 cacheWrite 字段后本文件的副本没跟上，渲染代码就访问了一个"类型上不存在"的字段。
// 手写的平行类型声明必然漂移（同病：记忆 message-fidelity-silent-block-drop）。
type ModelBench = import("@sid-code/core/telemetry/cache-bench-core.ts").ModelBench;

/** 固定静态前缀：模拟真实 system prompt（跨轮完全不变，这是可缓存的部分） */
function staticPrefix(): string {
  const unit = "你是一个严谨的工程助手。回答必须基于事实，不确定时明说不确定。";
  return unit.repeat(Math.ceil((STATIC_PREFIX_TOKENS * 2) / unit.length));
}

/**
 * 每轮的真实增量：模拟会话推进（追加一轮问答）。
 *
 * 刻意只在**尾部**追加、不动前缀 —— 这是"缓存本该完整命中"的理想形态。
 * 若这种形态下命中率都上不去，问题在协议/渠道；若这里很高而账本很低，
 * 问题就在真实会话的前缀扰动（P1-2 的 prefix_break 埋点正是量这个的）。
 */
function turnMessages(round: number): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = [];
  for (let i = 1; i <= round; i++) {
    msgs.push({ role: "user", content: `第 ${i} 轮问题：请只回复 ok。` });
    if (i < round) msgs.push({ role: "assistant", content: "ok" });
  }
  return msgs;
}

async function main(): Promise<void> {
  const config = await loadConfig({});
  const available = config.availableModels ?? [];

  if (values.list) {
    for (const m of available) {
      console.log(`  ${m.name.padEnd(28)} provider=${m.provider ?? config.provider ?? "?"}`);
    }
    return;
  }

  if (!values.model) {
    console.error("必须指定 --model（用 --list 看可选项）。");
    process.exitCode = 2;
    return;
  }

  const names = values.model.split(",").map((s) => s.trim()).filter(Boolean);
  const rounds = Math.max(2, Number(values.rounds) || DEFAULT_ROUNDS);
  const prefix = staticPrefix();

  const { benchModel } = await import("@sid-code/core/telemetry/cache-bench-core.ts");
  const results: ModelBench[] = [];
  let spentTotal = 0;

  for (const name of names) {
    const mc = available.find((m) => m.name === name);
    if (!mc) {
      console.error(`模型 "${name}" 不在 availableModels 中，跳过。`);
      continue;
    }
    // 预算是**全脚本共享**的：多模型对照时前一个模型花掉的要计入
    const remaining = COST_CEILING_USD - spentTotal;
    if (remaining <= 0) {
      console.error(`预算已耗尽（$${spentTotal.toFixed(4)}），剩余模型未跑。`);
      break;
    }
    const r = await benchModel({
      config,
      modelConfig: mc,
      provider: mc.provider ?? config.provider ?? "openai",
      baseURL: mc.baseURL ?? config.baseURL,
      rounds,
      prefix,
      turnMessages,
      maxTokens: MAX_TOKENS,
      costCeilingUSD: remaining,
      log: values.json ? () => {} : (m: string) => process.stderr.write(m + "\n"),
    });
    spentTotal += r.spentUSD;
    results.push(r);
  }

  if (values.json) {
    console.log(JSON.stringify({ results, spentUSD: spentTotal, ceilingUSD: COST_CEILING_USD }, null, 2));
  } else {
    printHuman(results, spentTotal);
  }
}

function printHuman(results: ModelBench[], spentTotal: number): void {
  for (const r of results) {
    console.log(`\n━━━ ${r.model} @ ${r.host ?? "(默认端点)"}（${r.provider}）━━━`);
    console.log("  轮次  完整输入   命中     写入    命中率");
    for (const x of r.rounds) {
      console.log(
        `  r${String(x.round).padEnd(4)} ${String(x.promptTotal).padStart(8)} ${String(x.cacheHit).padStart(8)}` +
          ` ${String(x.cacheWrite).padStart(8)}   ${(x.hitRate * 100).toFixed(1)}%`,
      );
    }
    // 写入列不是装饰：hit 恒 0 有两种相反成因（什么都没缓存 / 每轮重新写入），
    // 只看命中列会把后者误判成"渠道不支持缓存"（实跑 anthropic 通道踩过）。
    if (r.rounds.length >= 2 && r.rounds.slice(1).every((x) => x.cacheHit === 0 && x.cacheWrite > 0)) {
      console.log("  ⚠ 命中恒 0 但每轮都在写入 → 缓存可用，但前缀每轮都变（查断点位置/尾部增量是否进了缓存键）");
    }
    // r1 必然 0（服务端没见过前缀），把它算进去会系统性拉低结论 ——
    // 所以稳态口径排除 r1，同时也给全轮口径便于与账本对照。
    console.log(
      `  稳态命中率(排除 r1) ${r.steadyStateHitRate === null ? "N/A" : (r.steadyStateHitRate * 100).toFixed(1) + "%"}` +
        `   全轮 ${r.overallHitRate === null ? "N/A" : (r.overallHitRate * 100).toFixed(1) + "%"}` +
        `   花费 $${r.spentUSD.toFixed(4)}`,
    );
    if (r.aborted) console.log(`  ⚠ 提前中止：${r.aborted}`);
  }
  console.log(`\n总花费 $${spentTotal.toFixed(4)}（上限 $${COST_CEILING_USD}）`);
}

await main();
