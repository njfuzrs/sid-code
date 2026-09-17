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
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path"; // mkdtemp 前缀拼接用
import {
  convertRawEntry,
  parseBillingExpr,
  syncGatewayPricing,
  derivePricingURL,
  loadGatewayCache,
  lookupGatewayPricing,
  lookupGatewayPerCallUSD,
  getAllGatewayEntries,
  getGatewayCacheMeta,
  getFailureCooldownRemainingMs,
  __resetGatewayPricingForTest,
} from "@sid-code/core/llm/gateway-pricing.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

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

  test("纯按次（quota_type=1 且无 model_ratio）→ perCallUSD，token 价 0", () => {
    // 实测 uniapi 的 doubao-seedream 图片类就是这个形态：只有按次价，没有 token 价。
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

  test("⚠ 按次条目同时报 token 价时**两个都要留**（本次账本被兜底价污染的根因）", () => {
    // 实测 code.ppchat.vip 的 14 条 quota_type=1 全部同时带 model_ratio + completion_ratio，
    // 换算出来正是官方价。旧实现在 quotaType===1 时直接 return 并把 token 价置 0，于是：
    //   ① 计价拿不到价 → 落 FALLBACK $2/$10（实测污染 21 条账本记录）；
    //   ② 面板只剩「$60.00/次」，与账本口径自相矛盾。
    const r = convertRawEntry({
      model_name: "claude-opus-5",
      quota_type: 1,
      model_price: 60,
      model_ratio: 2.5,
      completion_ratio: 5,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
    });
    expect(r).not.toBeNull();
    // 按次价留着（网关自己的计费口径，展示要用）
    expect(r!.entry.perCallUSD).toBe(60);
    expect(r!.entry.quotaType).toBe(1);
    // token 价也留着，且与 quota_type=0 同一套公式（= 官方价 $5/$25）
    expect(r!.entry.input).toBeCloseTo(5, 6);
    expect(r!.entry.output).toBeCloseTo(25, 6);
    expect(r!.entry.cacheRead).toBeCloseTo(0.5, 6);
    expect(r!.entry.cacheWrite).toBeCloseTo(6.25, 6);
  });

  test("按次 + token 价并存时，计价热路径取的是 token 价（不再退回兜底）", () => {
    const r = convertRawEntry({
      model_name: "claude-sonnet-4-6",
      quota_type: 1,
      model_price: 36,
      model_ratio: 1.5,
      completion_ratio: 5,
    });
    // quotaType 只描述网关口径，不再是「有没有 token 价」的判据。
    expect(r!.entry.quotaType).toBe(1);
    expect(r!.entry.input).toBeCloseTo(3, 6);
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

/**
 * D6：采集端点自报的 `supported_endpoint_types`（零新增请求，同一个 /api/pricing）。
 *
 * 取值形态取自 2026-08-21 实测（该网关 68 条，7 种取值：`["openai"]` ×44、
 * `["openai","openai-response"]` ×7、`["anthropic","openai"]` ×4、`["gemini","openai"]` ×3，
 * 另有 embeddings / image-generation / jina-rerank 各若干）。
 */
describe("convertRawEntry — supported_endpoint_types（D6）", () => {
  test("原样采集网关词汇，不翻译成 protocolKind", () => {
    const r = convertRawEntry({
      model_name: "gpt-5.6-sol",
      quota_type: 0,
      model_ratio: 1,
      supported_endpoint_types: ["openai", "openai-response"],
    });
    expect(r!.entry.supportedEndpointTypes).toEqual(["openai", "openai-response"]);
  });

  test("排序归一化 —— 网关返回顺序抖动不得改变内容指纹", () => {
    const a = convertRawEntry({
      model_name: "m",
      quota_type: 0,
      model_ratio: 1,
      supported_endpoint_types: ["openai", "anthropic"],
    });
    const b = convertRawEntry({
      model_name: "m",
      quota_type: 0,
      model_ratio: 1,
      supported_endpoint_types: ["anthropic", "openai"],
    });
    expect(a!.entry.supportedEndpointTypes).toEqual(["anthropic", "openai"]);
    expect(a!.entry.supportedEndpointTypes).toEqual(b!.entry.supportedEndpointTypes);
  });

  test("按次计费（quota_type=1）同样带上 —— 协议类型与计价口径无关", () => {
    const r = convertRawEntry({
      model_name: "veo-3",
      quota_type: 1,
      model_price: 0.5,
      supported_endpoint_types: ["openai", "image-generation"],
    });
    expect(r!.entry.supportedEndpointTypes).toEqual(["image-generation", "openai"]);
  });

  test("⚠ 缺失/非法一律 undefined，**绝不是** [] —— 空数组是个更强的错断言", () => {
    // `[]` 会被读成「这个模型不支持任何协议」，而事实只是「我们没采到」。
    for (const raw of [undefined, null, "openai", 42, {}, [], ["", "  "], [1, 2]]) {
      const r = convertRawEntry({
        model_name: "m",
        quota_type: 0,
        model_ratio: 1,
        supported_endpoint_types: raw,
      });
      expect(r!.entry.supportedEndpointTypes).toBeUndefined();
    }
  });

  test("混合数组只留合法字符串项并去重", () => {
    const r = convertRawEntry({
      model_name: "m",
      quota_type: 0,
      model_ratio: 1,
      supported_endpoint_types: ["openai", 1, null, " openai ", "anthropic", ""],
    });
    expect(r!.entry.supportedEndpointTypes).toEqual(["anthropic", "openai"]);
  });

  test("不越界去碰能力字段 —— 采了协议类型不等于开了窗口的口子", () => {
    // 头部职责边界：采端点自报的事实，不采模型固有能力。实测该网关两个接口都不提供
    // contextWindow，所以这里断言的是「本模块永远不产出这个字段」。
    const r = convertRawEntry({
      model_name: "glm-5.3",
      quota_type: 0,
      model_ratio: 0.5479452,
      supported_endpoint_types: ["openai"],
    });
    expect(r!.entry).not.toHaveProperty("contextWindow");
    expect(r!.entry).not.toHaveProperty("maxOutputTokens");
  });
});

describe("derivePricingURL", () => {
  test("剥路径取 origin + /api/pricing", () => {
    expect(derivePricingURL("https://gw.example.com/v1")).toBe(
      "https://gw.example.com/api/pricing",
    );
    expect(derivePricingURL("https://gw.example.com")).toBe("https://gw.example.com/api/pricing");
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
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("同名模型不同端点桶各自计价，不互相覆盖", () => {
    writeCache({
      schema_version: 3,
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
    expect(lookupGatewayPricing("deepseek-v4-pro", "https://ali.example.com")!.input).toBeCloseTo(
      1.64,
      6,
    );
    expect(lookupGatewayPricing("deepseek-v4-pro", "https://tx.example.com")!.input).toBeCloseTo(
      1.32,
      6,
    );
  });

  test("末尾斜杠/大小写归一化后仍命中同一端点桶", () => {
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://ali.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { m: { input: 9, output: 18, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();
    // 传入带斜杠 + 大写 host，归一化后应命中。
    expect(lookupGatewayPricing("m", "https://ALI.example.com/")!.input).toBe(9);
  });

  test("端点桶未命中时跨桶按模型名兜底（冷门渠道）", () => {
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://a.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
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
      schema_version: 3,
      endpoints: {
        "https://a.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { veo: { input: 0, output: 0, quotaType: 1, perCallUSD: 1.2 } },
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
      schema_version: 3,
      endpoints: {
        "https://a.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { "free-model": { input: 0, output: 0, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();
    expect(lookupGatewayPricing("free-model", "https://a.example.com")).toBeNull();
  });
});

describe("refreshGatewayPricingOnStartup — update 后自动拉取触发策略", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;
  let fetchedURLs: string[];

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-startup-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();

    // 拦截 fetch：记录被采集的 URL，返回空 data（syncGatewayPricing 会因「无有效条目」提前返回，
    // 但已经证明它尝试了该端点——这正是我们要断言的「是否触发采集」）。
    fetchedURLs = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      fetchedURLs.push(String(url));
      return { ok: true, json: async () => ({ data: [] }) } as any;
    }) as any;
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** refreshGatewayPricingOnStartup 内部是 fire-and-forget，给微任务一点时间落地。 */
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
  }

  function writeFreshCache(endpointKey: string): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 3,
        endpoints: {
          [endpointKey]: {
            source_url: `${endpointKey}/api/pricing`,
            fetched_at: Date.now(), // 刚采集，TTL 未过期
            pricing_version: "fresh",
            models: { m: { input: 1, output: 2, quotaType: 0 } },
          },
        },
      }),
      "utf8",
    );
  }

  test("force=true（刚 update）忽略 TTL，对全部端点强制刷新", async () => {
    writeFreshCache("https://a.example.com"); // 缓存很新，TTL 未过期
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    refreshGatewayPricingOnStartup(["https://a.example.com", "https://b.example.com"], true);
    await flush();
    // 两个端点都被采集（含 TTL 未过期的 a）。
    expect(fetchedURLs).toContain("https://a.example.com/api/pricing");
    expect(fetchedURLs).toContain("https://b.example.com/api/pricing");
  });

  test("force=false（日常）TTL 未过期端点跳过，不触发采集", async () => {
    writeFreshCache("https://a.example.com");
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    refreshGatewayPricingOnStartup(["https://a.example.com"], false);
    await flush();
    // a 缓存新鲜，TTL 未过期 → 跳过，不采集。
    expect(fetchedURLs).not.toContain("https://a.example.com/api/pricing");
  });

  test("force=false 但端点从未采集过 → 仍触发采集（首次填充）", async () => {
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    refreshGatewayPricingOnStartup(["https://new.example.com"], false);
    await flush();
    expect(fetchedURLs).toContain("https://new.example.com/api/pricing");
  });

  test("端点去重 + 过滤空串：同端点只采一次，空串忽略", async () => {
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    refreshGatewayPricingOnStartup(
      ["https://x.example.com", "https://x.example.com", "", "  "],
      true,
    );
    await flush();
    const xHits = fetchedURLs.filter((u) => u === "https://x.example.com/api/pricing");
    expect(xHits.length).toBe(1);
  });

  test("空端点集合 → 无采集、不抛", async () => {
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    expect(() => refreshGatewayPricingOnStartup([], true)).not.toThrow();
    await flush();
    expect(fetchedURLs.length).toBe(0);
  });
});

/**
 * 回归：网关定价采集失败**不得泄漏到用户终端**（线上反馈）
 *
 * 症状：同事启动即在终端看到
 *   `[GATEWAY-PRICING] 采集失败，保留旧缓存 { "error": "AbortError: ..." }`
 *
 * 两个独立根因，各锁一个：
 *  1. logger 换实例：本模块在 cli.ts → config.ts → cost-tracker.ts → 本模块 这条**静态
 *     导入链**上，求值早于 initLogger()。旧 initLogger 每次 `new Logger()`，模块级
 *     `const log = getLogger()` 便永久冻住 enabled=false 的兜底实例，其 WARN 走
 *     logger.log() 的 stderr 兜底分支直接打到终端且不写 audit.log。
 *  2. 级别选错：定价采集是纯优化项（失败仅退回注册表估价），对用户不可行动 → 应为 debug。
 */
describe("采集失败不泄漏到终端（回归）", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-leak-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("initLogger 恒返回同一实例：早期 getLogger() 捕获不会被冻在兜底实例上", async () => {
    const { getLogger, initLogger, LogLevel } = await import("@sid-code/core/debug/logger.ts");
    // 模拟静态导入链上的模块级捕获（发生在 initLogger 之前）
    const captured = getLogger();
    const after = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile: join(tmpDir, "audit.log"),
      console: false,
      fileOnly: true,
    });
    expect(captured).toBe(after); // 换实例就是本 bug 的根因
    initLogger({ enabled: false }); // 复位，避免污染其他测试
  });

  test("超时失败：reason 说人话（含阈值），不再是裸 AbortError", async () => {
    const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
    // 永挂的 fetch，只响应 abort → 必然走超时分支
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err: any = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      })) as any;

    const r = await syncGatewayPricing({ baseURL: "https://slow.example.com", timeoutMs: 30 });
    expect(r.updated).toBe(false);
    expect(r.reason).toContain("采集超时");
    expect(r.reason).toContain("30ms");
    expect(r.reason).toContain("SID_CODE_GATEWAY_PRICING_TIMEOUT_MS");
    expect(r.reason).not.toContain("AbortError");
  });

  test("采集失败只落 debug，不进 WARN 审计流（终端零输出的前提）", async () => {
    const { initLogger, LogLevel } = await import("@sid-code/core/debug/logger.ts");
    const auditFile = join(tmpDir, "audit.log");
    // 还原生产 audit logger：level=WARN + fileOnly，文件写所有级别
    initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile: auditFile,
      console: false,
      fileOnly: true,
      append: true,
    });

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
    const r = await syncGatewayPricing({ baseURL: "https://down.example.com", timeoutMs: 500 });
    expect(r.updated).toBe(false);

    // 等 WriteStream 落盘
    await new Promise((res) => setTimeout(res, 60));
    const { readFileSync, existsSync } = await import("node:fs");
    const content = existsSync(auditFile) ? readFileSync(auditFile, "utf8") : "";
    // debug 级会写进文件，但**不带 WARN 标记**——终端泄漏走的正是 WARN 兜底路径
    expect(content).not.toContain("⚠ [GATEWAY-PRICING]");
    initLogger({ enabled: false });
  });
});

