/**
 * wire-model 消费点缺口回归 —— 二次校验（2026-08-07）抓出的 5 处漏改。
 *
 * 背景：`d69e0d9a` 拆分别名/真名时定了归属规则「问『哪一条配置』用别名 name，
 * 问『这到底是什么模型』用真名 modelId」，但规则没有被一致执行到底——5 个消费点
 * 漏改或反着来。本文件按「错了会怎样」把每条钉死。
 *
 * ## 为什么必须用**前缀式**别名做判据（gw-xxx 而不是 xxx-gateway）
 *
 * `lookupRegistry` 有最长前缀匹配（model-registry.ts:255），所以**后缀式**别名
 * （`claude-sonnet-4-6-gateway`）会被前缀匹配意外救回、看起来一切正常——
 * 用它当判据会得到假通过。只有前缀式别名才真正 miss，是唯一能暴露缺陷的形状。
 * 这也是这 5 处缺陷此前能躲过 8000+ 单测的原因。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveWireModel,
  buildWireModelAliasMap,
  exportWireModelAliases,
  setWireModelAliases,
  setWireModelAliasesFromMap,
  lookupWireModelAlias,
  resetWireModelAliases,
} from "@sid-code/core/llm/wire-model.ts";
import { lookupRegistry } from "@sid-code/core/llm/model-registry.ts";
import { resolvePricing, calculateUSDCost } from "@sid-code/core/api/cost-tracker.ts";

/** 注册表里确实存在的真名（若它被下线，本文件的前提就失效——断言会直接告诉你） */
const REAL = "claude-sonnet-4-6";
/** 前缀式别名：注册表前缀匹配救不回来，是唯一能暴露缺陷的形状 */
const ALIAS = `gw-${REAL}`;
const MODELS = [{ name: ALIAS, modelId: REAL }];

beforeEach(() => resetWireModelAliases());
afterEach(() => resetWireModelAliases());

describe("前提：前缀式别名确实 miss（后缀式会被前缀匹配救回，不能当判据）", () => {
  test("真名命中、前缀别名 miss、后缀别名被意外救回", () => {
    expect(lookupRegistry(REAL)?.maxOutputTokens).toBeGreaterThan(0);
    expect(lookupRegistry(ALIAS)).toBeFalsy();
    // 后缀式被前缀匹配救回 —— 正是它让缺陷躲过了单测
    expect(lookupRegistry(`${REAL}-gateway`)).toBeTruthy();
  });
});

describe("P1-1 query/loop.ts:3881 —— max_tokens 提升上限不得整块跳过", () => {
  test("按别名查必然 miss → modelMax=undefined → Stage 1 短路（修复前的行为）", () => {
    expect(lookupRegistry(ALIAS)?.maxOutputTokens).toBeUndefined();
  });

  test("按真名查拿到硬上限 → Stage 1 的 `if (modelMax && ...)` 才可能成立", () => {
    const modelMax = lookupRegistry(resolveWireModel(ALIAS, MODELS))?.maxOutputTokens;
    expect(modelMax).toBeGreaterThan(0);
    // 复现 Stage 1 的判据：当前上限低于硬上限时必须能提升
    const currentCeiling = 8192;
    expect(Boolean(modelMax && currentCeiling < modelMax)).toBe(true);
  });
});

