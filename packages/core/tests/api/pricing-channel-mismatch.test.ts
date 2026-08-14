/**
 * 计费单价套错渠道 —— 回归 + 门禁（P0-2 A 组 / D 组）
 *
 * 事故（2026-08-11 实测）：官方直连 `https://api.deepseek.com` 的请求，单价被套成了
 * 某网关渠道价。
 *
 *   resolvePricing("deepseek-v4-pro", undefined, "https://api.deepseek.com")
 *     实际 => {input: 1.64383, cacheRead: 0.13700}   ← 某网关渠道价
 *     应为 => {input: 0.435,   cacheRead: 0.0036}    ← 内置注册表（官方价）
 *
 * 链路：官方端点没有 `/api/pricing` 接口（那是 new-api 类网关的私有接口）→ 采集必然失败
 * → 留下 `fail_count>0` + `models:{}` 的空桶 → `lookupGatewayPricing` 跨桶按名兜底
 * → 抓到空 key 桶里同名的网关价 → 顶掉了注册表里正确的官方价。
 *
 * **为什么必须逐项断言、且用量与单价分开测**（本文件的存在理由）：
 * 本次 `cacheRead` 偏离 **38.1×**（0.0036 → 0.137），而 81.2% 的 token 都是缓存命中，
 * 费用结构被 cacheRead 主导 → 单价整体高估 4.94×。同期用量少记（0.74×，方向相反），
 * 两者部分抵消成最终 3.63×。
 * ⇒ 只断言 input 会漏掉 cacheRead；只校验最终金额会被"方向相反的两个错误互相掩护"骗过。
 *
 * 落盘隔离：本文件碰 `~/.sid-code/gateway-pricing.json`。全程重定向 SID_CONFIG_DIR 到
 * tmpdir，且**存/恢复原值**而非无条件 delete —— 同批多测试文件跑在同一进程里，
 * 无条件 delete 会把 bunfig preload 的兜底一起抹掉（见 CONTRIBUTING.md 测试约定）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePricing } from "@sid-code/core/api/cost-tracker.ts";
import {
  isOfficialEndpoint,
  __resetGatewayPricingForTest,
} from "@sid-code/core/llm/gateway-pricing.ts";
import { lookupRegistry, getRegistryEntries } from "@sid-code/core/llm/model-registry.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

/** 官方价（内置注册表）—— 断言的锚点，取自 model-registry.ts。 */
const OFFICIAL_PRO = { input: 0.435, output: 0.87, cacheRead: 0.0036 };
/** 事故现场那个网关渠道价 —— 断言"不得返回"的值。 */
const GATEWAY_PRO = { input: 1.64383, output: 3.28767, cacheRead: 0.137 };

let tmpDir: string;
let prevConfigDir: string | undefined;

/** 复刻事故现场的缓存文件：官方端点空桶(fail_count=2) + 空 key 桶装着网关渠道价。 */
function writeIncidentCache(): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(
    sidPaths.gatewayPricing(),
    JSON.stringify({
      schema_version: 2,
      endpoints: {
        // 空 key 桶（"官方默认端点"名义，实际是成分不明的收纳桶）
        "": {
          source_url: "https://uniapi.example.com/api/pricing",
          fetched_at: Date.now(),
          pricing_version: "mixed",
          models: {
            "deepseek-v4-pro": { ...GATEWAY_PRO, cacheWrite: 0, quotaType: 0 },
            "origin-deepseek-v4-pro": {
              input: 0.41095,
              output: 0.8219,
              cacheRead: 0.041,
              cacheWrite: 0,
              quotaType: 0,
            },
            "ali-deepseek-v4-pro": { ...GATEWAY_PRO, cacheWrite: 0, quotaType: 0 },
          },
        },
        // 官方端点桶：采集失败留下的空桶（这正是触发错兜底的那个桶）
        "https://api.deepseek.com": {
          source_url: "https://api.deepseek.com/api/pricing",
          fetched_at: 0,
          pricing_version: "",
          models: {},
          failed_at: Date.now(),
          fail_count: 2,
        },
        // 某真实网关端点桶（有自己的渠道价）
        "https://uniapi.example.com/v1": {
          source_url: "https://uniapi.example.com/api/pricing",
          fetched_at: Date.now(),
          pricing_version: "gw",
          models: {
            "deepseek-v4-pro": {
              input: 0.2260274,
              output: 0.452,
              cacheRead: 0.0226,
              cacheWrite: 0,
              quotaType: 0,
            },
          },
        },
      },
    }),
    "utf8",
  );
}

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "pricing-channel-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetGatewayPricingForTest();
});