/**
 * 失败负缓存（failure backoff）—— 修复「端点长期不可达仍每次启动重试」
 *
 * 修复前：只有成功才写 fetched_at，失败什么都不记 → 不可达端点每次启动都重来。
 * 团队默认配置有 3 个端点 = 每次启动 3 个并发请求各白烧一个 15s socket，且永不退避。
 */
describe("失败负缓存 — 不可达端点不再每次启动重试", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-negcache-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const flush = () => new Promise((r) => setTimeout(r, 40));
  const OK_DATA = {
    data: [{ model_name: "m1", quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
  };

  test("指数退避：5min→10min→20min…封顶 24h，0 次失败不退避", async () => {
    const { computeFailureBackoffMs } = await import("@sid-code/core/llm/gateway-pricing.ts");
    expect(computeFailureBackoffMs(0)).toBe(0);
    expect(computeFailureBackoffMs(1)).toBe(5 * 60_000);
    expect(computeFailureBackoffMs(2)).toBe(10 * 60_000);
    expect(computeFailureBackoffMs(3)).toBe(20 * 60_000);
    expect(computeFailureBackoffMs(99)).toBe(24 * 60 * 60_000); // 封顶
  });

  test("核心回归：连续 5 次启动只发 1 次请求（修复前 5 次）", async () => {
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    let hits = 0;
    globalThis.fetch = (async () => {
      hits++;
      throw new Error("ECONNREFUSED");
    }) as any;
    for (let i = 0; i < 5; i++) {
      __resetGatewayPricingForTest();
      refreshGatewayPricingOnStartup(["https://dead.example.com"], false);
      await flush();
    }
    expect(hits).toBe(1);
  });

  test("多端点各自独立退避：坏端点冷却不影响好端点采集", async () => {
    const { refreshGatewayPricingOnStartup } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    const seen: string[] = [];
    globalThis.fetch = (async (u: any) => {
      seen.push(String(u));
      if (String(u).includes("dead")) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => OK_DATA } as any;
    }) as any;

    refreshGatewayPricingOnStartup(["https://dead.example.com", "https://good.example.com"], false);
    await flush();
    // 第二次启动：坏端点进冷却被跳过；好端点已成功且 TTL 内也跳过
    const before = seen.length;
    __resetGatewayPricingForTest();
    refreshGatewayPricingOnStartup(["https://dead.example.com", "https://good.example.com"], false);
    await flush();
    expect(seen.length).toBe(before);
    expect(seen.filter((u) => u.includes("dead")).length).toBe(1);
    expect(seen.filter((u) => u.includes("good")).length).toBe(1);
  });

  test("失败不抹掉上次成功采到的价格（负缓存只加字段）", async () => {
    const { syncGatewayPricing, lookupGatewayPricing } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    const EP = "https://flip.example.com";
    globalThis.fetch = (async () => ({ ok: true, json: async () => OK_DATA })) as any;
    await syncGatewayPricing({ baseURL: EP });
    expect(lookupGatewayPricing("m1", EP)).not.toBeNull();

    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as any;
    await syncGatewayPricing({ baseURL: EP, timeoutMs: 200 });
    __resetGatewayPricingForTest();
    // 失败后价格仍在（计费不受影响，这是"纯优化项"的应有语义）
    expect(lookupGatewayPricing("m1", EP)).not.toBeNull();
  });

  test("force=true 突破冷却（update / 手动 discover 的明确意图优先）", async () => {
    const { syncGatewayPricing, refreshGatewayPricingOnStartup, getFailureCooldownRemainingMs } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    const EP = "https://recover.example.com";
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as any;
    await syncGatewayPricing({ baseURL: EP, timeoutMs: 200 });
    expect(getFailureCooldownRemainingMs(EP)).toBeGreaterThan(0);

    let hits = 0;
    globalThis.fetch = (async () => {
      hits++;
      return { ok: true, json: async () => OK_DATA } as any;
    }) as any;
    __resetGatewayPricingForTest();
    refreshGatewayPricingOnStartup([EP], true); // force
    await flush();
    expect(hits).toBe(1);
    expect(getFailureCooldownRemainingMs(EP)).toBe(0); // 成功清零
  });

  test("边界：恢复后价格恰好未变，也必须清掉失败态（否则永久锁死）", async () => {
    const { syncGatewayPricing, getFailureCooldownRemainingMs } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    const EP = "https://same.example.com";
    globalThis.fetch = (async () => ({ ok: true, json: async () => OK_DATA })) as any;
    await syncGatewayPricing({ baseURL: EP }); // 成功，记下 version
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as any;
    await syncGatewayPricing({ baseURL: EP, timeoutMs: 200 }); // 失败，建立冷却
    expect(getFailureCooldownRemainingMs(EP)).toBeGreaterThan(0);

    // 端点恢复，返回**完全相同**的数据 → version 未变，旧逻辑会走"跳过写盘"从而永远留着失败态
    globalThis.fetch = (async () => ({ ok: true, json: async () => OK_DATA })) as any;
    await syncGatewayPricing({ baseURL: EP });
    expect(getFailureCooldownRemainingMs(EP)).toBe(0);
  });

  test("时钟回拨（failed_at 在未来）不永久锁死", async () => {
    const { getFailureCooldownRemainingMs } = await import("@sid-code/core/llm/gateway-pricing.ts");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      sidPaths.gatewayPricing(),
      JSON.stringify({
        schema_version: 3,
        endpoints: {
          "https://clock.example.com": {
            source_url: "x",
            fetched_at: 0,
            pricing_version: "v",
            models: {},
            failed_at: Date.now() + 10 * 60 * 60 * 1000,
            fail_count: 5,
          },
        },
      }),
    );
    expect(getFailureCooldownRemainingMs("https://clock.example.com")).toBe(0);
  });

  test("HTTP 非 2xx 与「解析后无有效条目」同样计入退避", async () => {
    const { syncGatewayPricing, getFailureCooldownRemainingMs } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    globalThis.fetch = (async () => ({ ok: false, status: 502 })) as any;
    await syncGatewayPricing({ baseURL: "https://e502.example.com" });
    expect(getFailureCooldownRemainingMs("https://e502.example.com")).toBeGreaterThan(0);

    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: [] }) })) as any;
    await syncGatewayPricing({ baseURL: "https://empty.example.com" });
    expect(getFailureCooldownRemainingMs("https://empty.example.com")).toBeGreaterThan(0);
  });
});

