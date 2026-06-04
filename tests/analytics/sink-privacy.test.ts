import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  createAnalyticsSink,
  registerBackend,
  updateSamplingConfig,
  updateKilledSinks,
  __clearBackendsForTest,
  type SinkBackend,
} from "../../src/analytics/sink.ts";
import {
  setConfiguredPrivacyLevel,
  getPrivacyLevel,
  isTelemetryDisabled,
  isEssentialTrafficOnly,
  shouldLoadRemoteConfig,
} from "../../src/analytics/privacy-level.ts";
import {
  stripProtectedFields,
  extractProtectedFields,
  hasProtectedFields,
  PROTECTED_PREFIX,
} from "../../src/analytics/privacy.ts";
import type { EventMetadata } from "../../src/analytics/index.ts";

/** 收集型测试后端 */
function makeBackend(name: string, stripProtected: boolean, accept = true): SinkBackend & {
  events: Array<{ name: string; meta: EventMetadata }>;
} {
  const events: Array<{ name: string; meta: EventMetadata }> = [];
  return {
    name,
    stripProtected,
    events,
    accepts: () => accept,
    send: (n, m) => events.push({ name: n, meta: m }),
  };
}

describe("Sink 路由层（spec 17 §3.2）", () => {
  beforeEach(() => {
    __clearBackendsForTest();
    setConfiguredPrivacyLevel(null);
    delete process.env.SID_CODE_DISABLE_TELEMETRY;
    delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  });

  test("事件路由到所有接受的后端", () => {
    const a = makeBackend("a", false);
    const b = makeBackend("b", true);
    registerBackend(a);
    registerBackend(b);

    const sink = createAnalyticsSink();
    sink.logEvent("evt", { x: 1 });

    expect(a.events.length).toBe(1);
    expect(b.events.length).toBe(1);
  });

  test("stripProtected=true 的后端看不到 _PROTECTED_* 字段", () => {
    const priv = makeBackend("priv", false); // 特权
    const pub = makeBackend("pub", true); // 非特权
    registerBackend(priv);
    registerBackend(pub);

    const sink = createAnalyticsSink();
    sink.logEvent("evt", {
      normal: 1,
      [`${PROTECTED_PREFIX}secret`]: "abc" as any,
    });

    expect(priv.events[0].meta[`${PROTECTED_PREFIX}secret`]).toBe("abc" as any);
    expect(pub.events[0].meta[`${PROTECTED_PREFIX}secret`]).toBeUndefined();
    expect(pub.events[0].meta.normal).toBe(1);
  });

  test("killswitch 关闭的后端不接收事件", () => {
    const a = makeBackend("a", false);
    registerBackend(a);
    updateKilledSinks(new Set(["a"]));

    const sink = createAnalyticsSink();
    sink.logEvent("evt", {});
    expect(a.events.length).toBe(0);
  });

  test("采样率 0 完全丢弃事件", () => {
    const a = makeBackend("a", false);
    registerBackend(a);
    updateSamplingConfig({ noisy_event: 0 });

    const sink = createAnalyticsSink();
    sink.logEvent("noisy_event", {});
    expect(a.events.length).toBe(0);
  });

  test("采样率 >= 1 的事件 100% 发送且不附带 sample_rate", () => {
    const a = makeBackend("a", false);
    registerBackend(a);
    updateSamplingConfig({ e: 1 });

    const sink = createAnalyticsSink();
    sink.logEvent("e", {});
    expect(a.events.length).toBe(1);
    expect(a.events[0].meta.sample_rate).toBeUndefined();
  });

  test("隐私级别 no-telemetry 时所有事件被丢弃", () => {
    const a = makeBackend("a", false);
    registerBackend(a);
    setConfiguredPrivacyLevel("no-telemetry");

    const sink = createAnalyticsSink();
    sink.logEvent("evt", {});
    expect(a.events.length).toBe(0);
  });

  test("后端 send 抛错不影响其他后端", () => {
    const bad: SinkBackend = {
      name: "bad",
      stripProtected: false,
      accepts: () => true,
      send: () => {
        throw new Error("boom");
      },
    };
    const good = makeBackend("good", false);
    registerBackend(bad);
    registerBackend(good);

    const sink = createAnalyticsSink();
    expect(() => sink.logEvent("evt", {})).not.toThrow();
    expect(good.events.length).toBe(1);
  });
});

describe("隐私级别体系（spec 17 §3.3）", () => {
  beforeEach(() => {
    setConfiguredPrivacyLevel(null);
    delete process.env.SID_CODE_DISABLE_TELEMETRY;
    delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  });
  afterEach(() => {
    setConfiguredPrivacyLevel(null);
    delete process.env.SID_CODE_DISABLE_TELEMETRY;
    delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  });

  test("默认级别为 default", () => {
    expect(getPrivacyLevel()).toBe("default");
    expect(isTelemetryDisabled()).toBe(false);
    expect(shouldLoadRemoteConfig()).toBe(true);
  });

  test("环境变量 SID_CODE_DISABLE_TELEMETRY 优先于配置", () => {
    setConfiguredPrivacyLevel("default");
    process.env.SID_CODE_DISABLE_TELEMETRY = "1";
    expect(getPrivacyLevel()).toBe("no-telemetry");
    expect(isTelemetryDisabled()).toBe(true);
  });

  test("essential-traffic 是最严格级别，禁止远程配置", () => {
    process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    expect(getPrivacyLevel()).toBe("essential-traffic");
    expect(isEssentialTrafficOnly()).toBe(true);
    expect(shouldLoadRemoteConfig()).toBe(false);
  });

  test("配置文件级别在无环境变量时生效", () => {
    setConfiguredPrivacyLevel("no-telemetry");
    expect(getPrivacyLevel()).toBe("no-telemetry");
  });
});

describe("PII 双通道（spec 17 §4.3）", () => {
  test("stripProtectedFields 移除所有 _PROTECTED_* 字段", () => {
    const meta: EventMetadata = {
      a: 1,
      [`${PROTECTED_PREFIX}x`]: "secret" as any,
      [`${PROTECTED_PREFIX}y`]: "path" as any,
    };
    const stripped = stripProtectedFields(meta);
    expect(stripped.a).toBe(1);
    expect(stripped[`${PROTECTED_PREFIX}x`]).toBeUndefined();
    expect(stripped[`${PROTECTED_PREFIX}y`]).toBeUndefined();
  });

  test("无 _PROTECTED_ 字段时返回原引用（零拷贝）", () => {
    const meta: EventMetadata = { a: 1, b: true };
    expect(stripProtectedFields(meta)).toBe(meta);
  });

  test("extractProtectedFields 去前缀提取", () => {
    const meta: EventMetadata = {
      a: 1,
      [`${PROTECTED_PREFIX}server`]: "github" as any,
    };
    const extracted = extractProtectedFields(meta);
    expect(extracted.server).toBe("github" as any);
    expect(extracted.a).toBeUndefined();
  });

  test("hasProtectedFields 检测", () => {
    expect(hasProtectedFields({ a: 1 })).toBe(false);
    expect(hasProtectedFields({ [`${PROTECTED_PREFIX}x`]: "1" as any })).toBe(true);
  });
});