describe("P1-2 cost-tracker resolvePricing —— 注册表兜底(步骤4)按真名，成本不得少算", () => {
  test("步骤 4 能按真名拿到价（修复前返回 null → 落 FALLBACK_PRICING）", () => {
    expect(resolvePricing(ALIAS, MODELS as any, undefined)).toBeTruthy();
  });

  test("别名与真名算出的成本必须一致（修复前 0.67x，静默少算 33%）", () => {
    const usage: any = {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const byReal = calculateUSDCost(REAL, usage, undefined, "anthropic", undefined);
    const byAlias = calculateUSDCost(ALIAS, usage, MODELS as any, "anthropic", undefined);
    expect(byReal).toBeGreaterThan(0);
    expect(byAlias).toBeCloseTo(byReal, 6);
  });

  test("§2.1 反向不变量：用户显式 pricing 仍按别名分渠道，不得被真名抹平", () => {
    // 两条渠道指向同一真名，各自配不同的价 —— 差价必须保住
    const dual = [
      { name: "gw-x", modelId: REAL, baseURL: "https://gw/v1", pricing: { input: 1, output: 2 } },
      { name: "official-x", modelId: REAL, baseURL: "https://api/v1", pricing: { input: 10, output: 20 } },
    ];
    expect(resolvePricing("gw-x", dual as any, "https://gw/v1")?.input).toBe(1);
    expect(resolvePricing("official-x", dual as any, "https://api/v1")?.input).toBe(10);
  });
});

describe("P2-3 system-prompt —— reasoningLanguageDrift 铁律措辞按真名判定", () => {
  test("catalog 能力标志：真名命中、前缀别名 miss", () => {
    const { lookupCatalog } = require("@sid-code/core/llm/model-params-catalog.ts");
    // 找一个确实声明了该标志的真名，避免把断言钉在恰好为 undefined 的模型上
    const drifty = "deepseek-reasoner";
    expect(lookupCatalog(drifty)?.reasoningLanguageDrift).toBe(true);
    expect(lookupCatalog(`gw-${drifty}`)?.reasoningLanguageDrift).toBeUndefined();
    // 经 resolveWireModel 翻译后恢复
    const translated = resolveWireModel(`gw-${drifty}`, [{ name: `gw-${drifty}`, modelId: drifty }]);
    expect(lookupCatalog(translated)?.reasoningLanguageDrift).toBe(true);
  });

  test("buildSystemPrompt 端到端：别名 + availableModels 仍产出铁律措辞", () => {
    const { buildSystemPrompt } = require("@sid-code/core/config/system-prompt.ts");
    const drifty = "deepseek-reasoner";
    const base = { tools: [], workingDir: process.cwd(), preferredLanguage: "zh" as const };
    const byReal = buildSystemPrompt({ ...base, model: drifty });
    const byAlias = buildSystemPrompt({
      ...base,
      model: `gw-${drifty}`,
      availableModels: [{ name: `gw-${drifty}`, modelId: drifty }],
    });
    // 未配 availableModels 的别名 → 翻不出真名 → 应退化成普通档（即修复前的错误行为）
    const byAliasUntranslated = buildSystemPrompt({ ...base, model: `gw-${drifty}` });

    // 这两段是「铁律档」独有的（普通档不含），拿它们当判据才能真正区分两档：
    // 实测 drift 档 6046 字符含此二者，普通档 5844 字符均不含。
    for (const marker of ["思考语言疏导", "internal_en"]) {
      expect(byReal).toContain(marker);
      expect(byAlias).toContain(marker);          // 修复后：别名经翻译拿到同一档
      expect(byAliasUntranslated).not.toContain(marker); // 反证：翻不出来就是普通档
    }
  });
});

describe("P2-5 跨进程 —— 必须播种整张表，fallback 目标才翻得出来", () => {
  const DUAL = [
    { name: "gw-main", modelId: "real-main" },
    { name: "gw-fallback", modelId: "real-fallback" },
  ];

  test("只播种主模型单条 → fallback 目标查不到（修复前的行为）", () => {
    setWireModelAliases([{ name: "gw-main", modelId: "real-main" }]);
    expect(lookupWireModelAlias("gw-main")).toBe("real-main");
    expect(lookupWireModelAlias("gw-fallback")).toBeUndefined();
  });

  test("播种整张表 → fallback 目标也翻得出来", () => {
    setWireModelAliasesFromMap(buildWireModelAliasMap(DUAL));
    expect(lookupWireModelAlias("gw-main")).toBe("real-main");
    expect(lookupWireModelAlias("gw-fallback")).toBe("real-fallback");
  });

  test("buildWireModelAliasMap：只收 modelId !== name，空表返回 undefined", () => {
    expect(buildWireModelAliasMap(undefined)).toBeUndefined();
    expect(buildWireModelAliasMap([])).toBeUndefined();
    expect(buildWireModelAliasMap([{ name: "a" }])).toBeUndefined();
    expect(buildWireModelAliasMap([{ name: "a", modelId: "a" }])).toBeUndefined();
    expect(buildWireModelAliasMap(DUAL)).toEqual({
      "gw-main": "real-main",
      "gw-fallback": "real-fallback",
    });
  });

  test("buildWireModelAliasMap 脏值容错（在 loadConfig/spawn 链上，抛出即起不来）", () => {
    expect(() =>
      buildWireModelAliasMap([
        { name: "a", modelId: 123 as any },
        { name: 456 as any, modelId: "x" },
        { name: "b", modelId: "   " },
        { name: "c", modelId: null as any },
      ]),
    ).not.toThrow();
    expect(buildWireModelAliasMap([{ name: "a", modelId: 123 as any }])).toBeUndefined();
  });

  test("同名多条保留第一条（与选择侧 find-first 严格同语义）", () => {
    expect(buildWireModelAliasMap([
      { name: "d", modelId: "first" },
      { name: "d", modelId: "second" },
    ])).toEqual({ d: "first" });
  });

  test("export/import 对偶：导出再播种得到同一张表", () => {
    setWireModelAliases(DUAL);
    const exported = exportWireModelAliases();
    expect(exported).toEqual({ "gw-main": "real-main", "gw-fallback": "real-fallback" });
    resetWireModelAliases();
    expect(lookupWireModelAlias("gw-main")).toBeUndefined();
    setWireModelAliasesFromMap(exported);
    expect(lookupWireModelAlias("gw-main")).toBe("real-main");
  });

  test("exportWireModelAliases 空表返回 undefined（便于直接塞可选协议字段）", () => {
    expect(exportWireModelAliases()).toBeUndefined();
  });

  test("setWireModelAliasesFromMap 收到脏输入不抛、且清空旧表", () => {
    setWireModelAliases(DUAL);
    expect(() => setWireModelAliasesFromMap(undefined)).not.toThrow();
    expect(lookupWireModelAlias("gw-main")).toBeUndefined();
    setWireModelAliases(DUAL);
    expect(() => setWireModelAliasesFromMap({ a: 1 as any, b: null as any })).not.toThrow();
    expect(lookupWireModelAlias("gw-main")).toBeUndefined();
  });

  test("registry.getSpawnConfigForSubAgent 带出整张表", () => {
    const { ProviderRegistry } = require("@sid-code/core/llm/registry.ts");
    const reg = new ProviderRegistry({
      provider: "anthropic",
      model: "gw-main",
      baseURL: "https://gw/v1",
      anthropicKey: "sk-test",
      availableModels: DUAL,
    } as any);
    const sc = reg.getSpawnConfigForSubAgent("task");
    expect(sc.wireModel).toBe("real-main");
    expect(sc.wireModelAliases).toEqual({
      "gw-main": "real-main",
      "gw-fallback": "real-fallback",
    });
  });
});

describe("P2-4 telemetry 归因口径 —— openai.ts 的 emit 必须打别名", () => {
  test("静态断言：emit 调用点不得再出现 model: effectiveModel", async () => {
    const src = await Bun.file(
      new URL("../../packages/core/src/llm/openai.ts", import.meta.url).pathname,
    ).text();
    // 逐个 emit 调用块检查（跨行，故取调用点后 8 行窗口）
    const lines = src.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (/emit(StreamPhase|HttpConnected|TimeoutFired)\(/.test(line)) {
        const block = lines.slice(i, i + 8).join("\n");
        // 只看到下一个 `);` 为止，避免窗口越界到无关代码
        const body = block.split(/\)\s*;/)[0] ?? "";
        if (/model:\s*effectiveModel/.test(body)) offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
  });
});