/**
 * D7：原子落盘（tmp → rename）。
 *
 * ⚠ 这一组锁的是「半截 JSON 不会落到目标路径」，**不是**「并发不丢更新」——
 * 那是两件不同的事。本模块两个写点本来就是 read-modify-write（读盘 → 只改本端点桶 → 写回），
 * 缺的一直只是原子写；`model-capabilities.ts` 的缺口正好相反（早有原子写、从不重读）。
 * 别照着方案文档 §6.2 原文给这里补重读，那是补一个它已经有的东西。
 *
 * 半截 JSON 的实际后果是**整份缓存作废**（含所有其他端点桶），因为 readCacheFile 的
 * JSON.parse 一抛错就 return null → 全部渠道退回兜底计价，且不报错。
 */
describe("原子落盘 tmp → rename（D7）", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-atomic-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * 判据是 **inode 必须变**，不是「.tmp 不残留」。
   *
   * ⚠ 「.tmp 不残留」是个 false gate：直写路径也不会留下 .tmp，所以那个断言在退回
   * `writeFileSync(path, ...)` 之后照样全绿（实测变异 40 pass / 0 fail）。
   * `rename` 是把新文件**替换**上去，目标路径换成一个新 inode；直写是在原 inode 上
   * truncate + 写入 —— 那个 truncate 到写完之间的窗口正是半截 JSON 的来源。
   * 所以 inode 变化是唯一能机械区分两种写法的可观测量。
   */
  test("采集成功走 rename：目标 inode 必须变（直写会保持原 inode）", async () => {
    const path = sidPaths.gatewayPricing();
    mkdirSync(tmpDir, { recursive: true });
    // 先放一个占位文件，拿到写入前的 inode。
    writeFileSync(path, JSON.stringify({ schema_version: 3, endpoints: {} }), "utf8");
    const inodeBefore = statSync(path).ino;

    const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            model_name: "m1",
            quota_type: 0,
            model_ratio: 1,
            completion_ratio: 2,
            supported_endpoint_types: ["openai", "openai-response"],
          },
        ],
      }),
    })) as any;
    await syncGatewayPricing({ baseURL: "https://atomic.example.com" });

    expect(statSync(path).ino).not.toBe(inodeBefore);
    expect(existsSync(`${path}.tmp`)).toBe(false); // rename 后临时文件不该留下
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schema_version).toBe(3);
    // D6 字段必须真的落到磁盘（只在内存里等于没采，见 computeVersion 的注释）。
    expect(parsed.endpoints["https://atomic.example.com"].models.m1.supportedEndpointTypes).toEqual(
      ["openai", "openai-response"],
    );
  });

  test("失败负缓存（recordFailure）同样走 rename：inode 必须变", async () => {
    const path = sidPaths.gatewayPricing();
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: 3, endpoints: {} }), "utf8");
    const inodeBefore = statSync(path).ino;

    const { syncGatewayPricing, getFailureCooldownRemainingMs } =
      await import("@sid-code/core/llm/gateway-pricing.ts");
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    await syncGatewayPricing({ baseURL: "https://down.example.com" });

    expect(statSync(path).ino).not.toBe(inodeBefore);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    expect(getFailureCooldownRemainingMs("https://down.example.com")).toBeGreaterThan(0);
  });

  test("半截 JSON 会让整份缓存作废 —— 这就是原子写要防的后果（现状锁定）", () => {
    // 手工制造一个被截断的文件，模拟「写到一半被杀」。断言的是**后果**而非实现：
    // 一个端点桶的半截文件会让所有端点桶一起查不到。
    mkdirSync(tmpDir, { recursive: true });
    const full = JSON.stringify({
      schema_version: 3,
      endpoints: {
        "https://a.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { "ali-m1": { input: 1, output: 2, quotaType: 0 } },
        },
        "https://b.example.com": {
          source_url: "y",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { "tx-m2": { input: 3, output: 4, quotaType: 0 } },
        },
      },
    });
    writeFileSync(sidPaths.gatewayPricing(), full.slice(0, Math.floor(full.length / 2)), "utf8");
    __resetGatewayPricingForTest();
    loadGatewayCache();
    // 两个桶都查不到 —— 一次误杀换来所有渠道的错价。
    expect(lookupGatewayPricing("ali-m1", "https://a.example.com")).toBeNull();
    expect(lookupGatewayPricing("tx-m2", "https://b.example.com")).toBeNull();
    expect(getGatewayCacheMeta()).toBeNull();
  });

  test("supportedEndpointTypes 变了必须触发写盘 —— 否则新字段永远进不了磁盘", async () => {
    const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
    const mk = (types?: string[]) =>
      (async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              model_name: "m1",
              quota_type: 0,
              model_ratio: 1,
              completion_ratio: 2,
              ...(types ? { supported_endpoint_types: types } : {}),
            },
          ],
        }),
      })) as any;

    // 第一次：不带该字段（模拟老用户盘上已有的缓存）。
    globalThis.fetch = mk();
    const first = await syncGatewayPricing({ baseURL: "https://ver.example.com" });
    expect(first.updated).toBe(true);

    // 第二次：价格完全不变，只多了协议类型。指纹若不覆盖这个字段，
    // 就会走「版本未变，跳过写盘」→ 磁盘上永远没有它。
    globalThis.fetch = mk(["openai", "openai-response"]);
    const second = await syncGatewayPricing({ baseURL: "https://ver.example.com" });
    expect(second.updated).toBe(true);
    expect(second.version).not.toBe(first.version);

    const parsed = JSON.parse(readFileSync(sidPaths.gatewayPricing(), "utf8"));
    expect(parsed.endpoints["https://ver.example.com"].models.m1.supportedEndpointTypes).toEqual([
      "openai",
      "openai-response",
    ]);
  });

  test("同一份数据重复采集仍判「未变」—— 排序归一化保证指纹稳定", async () => {
    const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
    const mk = (types: string[]) =>
      (async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              model_name: "m1",
              quota_type: 0,
              model_ratio: 1,
              completion_ratio: 2,
              supported_endpoint_types: types,
            },
          ],
        }),
      })) as any;

    globalThis.fetch = mk(["openai", "anthropic"]);
    const first = await syncGatewayPricing({ baseURL: "https://stable.example.com" });
    // 网关换了个返回顺序：内容没变，不该触发无谓写盘。
    globalThis.fetch = mk(["anthropic", "openai"]);
    const second = await syncGatewayPricing({ baseURL: "https://stable.example.com" });
    expect(second.version).toBe(first.version);
    expect(second.updated).toBe(false);
  });
});

