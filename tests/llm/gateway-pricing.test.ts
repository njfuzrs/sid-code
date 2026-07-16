/**
 * gateway-pricing.ts 测试 — 网关定价换算公式 + 边界
 *
 * 公式（已用官方价模型核对）：
 *   input  = model_ratio × 2
 *   output = input × completion_ratio
 *   cacheRead  = input × cache_ratio
 *   cacheWrite = input × create_cache_ratio
 *   quota_type=1 → 按次（返回 null，退回兜底）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path"; // mkdtemp 前缀拼接用
import {
  convertRawEntry,
  derivePricingURL,
  loadGatewayCache,
  lookupGatewayPricing,
  getAllGatewayEntries,
  getGatewayCacheMeta,
  __resetGatewayPricingForTest,
} from "../../src/llm/gateway-pricing.ts";
import { sidPaths } from "../../src/config/paths.ts";

describe("convertRawEntry — 换算公式", () => {
  test("claude-opus-4-8（官方价核对：in $5 / out $25 / cacheRead $0.5）", () => {
    const r = convertRawEntry({
      model_name: "claude-opus-4-8",
      quota_type: 0,
      model_ratio: 2.5,
      completion_ratio: 5,
      cache_ratio: 0.1,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.input).toBeCloseTo(5, 6);
    expect(r!.entry.output).toBeCloseTo(25, 6);
    expect(r!.entry.cacheRead).toBeCloseTo(0.5, 6);
  });

  test("ali-deepseek-v4-pro（渠道价 in $1.6438 / out $3.2877，非官方 $0.435）", () => {
    const r = convertRawEntry({
      model_name: "ali-deepseek-v4-pro",
      quota_type: 0,
      model_ratio: 0.821915,
      completion_ratio: 2,
      cache_ratio: 0.1,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.input).toBeCloseTo(1.64383, 4);
    expect(r!.entry.output).toBeCloseTo(3.28766, 4);
  });

  test("quota_type=1 按次计费 → perCallUSD，token 价置 0", () => {
    const r = convertRawEntry({
      model_name: "veo-3.1-fast-generate-preview",
      quota_type: 1,
      model_price: 1.2,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.quotaType).toBe(1);
    expect(r!.entry.perCallUSD).toBe(1.2);
    expect(r!.entry.input).toBe(0);
  });

  test("缺 model_name → null", () => {
    expect(convertRawEntry({ quota_type: 0, model_ratio: 1 })).toBeNull();
  });

  test("非法 model_ratio（负数/NaN）→ null", () => {
    expect(convertRawEntry({ model_name: "x", quota_type: 0, model_ratio: -1 })).toBeNull();
    expect(convertRawEntry({ model_name: "x", quota_type: 0, model_ratio: NaN })).toBeNull();
  });

  test("quota_type=1 缺 model_price → null", () => {
    expect(convertRawEntry({ model_name: "x", quota_type: 1 })).toBeNull();
  });
});

describe("derivePricingURL", () => {
  test("剥路径取 origin + /api/pricing", () => {
    expect(derivePricingURL("https://gateway.example.com/v1")).toBe("https://gateway.example.com/api/pricing");
    expect(derivePricingURL("https://gateway.example.com")).toBe("https://gateway.example.com/api/pricing");
  });
});

describe("多端点缓存分桶（修复互相覆盖 bug）", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;

  /** 写一份缓存文件到隔离的配置目录（SID_CONFIG_DIR=tmpDir，gatewayPricing 直接落在根）。 */
  function writeCache(file: unknown): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(sidPaths.gatewayPricing(), JSON.stringify(file), "utf8");
  }

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-pricing-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("同名模型不同端点桶各自计价，不互相覆盖", () => {
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://ali.example.com": {
          source_url: "https://ali.example.com/api/pricing",
          fetched_at: Date.now(),
          pricing_version: "aaa",
          models: { "deepseek-v4-pro": { input: 1.64, output: 3.29, quotaType: 0 } },
        },
        "https://tx.example.com": {
          source_url: "https://tx.example.com/api/pricing",
          fetched_at: Date.now(),
          pricing_version: "bbb",
          models: { "deepseek-v4-pro": { input: 1.32, output: 2.64, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();

    // 端点感知：各端点命中各自桶的价格。
    expect(lookupGatewayPricing("deepseek-v4-pro", "https://ali.example.com")!.input).toBeCloseTo(1.64, 6);
    expect(lookupGatewayPricing("deepseek-v4-pro", "https://tx.example.com")!.input).toBeCloseTo(1.32, 6);
  });

  test("末尾斜杠/大小写归一化后仍命中同一端点桶", () => {
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://ali.example.com": {
          source_url: "x", fetched_at: Date.now(), pricing_version: "v",
          models: { "m": { input: 9, output: 18, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();
    // 传入带斜杠 + 大写 host，归一化后应命中。
    expect(lookupGatewayPricing("m", "https://ALI.example.com/")!.input).toBe(9);
  });

  test("端点桶未命中时跨桶按模型名兜底（冷门渠道）", () => {
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://a.example.com": {
          source_url: "x", fetched_at: Date.now(), pricing_version: "v",
          models: { "only-on-a": { input: 5, output: 10, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();
    // 请求端点 b 没有这个模型，跨桶兜底命中 a 桶。
    expect(lookupGatewayPricing("only-on-a", "https://b.example.com")!.input).toBe(5);
  });

  test("按次计费（quotaType=1）查询返回 null，但 getAllGatewayEntries 保留 perCallUSD", () => {
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://a.example.com": {
          source_url: "x", fetched_at: Date.now(), pricing_version: "v",
          models: { "veo": { input: 0, output: 0, quotaType: 1, perCallUSD: 1.2 } },
        },
      },
    });
    loadGatewayCache();
    // 计费热路径：按次计费退回兜底（null）。
    expect(lookupGatewayPricing("veo", "https://a.example.com")).toBeNull();
    // 展示层：仍能拿到按次单价。
    const all = getAllGatewayEntries("https://a.example.com");
    expect(all["veo"].quotaType).toBe(1);
    expect(all["veo"].perCallUSD).toBe(1.2);
  });

  test("旧版 v1 扁平结构自动迁移到默认端点桶", () => {
    // 旧格式：无 endpoints，顶层直接 models。
    writeCache({
      source_url: "https://old.example.com/api/pricing",
      fetched_at: Date.now(),
      pricing_version: "legacy",
      models: { "legacy-model": { input: 7, output: 14, quotaType: 0 } },
    });
    loadGatewayCache();
    // 迁移到 "" 桶（官方默认端点），不传 baseURL 时命中。
    expect(lookupGatewayPricing("legacy-model")!.input).toBe(7);
    // 聚合元信息可读。
    const meta = getGatewayCacheMeta();
    expect(meta!.count).toBe(1);
  });

  test("零价模型不覆盖注册表（返回 null 退回兜底）", () => {
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://a.example.com": {
          source_url: "x", fetched_at: Date.now(), pricing_version: "v",
          models: { "free-model": { input: 0, output: 0, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();
    expect(lookupGatewayPricing("free-model", "https://a.example.com")).toBeNull();
  });
});