afterEach(() => {
  // 必须存/恢复，不能无条件 delete（会抹掉 preload 兜底，污染同进程后续测试）。
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  __resetGatewayPricingForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("A 组 · 官方端点不得被套上网关渠道价（事故直接回归）", () => {
  test("官方端点 + 空桶(fail_count=2) + 空 key 桶有网关价 → 必须返回注册表官方价", () => {
    writeIncidentCache();
    const p = resolvePricing("deepseek-v4-pro", undefined, "https://api.deepseek.com");
    expect(p).not.toBeNull();
    // 逐项断言：cacheRead 是本次错得最狠的一项（38.1×），只看 input 会漏掉它。
    expect(p!.input).toBeCloseTo(OFFICIAL_PRO.input, 6);
    expect(p!.output).toBeCloseTo(OFFICIAL_PRO.output, 6);
    expect(p!.cacheRead!).toBeCloseTo(OFFICIAL_PRO.cacheRead, 8);
    // 反向断言：不得是事故现场那个渠道价。
    expect(p!.input).not.toBeCloseTo(GATEWAY_PRO.input, 3);
    expect(p!.cacheRead!).not.toBeCloseTo(GATEWAY_PRO.cacheRead, 4);
  });

  test("cacheRead 单独隔离：偏离倍数必须 ≈1（事故时 38.1×）", () => {
    writeIncidentCache();
    const p = resolvePricing("deepseek-v4-pro", undefined, "https://api.deepseek.com")!;
    const ratio = p.cacheRead! / OFFICIAL_PRO.cacheRead;
    expect(ratio).toBeCloseTo(1, 6);
  });

  test("不传 baseURL（= 官方直连）+ 空 key 桶装着网关价 → 仍走注册表", () => {
    // 空 key 桶是成分不明的收纳桶：syncGatewayPricing({url}) 与 v1 迁移都往这儿写。
    // "没配 baseURL" 本身就意味着官方直连，此时裸名该信注册表。
    writeIncidentCache();
    const p = resolvePricing("deepseek-v4-pro", undefined, undefined)!;
    expect(p.input).toBeCloseTo(OFFICIAL_PRO.input, 6);
    expect(p.cacheRead!).toBeCloseTo(OFFICIAL_PRO.cacheRead, 8);
  });

  test("大小写变体（DeepSeek-V4-Pro）同样受保护，不因写法不同漏判成渠道名", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 2,
        endpoints: {
          "": {
            source_url: "x",
            fetched_at: Date.now(),
            pricing_version: "v",
            models: { "DeepSeek-V4-Pro": { ...GATEWAY_PRO, cacheWrite: 0, quotaType: 0 } },
          },
        },
      }),
      "utf8",
    );
    const p = resolvePricing("DeepSeek-V4-Pro", undefined, "https://api.deepseek.com")!;
    expect(p.input).toBeCloseTo(OFFICIAL_PRO.input, 6);
    expect(p.cacheRead!).toBeCloseTo(OFFICIAL_PRO.cacheRead, 8);
  });
});

describe("A 组 · 收紧兜底不得回归「渠道名套官方价、低估 3.7 倍」", () => {
  test("ali-deepseek-v4-pro 在自己端点桶命中渠道价（不是官方 0.435）", () => {
    writeIncidentCache();
    const p = resolvePricing("ali-deepseek-v4-pro", undefined, "https://uniapi.example.com/v1")!;
    expect(p.input).toBeCloseTo(GATEWAY_PRO.input, 4);
    expect(p.cacheRead!).toBeCloseTo(GATEWAY_PRO.cacheRead, 4);
    // 关键反向断言：不得回落成官方价（那就是本要修的 3.7× 低估）。
    expect(p.input).not.toBeCloseTo(OFFICIAL_PRO.input, 3);
  });

  test("带渠道前缀的名字仍可跨桶兜底（冷门渠道在别的端点桶里也算）", () => {
    writeIncidentCache();
    // 请求端点 other 没有这个模型 → 跨桶从空 key 桶借 ali- 的渠道价。
    const p = resolvePricing("ali-deepseek-v4-pro", undefined, "https://other.example.com/v1")!;
    expect(p.input).toBeCloseTo(GATEWAY_PRO.input, 4);
  });

  test("端点自己的桶优先于跨桶兜底（同名不同渠道各自计价）", () => {
    writeIncidentCache();
    // uniapi 端点桶里 deepseek-v4-pro = 0.2260274，不该被空 key 桶的 1.64383 顶掉。
    const p = resolvePricing("deepseek-v4-pro", undefined, "https://uniapi.example.com/v1")!;
    expect(p.input).toBeCloseTo(0.2260274, 6);
  });
});

