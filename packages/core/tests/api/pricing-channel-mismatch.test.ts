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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePricing, effectivePricing } from "@sid-code/core/api/cost-tracker.ts";
import {
  isOfficialEndpoint,
  convertRawEntry,
  parseBillingExpr,
  loadGatewayCache,
  __resetGatewayPricingForTest,
} from "@sid-code/core/llm/gateway-pricing.ts";
import { lookupRegistry, getRegistryEntries } from "@sid-code/core/llm/model-registry.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

/**
 * 官方价（内置注册表）—— 断言的锚点，取自 model-registry.ts。
 *
 * D1（2026-08-21）：改成**人民币高峰价**，与注册表现在的存储口径一致
 * （注册表存原币 + `currency: "CNY"` + `fxToUSD`，见 model-registry.ts 的
 * DEEPSEEK_CNY_TO_USD 注释）。本组测的是"官方端点有没有被套上网关渠道价"，
 * 与币种无关 —— 锚点跟着注册表口径走即可。
 */
const OFFICIAL_PRO = { input: 9, output: 27, cacheRead: 0.3 };
/**
 * 一个落在**高峰时段**的固定时刻（UTC 02:30，= 北京 10:30）。
 *
 * 显式传时刻而不是用"现在"：注册表存的是高峰价 + `offPeakMultiplier`，
 * 用"现在"会让这条测试在空闲时段跑出另一组数字 —— 那种随挂钟变红的测试
 * 会被人当成 flaky 直接跳过，而不是当成信号。
 */
const PEAK_AT = new Date(Date.UTC(2026, 7, 21, 2, 30, 0));

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
 * 官方人民币价目表（DeepSeek 官方，**2026-08-17 起的峰谷定价**，元/百万 token）。
 *
 * ⚠ 2026-08-21 事故修复（D1）：这张表原先记的是 08-17 涨价**之前**的价
 * （pro ¥3/¥0.025/¥6）。厂商 08-16 16:00 UTC 起启用峰谷定价、单价整体上调，
 * 而这张"黄金基准"和注册表一起停在旧值 —— 于是它**没能发现涨价**。
 * 教训：黄金基准与被测数据同源更新时，它只能防"改错"，防不了"都没改"。
 * 真正兜住"都没改"的是 §5.6 的账单对账脚本（拿官方账单比最终金额）。
 *
 * 高峰时段（北京时间 09:00–12:00、14:00–18:00）价：
 *
 * |                  | v4-pro  | v4-flash |
 * | 输入（未命中）    | ¥9      | ¥3       |
 * | 输入（缓存命中）  | ¥0.3    | ¥0.1     |
 * | 输出              | ¥27     | ¥9       |
 *
 * 空闲时段为上表的一半（注册表用 `offPeakMultiplier: 0.5` 表达）。
 *
 * 注册表现在**直接存人民币**（`currency: "CNY"` + `fxToUSD`），所以这里逐项相除
 * 得到的不再是"隐含汇率"而应恒为 1 —— 这比校验汇率区间更强：
 * 它同时钉住了单价与币种标注两件事。
 * 厂商调价时本测试会失败，提示更新注册表 —— 这是它的**目的**，不是脆弱。
 */
