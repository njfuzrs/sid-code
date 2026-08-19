#!/usr/bin/env bun
/**
 * catalog-coverage —— 模型元数据「覆盖率 + 投票准确率」主口径复算脚本
 *
 * ── 为什么需要一个脚本，而不是在注释里写个数字 ──────────────────────
 *
 * `model-capabilities.ts` 的模块注释曾经写着「覆盖公司网关 127 个模型中的 93 个（73%）」。
 * 网关后来新上了模型，分母从 127 涨到 136，注释没跟着动 —— 于是那行字从「实测结论」
 * 退化成了「一句让人放心的话」，而**正是因为它说「73%，还不错」，选源问题才一直没被复查**。
 * 实际情况是 litellm/OpenRouter 对国内厂商系统性偏弱，漏掉 glm-5.3 与整批 doubao。
 *
 * 所以这个脚本存在的意义不是「算得更准」，是**把这条曲线变成可复算的**：
 * 任何人任何时候都能跑出当天的数字，注释里只留日期 + 指向这个脚本。
 *
 * ── 两个口径（都是本次修复的验收判据）─────────────────────────────
 *
 * 1. **覆盖率**：网关上的模型，有多少能在外部目录里查到能力数据。
 * 2. **投票准确率**：多源分歧时，投票规则选出的值与内置注册表真值的一致率。
 *    这一条是 min → 众数那次修复的唯一证明：同一批数据、同一个分母，只换投票函数。
 *
 * ⚠ **分母必须和指标一起写死**（CLAUDE.md 铁律之三：分母比分子重要）：
 *   分母 = `~/.sid-code/gateway-pricing.json` 里**跨端点桶去重**的模型名集合。
 *   换成「单个桶」或「不排除非对话模型」，这条曲线会整体平移，跨版本就没法比。
 *   脚本同时输出全量与「排除非对话模型」两个分母，读数时必须说清用的是哪个。
 *
 * ⚠ 覆盖率的分母来自**本机**的网关缓存，所以它是「我们这个网关的覆盖率」，
 *   不是一个可跨机器比较的绝对指标。跨版本比较时必须是同一台机器/同一份网关缓存。
 *
 * 用法：
 *   bun scripts/catalog-coverage.ts              # 覆盖率 + 投票准确率
 *   bun scripts/catalog-coverage.ts --json       # 机器可读
 *   bun scripts/catalog-coverage.ts --gaps       # 额外列出真实缺口（三源都没有的模型）
 *   bun scripts/catalog-coverage.ts --offline    # 只用 /tmp 下已下载的快照，不联网
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  voteTokenLimit,
  __parsersForTest,
  type ModelCapabilityEntry,
} from "@sid-code/core/llm/model-capabilities.ts";
import { normalizeCandidates } from "@sid-code/core/llm/model-name-normalize.ts";
import { getRegistryEntries } from "@sid-code/core/llm/model-registry.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showGaps = args.includes("--gaps");
const offline = args.includes("--offline");

/**
 * 非对话模型的名字判据（启发式，仅用于分母口径）。
 *
 * 为什么按名字判而不是按字段判：分母来自网关的**价格**表，那张表没有 mode / modalities
 * 一类能力字段（实测该网关 `/api/pricing` 与 `/v1/models` 两个接口都不提供）。
 * 采集侧的过滤是按字段做的（litellm 看 `mode`、models.dev 看 `modalities.output`），
 * 与这里不是一套 —— 这里只影响「分母里算不算这个模型」，不影响任何入库数据。
 */
const NON_CHAT_RE =
  /embedding|rerank|seedream|seedance|tts|whisper|veo-|-image\b|hy-image|realtime/;

type SourceMap = Record<string, ModelCapabilityEntry[]>;

const SOURCES = [
  {
    name: "models.dev",
    url: "https://models.opencode.ai/api.json",
    cache: "/tmp/catalog-coverage-models-dev.json",
    parse: __parsersForTest.modelsDev,
  },
  {
    name: "litellm",
    url: "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/litellm/model_prices_and_context_window_backup.json",
    cache: "/tmp/catalog-coverage-litellm.json",
    parse: __parsersForTest.litellm,
  },
  {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    cache: "/tmp/catalog-coverage-openrouter.json",
    parse: __parsersForTest.openrouter,
  },
] as const;

