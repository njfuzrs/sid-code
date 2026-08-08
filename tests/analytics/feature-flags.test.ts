import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initFeatureFlags,
  getFeatureValue_CACHED_MAY_BE_STALE,
  __resetFeatureFlagsForTest,
} from "../../src/analytics/feature-flags.ts";
import { shouldSampleEvent } from "../../src/analytics/sampling.ts";
import { isSinkKilled } from "../../src/analytics/killswitch.ts";
import { getUserBucket, __resetUserBucketForTest } from "../../src/analytics/user-bucket.ts";
import {
  primeMetadata,
  getEventMetadataFields,
  refreshMetadata,
  __resetMetadataForTest,
} from "../../src/analytics/metadata.ts";

describe("Feature Flag 系统（spec 17 §5.1）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-ff-"));
    __resetFeatureFlagsForTest();
    delete process.env.SID_CODE_FLAG_MY_FLAG;
  });
  afterEach(() => {
    __resetFeatureFlagsForTest();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SID_CODE_FLAG_MY_FLAG;
  });

  test("无配置时返回默认值", () => {
    initFeatureFlags({ configDir: dir });
    expect(getFeatureValue_CACHED_MAY_BE_STALE<string>("nonexistent", "def")).toBe("def");
  });

  test("本地 flag 生效", () => {
    initFeatureFlags({ configDir: dir, localFlags: { my_flag: 42 } });
    expect(getFeatureValue_CACHED_MAY_BE_STALE<number>("my_flag", 0)).toBe(42);
  });

  test("环境变量覆盖本地 flag", () => {
    process.env.SID_CODE_FLAG_MY_FLAG = "99";
    initFeatureFlags({ configDir: dir, localFlags: { my_flag: 42 } });
    expect(getFeatureValue_CACHED_MAY_BE_STALE<number>("my_flag", 0)).toBe(99);
  });

  test("环境变量解析布尔值", () => {
    process.env.SID_CODE_FLAG_MY_FLAG = "true";
    initFeatureFlags({ configDir: dir });
    expect(getFeatureValue_CACHED_MAY_BE_STALE<boolean>("my_flag", false)).toBe(true);
  });

  test("磁盘缓存加载", () => {
    const cachePath = join(dir, "feature-flags-cache.json");
    writeFileSync(cachePath, JSON.stringify({ cached_flag: "from_disk" }));
    initFeatureFlags({ configDir: dir });
    expect(getFeatureValue_CACHED_MAY_BE_STALE<string>("cached_flag", "def")).toBe("from_disk");
  });
});

describe("事件采样（spec 17 §5.2）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-sampling-"));
    __resetFeatureFlagsForTest();
  });
  afterEach(() => {
    __resetFeatureFlagsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("未配置采样的事件返回 null（100% 发送）", () => {
    initFeatureFlags({ configDir: dir });
    expect(shouldSampleEvent("unconfigured")).toBeNull();
  });

  test("采样率 0 返回 0（丢弃）", () => {
    initFeatureFlags({ configDir: dir, localFlags: { event_sampling_config: { noisy: 0 } } });
    expect(shouldSampleEvent("noisy")).toBe(0);
  });

  test("采样率 1 返回 null（100%）", () => {
    initFeatureFlags({ configDir: dir, localFlags: { event_sampling_config: { e: 1 } } });
    expect(shouldSampleEvent("e")).toBeNull();
  });
});

describe("Killswitch（spec 17 §5.2）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-ks-"));
    __resetFeatureFlagsForTest();
  });
  afterEach(() => {
    __resetFeatureFlagsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("默认不关闭任何后端", () => {
    initFeatureFlags({ configDir: dir });
    expect(isSinkKilled("http")).toBe(false);
  });

  test("配置的后端被关闭", () => {
    initFeatureFlags({ configDir: dir, localFlags: { sink_killswitch: { http: true } } });
    expect(isSinkKilled("http")).toBe(true);
    expect(isSinkKilled("local")).toBe(false);
  });
});

describe("用户分桶（spec 17 §5.3）", () => {
  beforeEach(() => __resetUserBucketForTest());

  test("桶号在 0-29 范围内", () => {
    const bucket = getUserBucket("user-123");
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(30);
  });

  test("同一用户分桶稳定", () => {
    const a = getUserBucket("stable-user");
    __resetUserBucketForTest();
    const b = getUserBucket("stable-user");
    expect(a).toBe(b);
  });

  test("不同用户可能落入不同桶", () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i++) {
      __resetUserBucketForTest();
      buckets.add(getUserBucket(`user-${i}`));
    }
    // 50 个用户至少应分布在多个桶
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe("事件元数据富化（spec 17 §5.3）", () => {
  beforeEach(() => {
    __resetMetadataForTest();
    __resetUserBucketForTest();
  });

  test("包含平台/架构等环境字段", () => {
    const fields = getEventMetadataFields();
    expect(String(fields._ctx_platform)).toBe(process.platform);
    expect(String(fields._ctx_arch)).toBe(process.arch);
    expect(typeof fields._ctx_is_ci).toBe("boolean");
  });

  test("primeMetadata 注入 session/model/provider", () => {
    primeMetadata({ sessionId: "sess-1", model: "claude-x", provider: "anthropic" });
    const fields = getEventMetadataFields();
    expect(fields._ctx_session_id).toBe("sess-1" as any);
    expect(fields._ctx_model).toBe("claude-x" as any);
    expect(fields._ctx_provider).toBe("anthropic" as any);
  });

  test("包含用户分桶字段", () => {
    primeMetadata({ sessionId: "sess-2" });
    const fields = getEventMetadataFields();
    expect(typeof fields._ctx_user_bucket).toBe("number");
  });

  // 接线回归：refreshMetadata 曾是零调用点的死代码，运行时 /model 切换后 _ctx_model
  // 一直是会话初始化时缓存的旧模型名——事件全部归因到错误的模型上，而切模型的典型
  // 动机恰恰是对比两个模型，这是最不能错的场景。生产接线点见 app.ts
  // applyPrimaryModelSwitch（/model 与 fallback 降级共用的单一真相源）。
  test("refreshMetadata 刷新可变字段——切模型后 _ctx_model 跟着变", () => {
    primeMetadata({ sessionId: "sess-3", model: "model-old", provider: "prov-old" });
    expect(getEventMetadataFields()._ctx_model).toBe("model-old" as any);

    refreshMetadata({ model: "model-new", provider: "prov-new" });
    const after = getEventMetadataFields();
    expect(after._ctx_model).toBe("model-new" as any);
    expect(after._ctx_provider).toBe("prov-new" as any);
    // 不可变字段不受影响
    expect(after._ctx_session_id).toBe("sess-3" as any);
  });

  test("refreshMetadata 在未 prime 时是 no-op，不抛错", () => {
    // 未 prime（cachedContext 为 null）时不应崩，也不应凭空建出上下文——
    // app.ts 里它在 analytics 可能未初始化的情况下被调用。
    expect(() => refreshMetadata({ model: "m" })).not.toThrow();
  });
});
