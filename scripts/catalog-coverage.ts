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
 *
 * ── 为什么口径逻辑抽成了可导出的纯函数 ─────────────────────────────
 *
 * 上面那两条 ⚠ 说的都是「分母/口径被改坏时曲线会整体平移」，而这个脚本自己曾经
 * **一个测试都没有** —— 它警告过的那种漂移，发生在它自己身上时没有任何东西会报红。
 * 所以分母、命中判据、投票计分三块从顶层语句里抽出来变成纯函数（依赖用参数注入，
 * 不读真实 `~/.sid-code/`、不联网），门禁在 `tests/scripts/catalog-coverage.test.ts`。
 *
 * ⚠ 那道门禁**只保护口径逻辑，不保护数字本身**：数字随上游三个目录的数据天天变，
 * 锁住它只会换来一个每天都红、然后被人改期望值的测试。这是刻意的能力边界。
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

/**
 * 非对话模型的名字判据（启发式，仅用于分母口径）。
 *
 * 为什么按名字判而不是按字段判：分母来自网关的**价格**表，那张表没有 mode / modalities
 * 一类**模态**字段（实测该网关 `/api/pricing` 与 `/v1/models` 两个接口都不提供 —— 这也是
 * 为什么窗口必须靠外部目录，见 gateway-pricing.ts 头部那条否定性结论）。
 *
 * ⚠ 唯一沾边的是 `supported_endpoint_types`（如 `["openai","embeddings"]`），
 * 它现在会被 gateway-pricing.ts 采下来。**刻意不拿它替换这里的名字判据**：它描述的是
 * 「这个端点为该模型开了哪些协议」，不是「这个模型是不是对话模型」——
 * 实测 5 条带 `embeddings` 的条目里就有同时带 `openai` 的，用它当判据会误伤。
 * 真要切换判据，得先拿本机 135 条做一次逐条比对，那是另一件事。
 *
 * 采集侧的过滤是按字段做的（litellm 看 `mode`、models.dev 看 `modalities.output`、
 * OpenRouter 看 `architecture.output_modalities`），与这里不是一套 ——
 * 这里只影响「分母里算不算这个模型」，不影响任何入库数据。
 */
export const NON_CHAT_RE =
  /embedding|rerank|seedream|seedance|tts|whisper|veo-|-image\b|hy-image|realtime/;

export type SourceMap = Record<string, ModelCapabilityEntry[]>;

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

