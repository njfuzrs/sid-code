#!/usr/bin/env bun
/**
 * cache-trust-probe.ts —— 渠道 usage 可信度探针（T2 / P0-4）
 *
 * 回答一个在做任何缓存度量之前就必须先回答的问题：**这个渠道上报的 usage 是真的吗？**
 *
 * 实测某月卡网关（code.ppchat.vip）的 Anthropic usage 是编造的 —— 把它的"命中"混进
 * 总命中率，会让"我们的缓存做得很好"这个结论建立在假数据上。而同款判据下公司网关
 * （uniapi）行为完全正确，说明不是判据太严，是渠道在造数。
 *
 * 四重判据（任一命中即 untrusted）：
 *   A · 新前缀   用 nonce 生成服务端必然从未见过的长前缀，r1 就报 cache_read > 0
 *   B · 无断点   完全不打 cache_control，仍报 cache_read > 0
 *   C · 稳定性   同一前缀连发 N 次，三段随机跳动而**总和恒定**（固定总数随机三等分）
 *   D · 单调性   同一前缀连发，命中值无规律上下抖动（真实缓存应稳定或单调递增）
 *
 * 判据 A/B 是"逻辑上不可能"，单次命中即定罪；C/D 是统计特征，需要多轮样本。
 *
 * 用法：
 *   bun scripts/cache-trust-probe.ts --model claude-sonnet-5          # 探测某个已配置模型
 *   bun scripts/cache-trust-probe.ts --model x --rounds 5             # 自定义 C/D 判据轮数
 *   bun scripts/cache-trust-probe.ts --model x --json                 # 只输出 JSON
 *   bun scripts/cache-trust-probe.ts --model x --write                # 判定写入 channel-trust.json
 *   bun scripts/cache-trust-probe.ts --list                           # 列出可探测的模型
 *
 * 成本护栏（对标 scripts/provider-canary.ts）：
 *   - max_tokens ≤ 32（只需要 usage，不需要模型真的说什么）
 *   - 单次运行硬上限 $0.50，预算耗尽立即中止并报告已花费
 *
 * ⚠️ 探针请求会进埋点。脚本**自己**把 SID_CODE_USAGE_LEDGER / SID_CODE_CACHE_BREAKS
 * 指向临时文件，绝不污染真实账本 —— 否则探针本身会成为脏数据源，这正是本轮要根治的病。
 */

import { parseArgs } from "node:util";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ─── 隔离必须在任何业务模块 import 之前生效 ───
// 业务模块在**模块加载时**可能就解析路径，import 之后再设环境变量已经晚了。
const probeTmp = mkdtempSync(join(tmpdir(), "cache-trust-probe-"));
process.env.SID_CODE_USAGE_LEDGER = join(probeTmp, "usage-ledger.jsonl");
process.env.SID_CODE_CACHE_BREAKS = join(probeTmp, "cache-breaks.jsonl");

const { loadConfig } = await import("../src/config/config.ts");
const { channelTrustPath } = await import("../src/telemetry/channel-trust.ts");
type ChannelTrustVerdict = import("../src/telemetry/channel-trust.ts").ChannelTrustVerdict;
type ChannelTrustRegistry = import("../src/telemetry/channel-trust.ts").ChannelTrustRegistry;

// ─── 成本护栏 ───

/** 单次运行硬上限（美元）。超出立即中止，不再发请求。 */
const COST_CEILING_USD = 0.5;
/** 只取 usage，不需要模型真的生成内容 */
const MAX_TOKENS = 32;
/** C/D 判据默认轮数 */
const DEFAULT_ROUNDS = 5;
/**
 * 前缀长度（token 估算）。必须 ≥1024：各家前缀缓存都有最小可缓存长度
 *（OpenAI 1024、Anthropic 1024/2048 视模型），短于此真实缓存根本不会生效，
 * 那时"没命中"是正常的，判据会失去区分力。
 */
const PREFIX_MIN_TOKENS = 1200;