describe("按次价与 token 价并存 —— 查找 / 约束 / 存量缓存迁移（2026-09-08 修复）", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;

  function writeCache(file: unknown): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(sidPaths.gatewayPricing(), JSON.stringify(file), "utf8");
  }

  /** 造一个 v3 双桶缓存：uniapi 桶没有 sonnet-4-6，ppchat 桶有（按次 $36）。 */
  function writeTwoBuckets(): void {
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://uniapi.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "u",
          models: { "claude-opus-5": { input: 3.5, output: 17.5, quotaType: 0 } },
        },
        "https://ppchat.example.com": {
          source_url: "y",
          fetched_at: Date.now(),
          pricing_version: "p",
          models: {
            "claude-sonnet-4-6": { input: 3, output: 15, quotaType: 1, perCallUSD: 36 },
            "claude-sonnet-5": { input: 1.4, output: 7, quotaType: 1, perCallUSD: 36 },
          },
        },
      },
    });
    loadGatewayCache();
  }

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-percall-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("核心回归：按次价查询受「裸名禁止跨桶」约束（修前显示别的端点的 $36/次）", () => {
    // 实测事故：claude-sonnet-4-6 配在 uniapi（该桶里没有它），面板却显示 $36.00/次
    // —— 那个数来自 ppchat 桶。它是注册表裸名（官方 $3/$15），本就不该跨桶借价。
    writeTwoBuckets();
    expect(
      lookupGatewayPerCallUSD("claude-sonnet-4-6", "https://uniapi.example.com"),
    ).toBeUndefined();
    // 自己端点上仍照常拿到（约束只管跨桶，不影响精确命中）
    expect(lookupGatewayPerCallUSD("claude-sonnet-4-6", "https://ppchat.example.com")).toBe(36);
  });

  test("token 价查询与按次价查询共用同一套约束（两条路径不许分叉）", () => {
    writeTwoBuckets();
    // 同一个裸名、同一个端点：两个入口必须给出一致的「借不到」结论。
    expect(lookupGatewayPricing("claude-sonnet-4-6", "https://uniapi.example.com")).toBeNull();
    expect(
      lookupGatewayPerCallUSD("claude-sonnet-4-6", "https://uniapi.example.com"),
    ).toBeUndefined();
  });

  test("别名 miss 时按真名重查（网关按真名入库，配置侧是别名）", () => {
    // claude-sonnet-5-ppchat --model_id--> claude-sonnet-5。修前只按别名查 → 必然 miss
    // → 注册表也没有这个新模型 → 落 FALLBACK $2/$10（实测污染 20/21 条账本记录）。
    writeTwoBuckets();
    const ep = "https://ppchat.example.com";
    expect(lookupGatewayPricing("claude-sonnet-5-ppchat", ep)).toBeNull(); // 不传真名：维持旧行为
    const withWire = lookupGatewayPricing("claude-sonnet-5-ppchat", ep, "claude-sonnet-5");
    expect(withWire).not.toBeNull();
    expect(withWire!.input).toBeCloseTo(1.4, 6);
    expect(lookupGatewayPerCallUSD("claude-sonnet-5-ppchat", ep, "claude-sonnet-5")).toBe(36);
  });

  test("别名优先于真名 —— 渠道差价不许被真名抹平", () => {
    // 两个键都在同一个桶里时，必须命中别名那条（它才是"这条渠道的价"）。
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://gw.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: {
            "cheap-channel": { input: 0.5, output: 1, quotaType: 0 },
            "claude-opus-5": { input: 3.5, output: 17.5, quotaType: 0 },
          },
        },
      },
    });
    loadGatewayCache();
    const hit = lookupGatewayPricing("cheap-channel", "https://gw.example.com", "claude-opus-5");
    expect(hit!.input).toBeCloseTo(0.5, 6); // 别名价，不是真名价
  });

  test("真名是裸名时仍不得跨桶借价（逐名判，不是「任一裸名就整体放弃」）", () => {
    // 别名 `gw-claude-sonnet-4-6`（自定义名，可跨桶）+ 真名 `claude-sonnet-4-6`（裸名，不可跨桶）。
    // 桶里只有真名那条 → 跨桶时必须拦住真名，回落注册表。
    writeTwoBuckets();
    expect(
      lookupGatewayPricing(
        "gw-claude-sonnet-4-6",
        "https://uniapi.example.com",
        "claude-sonnet-4-6",
      ),
    ).toBeNull();
  });

  test("本端点自报零价时不跨桶借价（刻意的行为变化）", () => {
    // 修前步骤 1 先过 toModelPricing，零价 → 判成"没命中" → 继续跨桶，于是一个
    // 自报免费的内部渠道会静默套上另一个网关的收费价（虚高且不报错）。
    // 现在「本桶里有这个模型」就是该端点的权威事实，命中即停。
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://free.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { "my-channel": { input: 0, output: 0, quotaType: 0 } },
        },
        "https://paid.example.com": {
          source_url: "y",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { "my-channel": { input: 9, output: 18, quotaType: 0 } },
        },
      },
    });
    loadGatewayCache();
    // 零价不能用于计价（toModelPricing 判 input > 0）→ null，但**不是**借来的 $9。
    expect(lookupGatewayPricing("my-channel", "https://free.example.com")).toBeNull();
    // 对照：没有这个模型的第三个端点才允许跨桶借价（约束未被放宽）。
    expect(lookupGatewayPricing("my-channel", "https://other.example.com")!.input).toBe(9);
  });

  test("纯按次条目：按次价可读，但计价热路径仍返回 null（退回注册表）", () => {
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://a.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "v",
          models: { "doubao-seedream": { input: 0, output: 0, quotaType: 1, perCallUSD: 2 } },
        },
      },
    });
    loadGatewayCache();
    expect(lookupGatewayPricing("doubao-seedream", "https://a.example.com")).toBeNull();
    expect(lookupGatewayPerCallUSD("doubao-seedream", "https://a.example.com")).toBe(2);
  });

  test("存量 v2 缓存被标记过期（fetched_at=0）以触发重采，但价格不清空", () => {
    // v2 是 bug 产物：quotaType=1 条目的 token 价已被置 0，与"真的只有按次价"同形，
    // 无法就地修复 → 只能标记过期让 TTL 判据触发重采；清空 models 会换来另一次静默低估。
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://gw.example.com": {
          source_url: "x",
          fetched_at: Date.now(),
          pricing_version: "old",
          models: { "claude-opus-5": { input: 0, output: 0, quotaType: 1, perCallUSD: 60 } },
        },
      },
    });
    const meta = getGatewayCacheMeta("https://gw.example.com");
    expect(meta!.fetchedAt).toBe(0); // 过期 → refreshGatewayPricingOnStartup 必然重采
    expect(meta!.count).toBe(1); // 价格仍在，重采完成前不至于落兜底
  });

  test("v3 缓存不被误标过期（迁移只针对旧版本）", () => {
    const now = Date.now();
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://gw.example.com": {
          source_url: "x",
          fetched_at: now,
          pricing_version: "new",
          models: { m: { input: 1, output: 2, quotaType: 0 } },
        },
      },
    });
    expect(getGatewayCacheMeta("https://gw.example.com")!.fetchedAt).toBe(now);
  });

  test("失败负缓存在 v2 迁移中保留（端点可达性与换算 bug 无关）", () => {
    writeCache({
      schema_version: 2,
      endpoints: {
        "https://dead.example.com": {
          source_url: "x",
          fetched_at: 0,
          pricing_version: "",
          models: {},
          failed_at: Date.now(),
          fail_count: 7,
        },
      },
    });
    loadGatewayCache();
    // 抹掉退避状态会让不可达端点重新每次启动白烧 socket，所以必须留着。
    expect(getFailureCooldownRemainingMs("https://dead.example.com")).toBeGreaterThan(0);
  });
});