describe("A 组 · 失效桶不参与跨桶兜底", () => {
  test("fail_count>0 的桶不得借出价格（价格是旧快照，不可信）", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 2,
        endpoints: {
          // 唯一持有 gw-only-model 的桶处于连续失败态 → 不得借出
          "https://stale.example.com": {
            source_url: "x",
            fetched_at: Date.now() - 1000,
            pricing_version: "old",
            models: { "gw-only-model": { input: 9, output: 18, cacheRead: 0.9, quotaType: 0 } },
            failed_at: Date.now(),
            fail_count: 3,
          },
        },
      }),
      "utf8",
    );
    // 注册表也没有这个模型 → resolvePricing 返回 null（调用方落 FALLBACK），
    // 而不是静默借用失效桶里的 $9。
    expect(resolvePricing("gw-only-model", undefined, "https://asking.example.com/v1")).toBeNull();
  });

  test("models 为空的桶不参与兜底（从没采成功过，没有可借的价）", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 2,
        endpoints: {
          "https://empty.example.com": {
            source_url: "x",
            fetched_at: 0,
            pricing_version: "",
            models: {},
          },
        },
      }),
      "utf8",
    );
    expect(
      resolvePricing("gw-nothing-model", undefined, "https://asking.example.com/v1"),
    ).toBeNull();
  });

  test("健康桶仍正常借出（证明上面两条不是把兜底整个关掉）", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 2,
        endpoints: {
          "https://healthy.example.com": {
            source_url: "x",
            fetched_at: Date.now(),
            pricing_version: "v",
            models: { "gw-only-model": { input: 9, output: 18, cacheRead: 0.9, quotaType: 0 } },
          },
        },
      }),
      "utf8",
    );
    const p = resolvePricing("gw-only-model", undefined, "https://asking.example.com/v1")!;
    expect(p.input).toBe(9);
  });

  test("失效桶被**精确**命中时仍照用（失败不该抹掉已采到的价）", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 2,
        endpoints: {
          "https://flip.example.com/v1": {
            source_url: "x",
            fetched_at: Date.now() - 1000,
            pricing_version: "old",
            models: { "gw-only-model": { input: 7, output: 14, cacheRead: 0.7, quotaType: 0 } },
            failed_at: Date.now(),
            fail_count: 2,
          },
        },
      }),
      "utf8",
    );
    // 约束只针对**跨桶借价**：自己端点的价即使处于失败退避中也照用。
    const p = resolvePricing("gw-only-model", undefined, "https://flip.example.com/v1")!;
    expect(p.input).toBe(7);
  });
});

describe("A 组 · isOfficialEndpoint 判据", () => {
  test("厂商官方 host 命中", () => {
    expect(isOfficialEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isOfficialEndpoint("https://api.deepseek.com/v1")).toBe(true);
    expect(isOfficialEndpoint("https://api.anthropic.com")).toBe(true);
    expect(isOfficialEndpoint("https://api.openai.com/v1")).toBe(true);
  });

  test("网关 / 自建端点不命中", () => {
    expect(isOfficialEndpoint("https://uniapi.example.com/v1")).toBe(false);
    expect(isOfficialEndpoint("https://gw.corp.internal/v1")).toBe(false);
    expect(isOfficialEndpoint(undefined)).toBe(false);
    expect(isOfficialEndpoint("")).toBe(false);
  });

  test("不得被相似域名骗过（后缀匹配须带点号边界）", () => {
    // "notapi.deepseek.com.evil.com" 不是官方端点
    expect(isOfficialEndpoint("https://api.deepseek.com.evil.com/v1")).toBe(false);
    expect(isOfficialEndpoint("https://fakeapi.openai.com.attacker.net")).toBe(false);
  });

  test("子域名命中（如 gateway.api.openai.com 形态）", () => {
    expect(isOfficialEndpoint("https://foo.api.openai.com")).toBe(true);
  });
});

/**
 * D 组 · 与官方价目表的黄金基准（人工维护）
 *
 * 官方人民币价目表（DeepSeek 官方，2026-08，元/百万 token）——用户提供 + 官方账单交叉验证：
 *
 * |                  | v4-pro | v4-flash |
 * | 输入（未命中）    | ¥3     | ¥1       |
 * | 输入（缓存命中）  | ¥0.025 | ¥0.02    |
 * | 输出              | ¥6     | ¥2       |
 *
 * 内置注册表是 USD 口径。逐项相除得隐含汇率，六项应高度一致（实测 6.90 / 6.94 / 7.14）。
 * 厂商调价时本测试会失败，提示更新注册表 —— 这是它的**目的**，不是脆弱。
 */
