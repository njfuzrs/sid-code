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
});