/**
 * `billing_expr` 口径迁移 —— 回归 + 门禁（2026-09-17）
 *
 * 事故：`origin-deepseek-v4-1-flash` 采到 `$75/$75`（比 Claude Opus 贵 15 倍的不可能价），
 * 且 `cacheRead` 整格缺失 → 下游落 `input × 0.1` 兜底 = $7.5，而真值 $0.00274 ⇒ 该格高报 2738×。
 *
 * 根因不是"上游给了占位假数"，是**上游给了真数、而我们读的是另一个字段**：网关已把计费
 * 口径迁到 `billing_mode: "tiered_expr"` + `billing_expr`，旧字段 `model_ratio` 一族
 * 停止维护（实测 12 条里旧值与 expr 三格全一致的只剩 1 条）。
 *
 * 下面的夹具全部是 **2026-09-17 从网关 `/api/pricing` 实拉的原始记录**（未改一位数字）——
 * 手编夹具测不出这个 bug：它的形态恰恰是"两套价并列，我们读了停止维护的那套"。
 */
describe("billing_expr 口径（tiered_expr）", () => {
  // 落盘隔离：本组会写 ~/.sid-code/gateway-pricing.json。重定向 SID_CONFIG_DIR 到 tmpdir，
  // 且**存/恢复原值**而非无条件 delete —— 同批多文件跑在同一进程里，无条件 delete
  // 会把 bunfig preload 的兜底一起抹掉（见 CONTRIBUTING.md 测试约定）。
  let tmpDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-expr-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    __resetGatewayPricingForTest();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  });

  function writeCache(file: unknown): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(sidPaths.gatewayPricing(), JSON.stringify(file), "utf8");
  }

  /**
   * 取「这批 models 落盘后的内容指纹」—— 经 syncGatewayPricing 的真实路径拿版本号。
   *
   * ⚠ 刻意不直接测 computeVersion（它没导出，也不该为测试而导出）：指纹的意义在于
   * **决定要不要写盘**，所以判据必须落在那条真实路径上。这里拦 fetch 喂原始记录，
   * 读回落盘文件里的 pricing_version。
   */
  async function versionOf(raws: unknown[]): Promise<string> {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: raws }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    try {
      const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
      const r = await syncGatewayPricing({ baseURL: "https://ver.example.com", force: true });
      return r.version;
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  /** 实拉原始记录：`model_ratio: 37.5` ⇒ 旧公式算出 $75/1M，且**无 cache_ratio**。 */
  const RAW_FLASH_1 = {
    model_name: "origin-deepseek-v4-1-flash",
    quota_type: 0,
    model_ratio: 37.5,
    completion_ratio: 1,
    billing_mode: "tiered_expr",
    billing_expr:
      '(tier("base", p * 0.1369863 + c * 0.547945205 + cr * 0.00273972602)) * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 ? 2 : 1) * (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18 ? 2 : 1)',
  };
  /** 实拉原始记录：`ali-*` 渠道是**8-22 单窗口**，与厂商级 9-12/14-18 完全不同。 */
  const RAW_ALI_PRO = {
    model_name: "ali-deepseek-v4-pro",
    quota_type: 0,
    model_ratio: 0.452054795,
    completion_ratio: 2,
    cache_ratio: 0.083333337942,
    billing_mode: "tiered_expr",
    billing_expr:
      '(tier("base", p * 0.616438356 + c * 1.849315068 + cr * 0.061643835)) * (hour("Asia/Shanghai") >= 8 && hour("Asia/Shanghai") < 22 ? 2 : 1)',
  };

  test("门禁自证：修复前的错值确实会被这组断言拦住", () => {
    // 没有这条自证，下面那些 toBeCloseTo 可能是在锁一个想象中的实现 ——
    // 判据是「旧口径算出来的数是多少」，而它必须与新断言的期望值差到离谱。
    const legacyInput = RAW_FLASH_1.model_ratio * 2; // 旧公式：model_ratio × 2
    expect(legacyInput).toBe(75);
    const parsed = parseBillingExpr(RAW_FLASH_1.billing_expr)!;
    // 高报 273×：任何"量级哨兵"之外的判据都必须能区分这两个数。
    expect(legacyInput / parsed.input).toBeGreaterThan(200);
    // 旧字段**没有** cache_ratio ⇒ 修复前 cacheRead 缺失 ⇒ 下游落 input×0.1 = 7.5。
    expect((RAW_FLASH_1 as { cache_ratio?: number }).cache_ratio).toBeUndefined();
    expect((legacyInput * 0.1) / parsed.cacheRead).toBeGreaterThan(1000);
  });

  test("有 expr 时以 expr 为准（而不是等于 legacy 值）", () => {
    // ⚠ 判据刻意写成「等于 expr、且不等于 legacy」两条 ——
    // 只断言"等于 expr"的话，上游哪天把旧字段修对了这条测试仍绿，
    // 但我们究竟读了哪一套字段就再也测不出来了。
    const r = convertRawEntry(RAW_FLASH_1)!;
    expect(r.entry.priceSource).toBe("expr");
    // 高峰价 = 空闲系数 × 2（存高峰、空闲由 offPeakMultiplier 派生，与 ModelPricing 口径一致）
    expect(r.entry.input).toBeCloseTo(0.2739726, 9);
    expect(r.entry.output).toBeCloseTo(1.09589041, 9);
    expect(r.entry.cacheRead!).toBeCloseTo(0.00547945204, 11);
    expect(r.entry.input).not.toBeCloseTo(75, 1);
  });

  test("⛔ 不套 RATIO_TO_USD_PER_M：expr 系数已是 USD/1M", () => {
    // 套上去会让 12 条整体**高报一倍**，且方向一致、不被"正负抵消"掩护 ——
    // 比现状（高报 500 倍）更难发现，因为看起来只是"贵了点"。
    const r = convertRawEntry(RAW_FLASH_1)!;
    const idleCoef = 0.1369863;
    expect(r.entry.input).toBeCloseTo(idleCoef * 2, 9); // ×2 是**高峰倍率**，不是基准单位
    expect(r.entry.input).not.toBeCloseTo(idleCoef * 4, 6); // 若误套基准单位就会是这个数
  });

  test("cacheRead 不再缺失 —— 下游 input×0.1 兜底不再触发", () => {
    // 这是本次事故的**主放大器**：实测某会话 cache 命中占 95.7% token，
    // 成本几乎完全由这一格决定。
    const r = convertRawEntry(RAW_FLASH_1)!;
    expect(r.entry.cacheRead).toBeDefined();
    expect(r.entry.cacheRead!).toBeLessThan(r.entry.input * 0.1);
  });

  test("窗口逐条从 expr 解，渠道级而非厂商级（ali-* 是 8-22 单窗口）", () => {
    const flash = convertRawEntry(RAW_FLASH_1)!;
    // 北京 9-12 / 14-18 → UTC 1-4 / 6-10
    expect(flash.entry.peakWindows).toEqual([
      { startHour: 1, endHour: 4 },
      { startHour: 6, endHour: 10 },
    ]);
    const ali = convertRawEntry(RAW_ALI_PRO)!;
    // 北京 8-22 → UTC 0-14（单窗口）。用厂商级常量套这条会让北京 12-14 与 18-22
    // 判成空闲按半价记，而网关按高峰收全价。
    expect(ali.entry.peakWindows).toEqual([{ startHour: 0, endHour: 14 }]);
    expect(ali.entry.offPeakMultiplier).toBe(0.5);
  });

  test("窗口与折扣透传到 ModelPricing（防「采到了但没接进消费路径」）", () => {
    // 漏掉透传的失效是静默的：缓存里字段齐全、日志报成功，计价侧却拿不到窗口
    // ⇒ 整条按高峰价算。所以判据必须落在**计价入口**上，不能只看 entry。
    writeCache({
      schema_version: 3,
      endpoints: {
        "https://gw.example.com": {
          source_url: "https://gw.example.com/api/pricing",
          fetched_at: Date.now(),
          pricing_version: "expr",
          models: { [RAW_FLASH_1.model_name]: convertRawEntry(RAW_FLASH_1)!.entry },
        },
      },
    });
    loadGatewayCache();
    const p = lookupGatewayPricing(RAW_FLASH_1.model_name, "https://gw.example.com")!;
    expect(p.peakWindows?.length, "窗口未透传到计价路径").toBe(2);
    expect(p.offPeakMultiplier).toBe(0.5);
  });

  test("无 expr 的条目行为逐字节不变（56/68 条走旧公式）", () => {
    // 这条钉住"不回归"：绝大多数条目根本没有 expr，旧公式对它们仍然成立。
    const r = convertRawEntry({
      model_name: "claude-opus-4-8",
      quota_type: 0,
      model_ratio: 2.5,
      completion_ratio: 5,
      cache_ratio: 0.1,
    })!;
    expect(r.entry.input).toBeCloseTo(5, 6);
    expect(r.entry.output).toBeCloseTo(25, 6);
    expect(r.entry.cacheRead!).toBeCloseTo(0.5, 6);
    expect(r.entry.priceSource).toBe("legacy_ratio");
    expect(r.entry.peakWindows).toBeUndefined();
  });

  test("解析失败退回旧字段，而不是丢弃整条", () => {
    // 丢弃会让这批模型集体落 FALLBACK $2/$10 —— 把一次静默错算换成另一次。
    const r = convertRawEntry({
      model_name: "weird",
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 2,
      billing_mode: "tiered_expr",
      billing_expr: "something we do not understand",
    })!;
    expect(r.entry.input).toBeCloseTo(2, 6); // 1 × RATIO_TO_USD_PER_M
    expect(r.entry.priceSource).toBe("legacy_ratio");
  });

  describe("parseBillingExpr — 拒绝解析的边界（每条都对应一个静默错算）", () => {
    test("三格不全 → null（缺 cr 时若部分成功，下游落 input×0.1 高报数千倍）", () => {
      expect(
        parseBillingExpr(
          '(tier("base", p * 0.1 + c * 0.2)) * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 ? 2 : 1)',
        ),
      ).toBeNull();
    });

    test("时区不是 Asia/Shanghai → null（当 +8 硬算等于用编造假设覆盖「我不知道」）", () => {
      expect(
        parseBillingExpr(
          '(tier("base", p * 0.1 + c * 0.2 + cr * 0.01)) * (hour("America/New_York") >= 9 && hour("America/New_York") < 12 ? 2 : 1)',
        ),
      ).toBeNull();
    });

    test("多窗口倍率不一致 → null（那是「分档」而非「分时段」，本模型表达不了）", () => {
      expect(
        parseBillingExpr(
          '(tier("base", p * 0.1 + c * 0.2 + cr * 0.01)) * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 ? 2 : 1) * (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18 ? 3 : 1)',
        ),
      ).toBeNull();
    });

    test("input 系数为 0 → null（入库会顶掉注册表兜底，让计费静默归零）", () => {
      expect(parseBillingExpr('(tier("base", p * 0 + c * 0.2 + cr * 0.01))')).toBeNull();
    });

    test("无窗口段 → 系数即唯一价，倍率 1（不是拒绝解析）", () => {
      const r = parseBillingExpr('(tier("base", p * 0.5 + c * 1.5 + cr * 0.05))')!;
      expect(r.input).toBeCloseTo(0.5, 9);
      expect(r.peakWindows).toEqual([]);
      expect(r.offPeakMultiplier).toBe(1);
    });

    test("非字符串 / 空串 → null", () => {
      expect(parseBillingExpr(undefined)).toBeNull();
      expect(parseBillingExpr("")).toBeNull();
      expect(parseBillingExpr(42)).toBeNull();
    });
  });

  test("新增字段进内容指纹（否则窗口永远写不进磁盘）", async () => {
    // 失效形态：上游把口径切到 expr，而换算出的三格价恰好与旧字段一致 → 指纹相同 →
    // 走「版本未变，跳过写盘」→ 窗口与 priceSource 永远不落盘，
    // 内存里有、日志报成功、下次启动又没了。
    //
    // 夹具刻意构造成「三格价完全相同、只差有没有窗口」：这正是漏掉指纹字段时
    // 唯一测不出来的那种差异。
    const SAME_PRICE_NO_WINDOW = {
      model_name: "same-price",
      quota_type: 0,
      billing_mode: "tiered_expr",
      billing_expr: '(tier("base", p * 1.2 + c * 3.6 + cr * 0.12))',
    };
    const SAME_PRICE_WITH_WINDOW = {
      model_name: "same-price",
      quota_type: 0,
      billing_mode: "tiered_expr",
      // 系数减半 + ×2 高峰倍率 ⇒ 三格高峰价与上面逐位相同，唯一差别是多了窗口。
      billing_expr:
        '(tier("base", p * 0.6 + c * 1.8 + cr * 0.06)) * (hour("Asia/Shanghai") >= 8 && hour("Asia/Shanghai") < 22 ? 2 : 1)',
    };
    const a = convertRawEntry(SAME_PRICE_NO_WINDOW)!.entry;
    const b = convertRawEntry(SAME_PRICE_WITH_WINDOW)!.entry;
    // 先证明夹具确实"只差窗口"—— 否则这条测试可能是靠价格差通过的（假绿）。
    expect(b.input).toBeCloseTo(a.input, 9);
    expect(b.output).toBeCloseTo(a.output, 9);
    expect(b.cacheRead!).toBeCloseTo(a.cacheRead!, 9);
    expect(a.peakWindows).toBeUndefined();
    expect(b.peakWindows).toEqual([{ startHour: 0, endHour: 14 }]);

    const verA = await versionOf([SAME_PRICE_NO_WINDOW]);
    const verB = await versionOf([SAME_PRICE_WITH_WINDOW]);
    expect(verA).not.toBe(verB);
  });
});

