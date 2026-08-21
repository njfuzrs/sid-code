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
  derivePricingURL,
  loadGatewayCache,
  lookupGatewayPricing,
  getAllGatewayEntries,
  getGatewayCacheMeta,
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
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2,
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
        schema_version: 2,
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
        schema_version: 2,
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
    writeFileSync(path, JSON.stringify({ schema_version: 2, endpoints: {} }), "utf8");
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
    expect(parsed.schema_version).toBe(2);
    // D6 字段必须真的落到磁盘（只在内存里等于没采，见 computeVersion 的注释）。
    expect(parsed.endpoints["https://atomic.example.com"].models.m1.supportedEndpointTypes).toEqual(
      ["openai", "openai-response"],
    );
  });

  test("失败负缓存（recordFailure）同样走 rename：inode 必须变", async () => {
    const path = sidPaths.gatewayPricing();
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: 2, endpoints: {} }), "utf8");
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
      schema_version: 2,
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