describe("D 组 · 内置注册表 vs 官方人民币价目表（黄金基准）", () => {
  const OFFICIAL_CNY: Record<string, { input: number; cacheRead: number; output: number }> = {
    "deepseek-v4-pro": { input: 9, cacheRead: 0.3, output: 27 },
    "deepseek-v4-flash": { input: 3, cacheRead: 0.1, output: 9 },
  };

  test("注册表逐项等于官方人民币高峰价（币种标注 + 单价一起钉住）", () => {
    for (const [model, cny] of Object.entries(OFFICIAL_CNY)) {
      const p = lookupRegistry(model)?.pricing;
      expect(p, `注册表缺少 ${model} 的 pricing`).toBeTruthy();
      // 币种必须显式标注 CNY —— 不标注就会被当美元算（低估约 7 倍，正是 D1 的一半成因）
      expect(p!.currency, `${model} 未标注 currency`).toBe("CNY");
      expect(p!.fxToUSD, `${model} 标了 CNY 却没给 fxToUSD`).toBeGreaterThan(0);
      expect(p!.input, `${model}.input`).toBeCloseTo(cny.input, 6);
      expect(p!.output, `${model}.output`).toBeCloseTo(cny.output, 6);
      expect(p!.cacheRead!, `${model}.cacheRead`).toBeCloseTo(cny.cacheRead, 6);
    }
  });

  test("峰谷政策已表达：空闲价恰为高峰价一半，窗口为官方公告的两段", () => {
    // 这条防的是"只改了数字、没接时段"——那种改法在高峰时段测起来完全正常，
    // 只在空闲时段高估一倍，而没有任何断言会失败。
    for (const model of Object.keys(OFFICIAL_CNY)) {
      const p = lookupRegistry(model)!.pricing!;
      expect(p.peakWindows?.length, `${model} 缺 peakWindows`).toBe(2);
      expect(p.offPeakMultiplier, `${model} 缺 offPeakMultiplier`).toBe(0.5);
    }
  });

  test("三项单价同比例（防止只改了一项）", () => {
    // 官方三项在 pro/flash 之间是同一组比例（未命中:命中:输出 = 9:0.3:27 与 3:0.1:9）。
    const pro = lookupRegistry("deepseek-v4-pro")!.pricing!;
    const flash = lookupRegistry("deepseek-v4-flash")!.pricing!;
    const rIn = pro.input / flash.input;
    const rOut = pro.output / flash.output;
    const rCache = pro.cacheRead! / flash.cacheRead!;
    expect(Math.abs(rIn - rOut) / rIn, "input↔output 比例不一致").toBeLessThan(0.05);
    expect(Math.abs(rIn - rCache) / rIn, "input↔cacheRead 比例不一致").toBeLessThan(0.05);
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
    // 用事故实测值直接算偏离，证明阈值(2×)对 input / cacheRead 两项都会红。
    //
    // ⚠ D1 之后必须**同币种相比**：注册表现在存人民币，而 GATEWAY_PRO 是事故现场的
    // 美元渠道价。直接相除是拿美元比人民币，算出来的"偏离倍数"没有意义
    //（实测会得到 1.25×，低于阈值 → 门禁看起来失效了，其实是单位错了）。
    // 折算成 USD 再比 —— 这也顺带证明了 effectivePricing 是在真的干活。
    const expected = effectivePricing(lookupRegistry("deepseek-v4-pro")!.pricing!, PEAK_AT);
    const inputDev = GATEWAY_PRO.input / expected.input;
    const cacheDev = GATEWAY_PRO.cacheRead / expected.cacheRead!;
    expect(inputDev).toBeGreaterThan(1.2);
    expect(cacheDev).toBeGreaterThan(2);
    // 只看 input 会大幅低估问题严重性 —— 这正是"必须逐项"的量化理由。
    // 涨价后 input 差距被拉近（新官方价本身就贵了），而 cacheRead 仍差一个量级。
    expect(cacheDev / inputDev).toBeGreaterThan(2);
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

/**
 * D 组扩展 · 网关渠道条目的**同记录自比**门禁（2026-09-17）
 *
 * ## 为什么原来那道 D 组门禁一次都没拦住本次事故
 *
 * 原门禁只有一处 `deviations("deepseek-v4-pro", "https://api.deepseek.com")` ——
 * **主语是「官方端点 + 单个模型」**，任何网关渠道条目（`ali-` / `tx-` / `origin-` 前缀）
 * 从不进入。而本次 12 条受损条目**全部**是网关渠道条目。
 *
 * 更深一层：`deviations` 的期望值取自 `lookupRegistry(model)?.pricing`，而 12 条里
 * **9 条根本不在注册表**。那种情况下 `if (!actual || !expected) return ` 返回空对象，
 * `for` 循环零次迭代，**一条断言都不执行而测试全绿** —— 与记忆库那条
 * 「`if(环境状态)` 包住断言 → 本机零断言全绿」同形。
 * ⇒ 所以这道门禁不能只是"多传几个模型名"，必须换一个**不依赖注册表**的期望值来源。
 *
 * ## 换成什么：同一条记录内部自比
 *
 * 每条 `tiered_expr` 记录里并列着两套价（残留旧字段 + 当前生效 expr）。判据是
 * **「解析结果必须等于 expr、且在两套价分歧时不等于 legacy」** —— 不需要任何外部黄金基准。
 *
 * ⚠ 判据刻意**不是**"12 条全部自洽"：上游哪天把旧字段修对了，那种断言会变绿，
 * 而"我们究竟读了哪一套字段"就再也测不出来了。要钉住的是**取数口径**，不是上游的数据质量。
 */
describe("D 组扩展 · 网关渠道 tiered_expr 条目（同记录自比）", () => {
  /** 实拉原始记录（2026-09-17，12 条）。手编夹具测不出本次 bug，见夹具文件头注释。 */
  const FIXTURE = JSON.parse(
    readFileSync(join(import.meta.dir, "../fixtures/gateway-pricing-tiered-expr.json"), "utf8"),
  ) as { data: Array<Record<string, unknown>> };

  /** 旧字段换算值（修复前的口径）：`model_ratio × 2`，output/cacheRead 按比例派生。 */
  function legacyPricing(raw: Record<string, unknown>) {
    const mr = raw.model_ratio as number | undefined;
    if (typeof mr !== "number") return null;
    const input = mr * 2;
    const comp = typeof raw.completion_ratio === "number" ? raw.completion_ratio : 0;
    const cache = typeof raw.cache_ratio === "number" ? raw.cache_ratio : undefined;
    return {
      input,
      output: input * comp,
      // 缺 cache_ratio 时下游落 `input × 0.1` 兜底 —— 这正是本次的主放大器，
      // 所以复刻修复前口径时必须把兜底也算进来，否则门禁自证会低估问题。
      cacheRead: cache !== undefined ? input * cache : input * 0.1,
    };
  }

  test("夹具形态自证：12 条、全部 tiered_expr、且含两条缺 cache_ratio 的", () => {
    // 没有这条，夹具被误改成空数组时下面所有 for 循环都会零次迭代而全绿
    //（本仓已经吃过一次「过滤后清单为空 → 打出 ✅」的亏）。
    expect(FIXTURE.data.length).toBe(12);
    expect(FIXTURE.data.every((e) => e.billing_mode === "tiered_expr")).toBe(true);
    const missingCache = FIXTURE.data.filter((e) => e.cache_ratio === undefined);
    expect(missingCache.map((e) => e.model_name).sort()).toEqual([
      "origin-deepseek-v4-1-flash",
      "origin-deepseek-v4-flash-vision",
    ]);
  });

  test("门禁自证：修复前的口径确实会被这道门禁拦住", () => {
    // 判据是「红的是哪条」：逐条算旧口径 vs expr 的偏离，证明阈值(2×)在多条上会红。
    // 没有这一步，下面那些断言可能是在锁一个想象中的实现。
    const flagged: string[] = [];
    let worst = 1;
    for (const raw of FIXTURE.data) {
      const expr = parseBillingExpr(raw.billing_expr)!;
      const legacy = legacyPricing(raw)!;
      for (const [item, a, b] of [
        ["input", legacy.input, expr.input],
        ["output", legacy.output, expr.output],
        ["cacheRead", legacy.cacheRead, expr.cacheRead],
      ] as const) {
        const ratio = a / b;
        if (ratio > 2 || ratio < 1 / 2) flagged.push(`${raw.model_name as string}.${item}`);
        worst = Math.max(worst, ratio);
      }
    }
    // 实测：12 条里 11 条至少一项超阈值（唯一自洽的是 tx-deepseek-v4-flash）。
    expect(new Set(flagged.map((f) => f.split(".")[0])).size).toBeGreaterThanOrEqual(10);
    // 最离谱那一格（origin-deepseek-v4-1-flash 的 cacheRead：7.5 兜底 vs 0.00548）远超千倍。
    expect(worst).toBeGreaterThan(1000);
  });

  test("有 expr 时解析结果逐项等于 expr，且分歧项不等于 legacy", () => {
    // 这是本组的核心断言。**逐项**（input/output/cacheRead）比，不看总额 ——
    // 本次偏差有正有负（7 个有账本记录的模型里 4 个是低报），
    // 任何"只看最终金额"的校验都会被方向相反的错误互相掩护骗过。
    let divergentItems = 0;
    for (const raw of FIXTURE.data) {
      const name = raw.model_name as string;
      const expr = parseBillingExpr(raw.billing_expr)!;
      const converted = convertRawEntry(raw)!;
      expect(converted.entry.priceSource, `${name} 未走 expr 口径`).toBe("expr");
      // expr 系数是**空闲价**，存储口径是**高峰价**（空闲由 offPeakMultiplier 派生）。
      const mult = converted.entry.peakWindows?.length ? 2 : 1;
      expect(converted.entry.input, `${name}.input`).toBeCloseTo(expr.input, 9);
      expect(converted.entry.output, `${name}.output`).toBeCloseTo(expr.output, 9);
      expect(converted.entry.cacheRead!, `${name}.cacheRead`).toBeCloseTo(expr.cacheRead, 11);
      // cacheRead 绝不能缺失：缺了就会落 input×0.1 兜底（本次主放大器，高报 2738×）。
      expect(converted.entry.cacheRead, `${name}.cacheRead 缺失`).toBeDefined();

      const legacy = legacyPricing(raw);
      if (legacy && Math.abs(legacy.input / expr.input - 1) > 0.01) {
        divergentItems++;
        expect(converted.entry.input, `${name} 读成了停止维护的 legacy 值`).not.toBeCloseTo(
          legacy.input,
          6,
        );
      }
      expect(mult).toBeGreaterThan(0);
    }
    // 分母自证：若夹具里两套价恰好全一致，上面那条 not.toBeCloseTo 会一次都不执行。
    expect(divergentItems, "夹具里没有任何分歧项，本门禁失去意义").toBeGreaterThanOrEqual(9);
  });

  test("窗口是渠道级事实：ali-* 与其余渠道的窗口不同（不能用厂商级常量）", () => {
    const byName = new Map(FIXTURE.data.map((e) => [e.model_name as string, e]));
    const ali = convertRawEntry(byName.get("ali-deepseek-v4-pro")!)!.entry;
    const other = convertRawEntry(byName.get("deepseek-v4-pro")!)!.entry;
    // 北京 8-22 → UTC 0-14 单窗口；北京 9-12/14-18 → UTC 1-4 / 6-10 两段。
    expect(ali.peakWindows).toEqual([{ startHour: 0, endHour: 14 }]);
    expect(other.peakWindows).toEqual([
      { startHour: 1, endHour: 4 },
      { startHour: 6, endHour: 10 },
    ]);
    expect(ali.peakWindows).not.toEqual(other.peakWindows);
  });

  test("网关渠道价经 resolvePricing 生效（端到端，不只是 convertRawEntry）", () => {
    // 门禁必须落在**真实取价入口**上：只测 convertRawEntry 会漏掉
    // 「解析对了但没透传到 ModelPricing」那一族死接线（toModelPricing 曾丢掉窗口两格）。
    const EP = "https://gw-expr.example.com";
    const models: Record<string, unknown> = {};
    for (const raw of FIXTURE.data) {
      const r = convertRawEntry(raw)!;
      models[r.name] = r.entry;
    }
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 3,
        endpoints: {
          [EP]: {
            source_url: `${EP}/api/pricing`,
            fetched_at: Date.now(),
            pricing_version: "expr",
            models,
          },
        },
      }),
      "utf8",
    );
    loadGatewayCache();

    const M = "origin-deepseek-v4-1-flash";
    const stored = resolvePricing(M, undefined, EP)!;
    expect(stored, `${M} 取不到网关价`).toBeTruthy();
    // 修复前这里是 75（旧字段 37.5 × 2）。
    expect(stored.input).toBeCloseTo(0.2739726, 9);
    expect(stored.input).not.toBeCloseTo(75, 1);
    expect(stored.peakWindows?.length, "窗口未透传到 resolvePricing").toBe(2);

    // 分时段两档都验：只验一档会漏掉「窗口丢了 ⇒ 整条按高峰算」（空闲时段高报一倍）。
    const PEAK = new Date(Date.UTC(2026, 8, 17, 2, 30)); // 北京 10:30
    const IDLE = new Date(Date.UTC(2026, 8, 17, 5, 0)); // 北京 13:00
    expect(effectivePricing(stored, PEAK).input).toBeCloseTo(0.2739726, 9);
    expect(effectivePricing(stored, IDLE).input).toBeCloseTo(0.1369863, 9);

    // ali 渠道在北京 13:00 仍是高峰（8-22 单窗口）—— 渠道级窗口的端到端判据。
    const ali = resolvePricing("ali-deepseek-v4-pro", undefined, EP)!;
    expect(effectivePricing(ali, IDLE).input).toBeCloseTo(1.232876712, 9);
  });
});