describe("D 组 · 内置注册表 vs 官方人民币价目表（黄金基准）", () => {
  const OFFICIAL_CNY: Record<string, { input: number; cacheRead: number; output: number }> = {
    "deepseek-v4-pro": { input: 3, cacheRead: 0.025, output: 6 },
    "deepseek-v4-flash": { input: 1, cacheRead: 0.02, output: 2 },
  };

  test("逐项隐含汇率落在 6.5~7.5（含 cacheRead，不只 input）", () => {
    const rates: Array<{ model: string; item: string; rate: number }> = [];
    for (const [model, cny] of Object.entries(OFFICIAL_CNY)) {
      const usd = lookupRegistry(model)?.pricing;
      expect(usd, `注册表缺少 ${model} 的 pricing`).toBeTruthy();
      rates.push({ model, item: "input", rate: cny.input / usd!.input });
      rates.push({ model, item: "output", rate: cny.output / usd!.output });
      rates.push({ model, item: "cacheRead", rate: cny.cacheRead / usd!.cacheRead! });
    }
    // 六项全部校验（cacheRead 是本次事故错得最狠的一项，必须在内）
    expect(rates.length).toBe(6);
    for (const r of rates) {
      expect(r.rate, `${r.model}.${r.item} 隐含汇率 ${r.rate.toFixed(3)} 越界`).toBeGreaterThan(
        6.5,
      );
      expect(r.rate, `${r.model}.${r.item} 隐含汇率 ${r.rate.toFixed(3)} 越界`).toBeLessThan(7.5);
    }
  });

  test("同模型内三项汇率互相一致（防止只改了一项单价）", () => {
    for (const [model, cny] of Object.entries(OFFICIAL_CNY)) {
      const usd = lookupRegistry(model)!.pricing!;
      const rIn = cny.input / usd.input;
      const rOut = cny.output / usd.output;
      const rCache = cny.cacheRead / usd.cacheRead!;
      // 允许 5% 离散（官方价目表本身是整数元，换算有舍入）
      expect(Math.abs(rIn - rOut) / rIn, `${model} input↔output 汇率不一致`).toBeLessThan(0.05);
      expect(Math.abs(rIn - rCache) / rIn, `${model} input↔cacheRead 汇率不一致`).toBeLessThan(
        0.05,
      );
    }
  });
});

/**
 * D 组 · 单价偏离门禁（与用量校验**分开**，这是本组的核心设计）
 *
 * 为什么必须分开：本次单价 ×4.94 与用量 ×0.74 方向相反、部分抵消成 ×3.63。
 * 任何"只看最终金额"的校验都会被这种互相掩护骗过 —— 金额只是"有点大"，
 * 掩盖了单价近 5 倍的离谱错误。
 */
describe("D 组 · 单价逐项偏离门禁", () => {
  /** 逐项偏离倍数（相对内置注册表），任一项超阈值即失败。 */
  function deviations(model: string, baseURL?: string): Record<string, number> {
    const actual = resolvePricing(model, undefined, baseURL);
    const expected = lookupRegistry(model)?.pricing;
    if (!actual || !expected) return {};
    const safe = (a: number, b: number) => (b === 0 ? (a === 0 ? 1 : Infinity) : a / b);
    return {
      input: safe(actual.input, expected.input),
      output: safe(actual.output, expected.output),
      cacheRead: safe(actual.cacheRead ?? 0, expected.cacheRead ?? 0),
    };
  }

  test("官方端点：逐项偏离倍数全部 ≈1", () => {
    writeIncidentCache();
    const dev = deviations("deepseek-v4-pro", "https://api.deepseek.com");
    for (const [item, ratio] of Object.entries(dev)) {
      expect(ratio, `${item} 偏离 ${ratio.toFixed(2)}×`).toBeGreaterThan(1 / 2);
      expect(ratio, `${item} 偏离 ${ratio.toFixed(2)}×`).toBeLessThan(2);
    }
  });

  test("门禁自证：修复前的错值确实会被这道门禁拦住", () => {
    // 用事故实测值直接算偏离，证明阈值(2×)对 input 4.94× / cacheRead 38.1× 都会红。
    const expected = lookupRegistry("deepseek-v4-pro")!.pricing!;
    const inputDev = GATEWAY_PRO.input / expected.input;
    const cacheDev = GATEWAY_PRO.cacheRead / expected.cacheRead!;
    expect(inputDev).toBeGreaterThan(2); // 3.78×
    expect(cacheDev).toBeGreaterThan(2); // 38.1×
    // 而只看 input 会大幅低估问题严重性 —— 这正是"必须逐项"的量化理由。
    expect(cacheDev / inputDev).toBeGreaterThan(9);
  });

  test("注册表里每个模型的 cacheRead 都不高于 input（结构性合理性）", () => {
    const bad: string[] = [];
    for (const [name, entry] of getRegistryEntries()) {
      const p = entry.pricing;
      if (!p || p.cacheRead === undefined) continue;
      if (p.cacheRead > p.input) bad.push(`${name}: cacheRead ${p.cacheRead} > input ${p.input}`);
    }
    expect(bad).toEqual([]);
  });
});