/**
 * 量级哨兵（D4）+ 上游 pricing_version（D7）—— 2026-09-17
 *
 * 两者都是**防线加固**，不是主修法：主修法是认 `billing_expr`（见上一组）。
 * 分开测是因为它们各自能兜住的东西不同，混在一起会让"哪条防线在起作用"说不清。
 */
describe("量级哨兵与上游口径版本", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "gw-sentinel-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    origFetch = globalThis.fetch;
    __resetGatewayPricingForTest();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    __resetGatewayPricingForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  });

  /** 拦 fetch 返回给定 body（模拟网关 /api/pricing）。 */
  function stubPricing(body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
  }

  function readBucket(endpointKey: string): Record<string, any> {
    const file = JSON.parse(readFileSync(sidPaths.gatewayPricing(), "utf8"));
    return file.endpoints[endpointKey];
  }

  test("量级可疑的条目不入库（$75/1M 比 Opus 贵 15 倍，物理不可能）", async () => {
    // 这一条模拟"expr 解析失败 + 旧字段也离谱"的复合场景 —— 哨兵存在的唯一理由。
    // 没有 billing_mode，所以走 legacy 口径，37.5 × 2 = 75。
    stubPricing({
      data: [
        { model_name: "insane-price", quota_type: 0, model_ratio: 37.5, completion_ratio: 1 },
        { model_name: "sane-price", quota_type: 0, model_ratio: 2.5, completion_ratio: 5 },
      ],
    });
    const r = await syncGatewayPricing({ baseURL: "https://s.example.com", force: true });
    expect(r.count, "可疑条目应被丢弃，只剩 1 条").toBe(1);
    loadGatewayCache();
    expect(lookupGatewayPricing("insane-price", "https://s.example.com")).toBeNull();
    // 合法条目不受影响 —— 哨兵不能顺手把正常价也拦掉。
    expect(lookupGatewayPricing("sane-price", "https://s.example.com")?.input).toBeCloseTo(5, 6);
  });

  test("哨兵阈值对当前最贵的合法价留有余量（防误伤）", async () => {
    // 误伤形态比不加哨兵更隐蔽：合法的贵模型被丢 → 落注册表兜底 → 按 FALLBACK $2/$10
    // 静默记账。实测网关非 expr 条目最贵是 input $10/1M（gpt-6-astra，output $50）。
    stubPricing({
      data: [
        // input $10 / output $50 —— 实测存在的合法最贵条目，必须通过。
        { model_name: "gpt-6-astra-like", quota_type: 0, model_ratio: 5, completion_ratio: 5 },
      ],
    });
    const r = await syncGatewayPricing({ baseURL: "https://m.example.com", force: true });
    expect(r.count, "当前最贵的合法价被误伤了").toBe(1);
    loadGatewayCache();
    expect(lookupGatewayPricing("gpt-6-astra-like", "https://m.example.com")?.input).toBeCloseTo(
      10,
      6,
    );
  });

  test("上游 pricing_version 落盘，且与自算哈希是两个不同的值", async () => {
    // 本次事故的结构性盲区：自算哈希的输入全是"我们已经解析出来的字段"，
    // 所以它无法反映"上游多了我们看不见的东西"。两个版本号必须各存一份。
    stubPricing({
      pricing_version: "a42d372ccf0b5dd13ecf71203521f9d2",
      data: [{ model_name: "m", quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
    });
    await syncGatewayPricing({ baseURL: "https://v.example.com", force: true });
    const b = readBucket("https://v.example.com");
    expect(b.upstream_pricing_version).toBe("a42d372ccf0b5dd13ecf71203521f9d2");
    expect(b.pricing_version).not.toBe(b.upstream_pricing_version);
  });

  test("上游版本变了必须落盘一次，即使换算出的价一个字节都没变", async () => {
    // ⚠ 这是 D7 的**核心判据**，也是本次事故潜伏下来的确切机制：
    // 网关新增 billing_mode/billing_expr 而旧字段没动 ⇒ 自算哈希不变 ⇒
    // 走「版本未变，跳过写盘」⇒ 上游换口径这件事没有任何痕迹。
    const ENTRIES = [{ model_name: "m", quota_type: 0, model_ratio: 1, completion_ratio: 2 }];
    stubPricing({ pricing_version: "v1", data: ENTRIES });
    const first = await syncGatewayPricing({ baseURL: "https://c.example.com", force: true });

    // 同一批条目、同一个上游版本 → 应当短路（这条是对照，证明短路本身没坏）。
    stubPricing({ pricing_version: "v1", data: ENTRIES });
    const same = await syncGatewayPricing({ baseURL: "https://c.example.com" });
    expect(same.updated, "价与上游版本都没变，本该跳过写盘").toBe(false);
    expect(same.version).toBe(first.version);

    // 价格逐字节相同，只有上游版本号变了 → 必须落盘（否则新版本号永远记不下来）。
    stubPricing({ pricing_version: "v2", data: ENTRIES });
    const changed = await syncGatewayPricing({ baseURL: "https://c.example.com" });
    expect(changed.updated, "上游口径版本变了却跳过了写盘（D7 盲区复现）").toBe(true);
    // 自算哈希不变，证明这次落盘**只**由上游版本驱动 —— 两个版本号各管一件事。
    expect(changed.version).toBe(first.version);
    expect(readBucket("https://c.example.com").upstream_pricing_version).toBe("v2");
  });

  test("上游不报版本号时保留上次存的值（拿不到 ≠ 上游没有）", async () => {
    stubPricing({
      pricing_version: "keep-me",
      data: [{ model_name: "m", quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
    });
    await syncGatewayPricing({ baseURL: "https://k.example.com", force: true });
    // 第二次返回不带 pricing_version（网关抖动 / 换实现），价格也改一下以触发写盘。
    stubPricing({
      data: [{ model_name: "m", quota_type: 0, model_ratio: 3, completion_ratio: 2 }],
    });
    await syncGatewayPricing({ baseURL: "https://k.example.com" });
    expect(readBucket("https://k.example.com").upstream_pricing_version).toBe("keep-me");
  });
});