async function loadSource(src: (typeof SOURCES)[number]): Promise<SourceMap> {
  if (offline || existsSync(src.cache)) {
    if (!existsSync(src.cache)) {
      console.error(`⚠ --offline 但 ${src.cache} 不存在，跳过 ${src.name}`);
      return {};
    }
    return src.parse(JSON.parse(readFileSync(src.cache, "utf8")));
  }
  const resp = await fetch(src.url);
  if (!resp.ok) {
    console.error(`⚠ ${src.name} HTTP ${resp.status}，跳过`);
    return {};
  }
  const text = await resp.text();
  await Bun.write(src.cache, text); // 落一份快照，供 --offline 复算同一批数据
  return src.parse(JSON.parse(text));
}

/** 网关模型全集（跨端点桶去重）。 */
function gatewayModels(): string[] {
  const path = join(homedir(), ".sid-code", "gateway-pricing.json");
  if (!existsSync(path)) {
    console.error(`⚠ 找不到 ${path} —— 覆盖率的分母来自网关价格缓存，先跑一次 sid-code 采集。`);
    return [];
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as {
    endpoints?: Record<string, { models?: Record<string, unknown> }>;
  };
  const set = new Set<string>();
  for (const bucket of Object.values(file.endpoints ?? {})) {
    for (const name of Object.keys(bucket.models ?? {})) set.add(name.toLowerCase());
  }
  return [...set].sort();
}

/** 一个模型名能否在给定的若干源里查到（走与运行时相同的归一化候选）。 */
function hits(model: string, maps: SourceMap[]): boolean {
  return normalizeCandidates(model).some((c) => maps.some((m) => c in m));
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

const maps: Record<string, SourceMap> = {};
for (const src of SOURCES) maps[src.name] = await loadSource(src);

const all = gatewayModels();
const chat = all.filter((m) => !NON_CHAT_RE.test(m));

const combos: Array<[string, SourceMap[]]> = [
  ["litellm", [maps.litellm!]],
  ["openrouter", [maps.openrouter!]],
  ["旧两源并集", [maps.litellm!, maps.openrouter!]],
  ["models.dev", [maps["models.dev"]!]],
  ["三源并集", [maps["models.dev"]!, maps.litellm!, maps.openrouter!]],
];

const coverage = combos.map(([label, ms]) => ({
  label,
  all: all.filter((m) => hits(m, ms)).length,
  chat: chat.filter((m) => hits(m, ms)).length,
}));

const gaps = chat.filter((m) => !hits(m, [maps["models.dev"]!, maps.litellm!, maps.openrouter!]));

// ── 投票准确率：以内置注册表（90 条手写，精度高于第三方）为真值 ──
// 只统计「有 ≥2 个候选值」的模型 —— 单值无从投票，算进去会稀释掉规则之间的差异。
//
// ⚠ 两个字段都要算。maxOutputTokens 那条不是补充指标，是**加源时的必要门禁**：
// 实测加第三个源后，output 取 max 的正确率从 60.0% 掉到 31.3%（有些源把 context 值填进了
// output 字段，provider 一多取 max 几乎必然捞到那条）。只看 contextWindow 会漏掉这个回归。
type Field = "contextWindow" | "maxOutputTokens";

function truthOf(field: Field): Map<string, number> {
  const m = new Map<string, number>();
  for (const [key, entry] of getRegistryEntries()) {
    const v = entry[field];
    if (typeof v === "number" && v > 0) m.set(key.toLowerCase(), v);
  }
  return m;
}

function aggregate(ms: SourceMap[], field: Field): Record<string, number[]> {
  const agg: Record<string, number[]> = {};
  for (const m of ms) {
    for (const [key, entries] of Object.entries(m)) {
      for (const e of entries) {
        const v = e[field];
        if (typeof v === "number") (agg[key] ??= []).push(v);
      }
    }
  }
  return agg;
}

const RULES: Array<[string, (v: number[]) => number | undefined]> = [
  // 旧规则，留作对照。窗口那边是 min（「保守=安全」直觉的产物，实测系统性低估）；
  // 输出上限那边是 max。两条都被实测推翻，都换成了众数。
  ["min（旧·窗口）", (v) => Math.min(...v)],
  ["max（旧·输出）", (v) => Math.max(...v)],
  ["众数（现）", voteTokenLimit],
];

const accuracy: Array<{
  field: Field;
  sources: string;
  rule: string;
  n: number;
  ok: number;
  under: number;
  over: number;
}> = [];
for (const field of ["contextWindow", "maxOutputTokens"] as Field[]) {
  const truth = truthOf(field);
  for (const [label, ms] of [
    ["旧两源", [maps.litellm!, maps.openrouter!]],
    ["三源", [maps["models.dev"]!, maps.litellm!, maps.openrouter!]],
  ] as Array<[string, SourceMap[]]>) {
    const agg = aggregate(ms, field);
    // 输出上限要按运行时的实际行为算 —— 它在投票之后还有一道「不超过窗口」的钳制。
    // 不带钳制算出来的数字与线上不符，那就不是复算，是另算一个指标。
    const windows = field === "maxOutputTokens" ? aggregate(ms, "contextWindow") : null;
    for (const [rule, fn] of RULES) {
      const rows = [...truth].filter(([k]) => (agg[k] ?? []).length >= 2);
      let ok = 0;
      let under = 0;
      let over = 0;
      for (const [k, t] of rows) {
        let got = fn(agg[k]!);
        if (got === undefined) continue;
        if (windows) {
          const w = voteTokenLimit(windows[k] ?? []);
          if (w !== undefined) got = Math.min(got, w);
        }
        // 5% 容差：源之间对同一模型常有 1M vs 1.048M 之类的口径差，那不是判错。
        if (Math.abs(got - t) / t <= 0.05) ok++;
        else if (got < t * 0.95) under++;
        else over++;
      }
      accuracy.push({ field, sources: label, rule, n: rows.length, ok, under, over });
    }
  }
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        denominator: {
          all: all.length,
          chat: chat.length,
          source: "gateway-pricing.json 跨桶去重",
        },
        coverage,
        gaps,
        vote_accuracy: accuracy,
      },
      null,
      2,
    ),
  );
} else {
  console.log("── 覆盖率 ────────────────────────────────────────────");
  console.log(
    `分母（gateway-pricing.json 跨桶去重）：全量 ${all.length} / 对话模型 ${chat.length}`,
  );
  for (const c of coverage) {
    console.log(
      `  ${c.label.padEnd(12)} 全量 ${String(c.all).padStart(3)}/${all.length} (${pct(c.all, all.length).padStart(6)})` +
        `   对话 ${String(c.chat).padStart(3)}/${chat.length} (${pct(c.chat, chat.length).padStart(6)})`,
    );
  }

  console.log("\n── 投票准确率（真值 = 内置注册表，仅统计有 ≥2 候选值的模型）──");
  let lastField = "";
  for (const a of accuracy) {
    if (a.field !== lastField) {
      lastField = a.field;
      const note = a.field === "maxOutputTokens" ? "（已含「不超过窗口」钳制）" : "";
      console.log(`  [${a.field}]${note}`);
    }
    console.log(
      `    ${a.sources.padEnd(6)} ${a.rule.padEnd(14)} n=${String(a.n).padStart(3)}` +
        `  一致 ${String(a.ok).padStart(3)} (${pct(a.ok, a.n).padStart(6)})  低估 ${a.under}  高估 ${a.over}`,
    );
  }

  console.log(`\n── 真实缺口（三源 + 归一化后仍查不到的对话模型）：${gaps.length} 个 ──`);
  if (showGaps) for (const g of gaps) console.log(`  ${g}`);
  else console.log("  （加 --gaps 列出明细）");
}