async function loadSource(src: (typeof SOURCES)[number], offline: boolean): Promise<SourceMap> {
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

/** `gateway-pricing.json` 里与分母口径有关的那一小块结构。 */
export interface GatewayPricingFile {
  endpoints?: Record<string, { models?: Record<string, unknown> } | undefined>;
}

/**
 * 网关模型全集（**跨端点桶去重**）—— 覆盖率的分母，本脚本最要紧的一个口径。
 *
 * 三件事都是口径的一部分，改任何一条都会让曲线整体平移：
 *   1. **遍历所有桶**，不是只看第一个（多端点各有独占模型，只读一个桶会少算一批）。
 *   2. **跨桶去重**（同一模型常在多个端点上都有价格，不去重会重复计数）。
 *   3. **小写化**（网关不同桶对同一模型的大小写不一致，不归一会把同一个算成两个）。
 *
 * 传入已解析的文件对象即可（测试喂 fixture）；不传则读本机网关价格缓存。
 */
export function gatewayModels(file?: GatewayPricingFile): string[] {
  if (file === undefined) {
    const path = join(homedir(), ".sid-code", "gateway-pricing.json");
    if (!existsSync(path)) {
      console.error(`⚠ 找不到 ${path} —— 覆盖率的分母来自网关价格缓存，先跑一次 sid-code 采集。`);
      return [];
    }
    file = JSON.parse(readFileSync(path, "utf8")) as GatewayPricingFile;
  }
  const set = new Set<string>();
  for (const bucket of Object.values(file.endpoints ?? {})) {
    for (const name of Object.keys(bucket?.models ?? {})) set.add(name.toLowerCase());
  }
  return [...set].sort();
}

/** 分母对：全量 + 排除非对话模型。读数时必须说清用的是哪个。 */
export function denominators(all: string[]): { all: string[]; chat: string[] } {
  return { all, chat: all.filter((m) => !NON_CHAT_RE.test(m)) };
}

/**
 * 一个模型名能否在给定的若干源里查到。
 *
 * ⚠ **必须走 `normalizeCandidates`**，也就是运行时查缓存用的那一套候选。
 * 改成只比对原样键，算出来的就不再是「运行时能不能查到」，而是另一个更悲观的指标 ——
 * 而 litellm 81.3% 的键都带 `provider/` 前缀，网关暴露的却是裸名，
 * 这个差异大到足以让整条曲线失去意义。
 */
export function hits(model: string, maps: SourceMap[]): boolean {
  return normalizeCandidates(model).some((c) => maps.some((m) => c in m));
}

/** 一个源组合在两个分母上的命中数。 */
export function coverageOf(
  ms: SourceMap[],
  denom: { all: string[]; chat: string[] },
): { all: number; chat: number } {
  return {
    all: denom.all.filter((m) => hits(m, ms)).length,
    chat: denom.chat.filter((m) => hits(m, ms)).length,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

// ── 投票准确率：以内置注册表（90 条手写，精度高于第三方）为真值 ──
// 只统计「有 ≥2 个候选值」的模型 —— 单值无从投票，算进去会稀释掉规则之间的差异。
//
// ⚠ 两个字段都要算。maxOutputTokens 那条不是补充指标，是**加源时的必要门禁**：
// 实测加第三个源后，output 取 max 的正确率从 60.0% 掉到 31.3%（有些源把 context 值填进了
// output 字段，provider 一多取 max 几乎必然捞到那条）。只看 contextWindow 会漏掉这个回归。
export type Field = "contextWindow" | "maxOutputTokens";

/** 真值表：内置注册表里该字段有正整数值的条目（键小写）。 */
export function truthOf(field: Field): Map<string, number> {
  const m = new Map<string, number>();
  for (const [key, entry] of getRegistryEntries()) {
    const v = entry[field];
    if (typeof v === "number" && v > 0) m.set(key.toLowerCase(), v);
  }
  return m;
}

export function aggregate(ms: SourceMap[], field: Field): Record<string, number[]> {
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

export const RULES: Array<[string, (v: number[]) => number | undefined]> = [
  // 旧规则，留作对照。窗口那边是 min（「保守=安全」直觉的产物，实测系统性低估）；
  // 输出上限那边是 max。两条都被实测推翻，都换成了众数。
  ["min（旧·窗口）", (v) => Math.min(...v)],
  ["max（旧·输出）", (v) => Math.max(...v)],
  ["众数（现）", voteTokenLimit],
];

/** 5% 容差：源之间对同一模型常有 1M vs 1.048M 之类的口径差，那不是判错。 */
export const TOLERANCE = 0.05;

/** 一条「某字段 × 某源组合 × 某规则」的计分结果。 */
export interface AccuracyRow {
  field: Field;
  sources: string;
  rule: string;
  n: number;
  ok: number;
  under: number;
  over: number;
}

/**
 * 给一个规则在一批候选值上打分（口径的三个组成部分都在这里，改任何一个都换指标）：
 *
 *   1. **分母 n = 有 ≥2 个候选值的真值条目数**。单值无从投票，算进去会稀释规则间差异。
 *   2. **`maxOutputTokens` 必须带「不超过窗口」的钳制** —— 运行时投完票还有这一道，
 *      不带钳制算出来的数字与线上不符，那就不是复算，是另算一个指标。
 *   3. **5% 容差**（`TOLERANCE`），且低估/高估的分界同样按 `t * (1 - TOLERANCE)` 走。
 */
export function scoreRule(
  fn: (v: number[]) => number | undefined,
  agg: Record<string, number[]>,
  truth: Map<string, number>,
  /** `maxOutputTokens` 时传入窗口候选，用于钳制；`contextWindow` 时传 null。 */
  windows: Record<string, number[]> | null,
  /**
   * 容差，默认 `TOLERANCE`。**做成参数只为了让「ok 带宽与 under/over 分界必须同一个数」
   * 这条耦合可测** —— 写死 `0.95` 与写 `1 - TOLERANCE` 在 0.05 上完全等价，
   * 不给容差换个值就没有任何断言能区分它们，那条耦合就成了一句无人守的注释。
   */
  tolerance: number = TOLERANCE,
): { n: number; ok: number; under: number; over: number } {
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
    if (Math.abs(got - t) / t <= tolerance) ok++;
    else if (got < t * (1 - tolerance)) under++;
    else over++;
  }
  return { n: rows.length, ok, under, over };
}

/** 两个字段 × 给定源组合 × 三条规则的完整计分表。 */
export function voteAccuracy(comboList: Array<[string, SourceMap[]]>): AccuracyRow[] {
  const out: AccuracyRow[] = [];
  for (const field of ["contextWindow", "maxOutputTokens"] as Field[]) {
    const truth = truthOf(field);
    for (const [label, ms] of comboList) {
      const agg = aggregate(ms, field);
      const windows = field === "maxOutputTokens" ? aggregate(ms, "contextWindow") : null;
      for (const [rule, fn] of RULES) {
        out.push({ field, sources: label, rule, ...scoreRule(fn, agg, truth, windows) });
      }
    }
  }
  return out;
}

// ── 顶层执行：只有直接跑脚本时才联网 + 读本机网关缓存 + 打印 ──
// 被 import 时（测试）不产生任何副作用，参见 scripts/affected-tests.ts 同款做法。
if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const showGaps = args.includes("--gaps");
  const offline = args.includes("--offline");

  const maps: Record<string, SourceMap> = {};
  for (const src of SOURCES) maps[src.name] = await loadSource(src, offline);

  const { all, chat } = denominators(gatewayModels());
  const threeSources = [maps["models.dev"]!, maps.litellm!, maps.openrouter!];

  const coverage = (
    [
      ["litellm", [maps.litellm!]],
      ["openrouter", [maps.openrouter!]],
      ["旧两源并集", [maps.litellm!, maps.openrouter!]],
      ["models.dev", [maps["models.dev"]!]],
      ["三源并集", threeSources],
    ] as Array<[string, SourceMap[]]>
  ).map(([label, ms]) => ({ label, ...coverageOf(ms, { all, chat }) }));

  const gaps = chat.filter((m) => !hits(m, threeSources));

  const accuracy = voteAccuracy([
    ["旧两源", [maps.litellm!, maps.openrouter!]],
    ["三源", threeSources],
  ]);

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
}