const { values } = parseArgs({
  options: {
    model: { type: "string", short: "m" },
    rounds: { type: "string", short: "r" },
    json: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`cache-trust-probe.ts —— 渠道 usage 可信度探针

  --model <name>   要探测的模型（须在 settings 的 availableModels 中）
  --rounds <n>     C/D 判据轮数，默认 ${DEFAULT_ROUNDS}
  --json           只输出 JSON 结果
  --write          把判定写入 ~/.sid-code/channel-trust.json
  --list           列出可探测的模型与其端点
  -h, --help       本帮助

成本护栏：max_tokens=${MAX_TOKENS}，单次运行硬上限 $${COST_CEILING_USD}。
探针自设 SID_CODE_USAGE_LEDGER/CACHE_BREAKS 到临时目录，不污染真实账本。`);
  process.exit(0);
}

/** 一次请求观测到的三段 usage */
interface UsageSample {
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** 三段之和 —— 判据 C 的核心观测量 */
  sum: number;
  costUSD: number;
}

/** 生成一个服务端必然从未见过的长前缀 */
function freshPrefix(nonce: string): string {
  // 用 nonce 贯穿全文，确保任意两次运行的前缀都不同（否则第二次运行会真的命中）
  const unit = `[nonce:${nonce}] 这是一段用于缓存探测的填充文本，不含任何指令。`;
  // 粗估 1 token ≈ 2 中文字符，留足余量
  const repeats = Math.ceil((PREFIX_MIN_TOKENS * 2) / unit.length) + 1;
  return unit.repeat(repeats);
}

async function main(): Promise<void> {
  const config = await loadConfig({});
  const models = config.availableModels ?? [];

  if (values.list) {
    if (models.length === 0) {
      console.log("settings 里没有 availableModels，无可探测目标。");
      return;
    }
    for (const m of models) {
      const host = hostOf(m.baseURL ?? config.baseURL);
      console.log(`  ${m.name.padEnd(28)} provider=${(m.provider ?? config.provider ?? "?").padEnd(10)} host=${host ?? "(默认)"}`);
    }
    return;
  }

  if (!values.model) {
    console.error("必须指定 --model（用 --list 看可选项）。");
    process.exitCode = 2;
    return;
  }

  const mc = models.find((m) => m.name === values.model);
  if (!mc) {
    console.error(`模型 "${values.model}" 不在 availableModels 中。用 --list 看可选项。`);
    process.exitCode = 2;
    return;
  }

  const baseURL = mc.baseURL ?? config.baseURL;
  const host = hostOf(baseURL);
  if (!host) {
    console.error(`模型 "${values.model}" 没有可解析的 baseURL host，无法按渠道判定。`);
    process.exitCode = 2;
    return;
  }

  const rounds = Math.max(2, Number(values.rounds) || DEFAULT_ROUNDS);
  const provider = mc.provider ?? config.provider ?? "openai";
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { runProbe } = await import("../src/telemetry/cache-trust-probe-core.ts");
  const result = await runProbe({
    config,
    modelConfig: mc,
    provider,
    baseURL,
    host,
    rounds,
    nonce,
    prefix: freshPrefix(nonce),
    // 判据 B 必须用另一个全新前缀：cache_control 只控制"写"、读是自动的，
    // 复用判据 A 的前缀会读到 A 刚写进去的缓存 → 正常网关被误判造数（实跑踩过）
    prefixForB: freshPrefix(`${nonce}-b`),
    maxTokens: MAX_TOKENS,
    costCeilingUSD: COST_CEILING_USD,
    log: values.json ? () => {} : (m: string) => process.stderr.write(m + "\n"),
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (values.write) {
    writeVerdict(result.verdict);
    if (!values.json) console.log(`\n判定已写入 ${channelTrustPath()}`);
  }
}

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function printHuman(r: {
  verdict: ChannelTrustVerdict;
  samples: { label: string; usage: UsageSample }[];
  spentUSD: number;
  aborted?: string;
}): void {
  console.log(`━━━ 渠道可信度探针：${r.verdict.host} / ${r.verdict.model ?? "?"} ━━━\n`);
  for (const s of r.samples) {
    const u = s.usage;
    console.log(
      `  ${s.label.padEnd(22)} in=${String(u.inputTokens).padStart(6)} ` +
        `read=${String(u.cacheRead).padStart(6)} create=${String(u.cacheWrite).padStart(6)} ` +
        `sum=${String(u.sum).padStart(6)}`,
    );
  }
  console.log("");
  const tag = r.verdict.verdict === "untrusted" ? "⚠ 不可信" : r.verdict.verdict === "trusted" ? "✓ 可信" : "? 未知";
  console.log(`  判定：${tag}`);
  if (r.verdict.failedCriteria?.length) {
    console.log(`  命中判据：${r.verdict.failedCriteria.join(", ")}`);
  }
  if (r.verdict.reason) console.log(`  理由：${r.verdict.reason}`);
  console.log(`  花费：$${r.spentUSD.toFixed(4)}（上限 $${COST_CEILING_USD}）`);
  if (r.aborted) console.log(`  ⚠ 提前中止：${r.aborted}`);
}

/** 合并写入登记表（保留其它渠道的既有判定，不整体覆盖） */
function writeVerdict(v: ChannelTrustVerdict): void {
  const path = channelTrustPath();
  let reg: ChannelTrustRegistry = { channels: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ChannelTrustRegistry;
      if (parsed?.channels) reg = parsed;
    } catch {
      // 损坏就从空表重建，但不静默 —— 让用户知道旧判定丢了
      process.stderr.write(`⚠ ${path} 解析失败，将重建（旧判定丢失）\n`);
    }
  }
  reg.channels[v.host] = v;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2) + "\n", "utf-8");
}

await main();
