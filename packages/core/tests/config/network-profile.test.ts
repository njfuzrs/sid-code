/**
 * network-profile：统一超时/重试配置解析 — 单元测试
 *
 * 验证三层优先级链（env override > settings.network > 统一默认值）与退避算法。
 * 重点保证：只有一套默认值（不分 direct/gateway、不按模型分档），
 * 且各覆盖层级互不串味。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  DEFAULTS,
  PROVIDER_STREAM_DEFAULTS,
  SIDE_CALL_DEFAULTS,
  resolveLoopTimeouts,
  resolveHeaderTimeoutMs,
  resolveProviderStreamTimeouts,
  resolveSideCallTimeouts,
  computeBackoffMs,
} from "@sid-code/core/config/network-profile.ts";

const ENV_KEYS = [
  "SID_CODE_RESPONSE_HEADER_TIMEOUT_MS",
  "SID_CODE_WATCHDOG_CHECK_INTERVAL_MS",
  "SID_CODE_WATCHDOG_NO_PROGRESS_MS",
  "SID_CODE_WATCHDOG_HEADER_GRACE_MS",
  "SID_CODE_MAX_TURN_DURATION_MS",
  "SID_CODE_MAX_SESSION_DURATION_MS",
  "SID_CODE_MAX_TIMEOUT_RETRIES",
  "SID_CODE_MAX_RETRIES_PER_CALL",
  "SID_CODE_RETRY_BACKOFF_BASE_MS",
  "SID_CODE_RETRY_BACKOFF_MAX_MS",
  "SID_CODE_IDLE_TIMEOUT_MS",
  "SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS",
  "SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS",
  "SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS",
  "SID_CODE_OPENAI_OVERALL_TIMEOUT_MS",
  "SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS",
  "SID_CODE_WARMUP_TIMEOUT_MS",
  "SID_CODE_COMPACT_TIMEOUT_MS",
  "SID_CODE_COLLAPSE_SEGMENT_TIMEOUT_MS",
  "SID_CODE_RECALL_TIMEOUT_MS",
  "SID_CODE_TITLE_TIMEOUT_MS",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("resolveLoopTimeouts — 层级优先级", () => {
  test("无任何覆盖 → 全部取统一默认值", () => {
    const t = resolveLoopTimeouts({});
    expect(t).toEqual({ ...DEFAULTS });
  });

  test("settings.network 覆盖默认值", () => {
    const t = resolveLoopTimeouts({
      network: { headerTimeoutMs: 111_000, maxTimeoutRetries: 7 },
    });
    expect(t.headerTimeoutMs).toBe(111_000);
    expect(t.maxTimeoutRetries).toBe(7);
    // 未覆盖字段仍取默认值
    expect(t.watchdogNoProgressMs).toBe(DEFAULTS.watchdogNoProgressMs);
  });

  test("环境变量优先级高于 settings.network", () => {
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "222000";
    const t = resolveLoopTimeouts({ network: { headerTimeoutMs: 111_000 } });
    expect(t.headerTimeoutMs).toBe(222_000);
  });

  test("非法环境变量（负数/非数字）被忽略，回退下一层", () => {
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "-1";
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "abc";
    const t = resolveLoopTimeouts({ network: { maxTimeoutRetries: 3 } });
    expect(t.maxTimeoutRetries).toBe(3); // settings 生效
    expect(t.headerTimeoutMs).toBe(DEFAULTS.headerTimeoutMs); // 回退默认
  });

  test("maxTimeoutRetries=0 是合法值（nonNegative），不被当作未设置", () => {
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "0";
    const t = resolveLoopTimeouts({});
    expect(t.maxTimeoutRetries).toBe(0);
  });

  test("maxSessionDurationMs / maxRetriesPerCall 支持 env 与 settings 覆盖（不确定-1 / 不确定-2/3）", () => {
    // 默认值
    const def = resolveLoopTimeouts({});
    expect(def.maxSessionDurationMs).toBe(DEFAULTS.maxSessionDurationMs);
    expect(def.maxRetriesPerCall).toBe(DEFAULTS.maxRetriesPerCall);

    // settings 覆盖
    const bySettings = resolveLoopTimeouts({
      network: { maxSessionDurationMs: 45 * 60_000, maxRetriesPerCall: 5 },
    });
    expect(bySettings.maxSessionDurationMs).toBe(45 * 60_000);
    expect(bySettings.maxRetriesPerCall).toBe(5);

    // env 优先级高于 settings
    process.env.SID_CODE_MAX_SESSION_DURATION_MS = "600000";
    process.env.SID_CODE_MAX_RETRIES_PER_CALL = "3";
    const byEnv = resolveLoopTimeouts({
      network: { maxSessionDurationMs: 45 * 60_000, maxRetriesPerCall: 5 },
    });
    expect(byEnv.maxSessionDurationMs).toBe(600_000);
    expect(byEnv.maxRetriesPerCall).toBe(3);
  });

  test("会话级硬顶默认关闭（0 = 不限时，为无人值守长任务让路）", () => {
    // 2026-08-04：默认从 60min 改为 0。这个闸门只看挂钟总时长、不看有无进展，
    // 无法区分"卡死 60 分钟"与"顺利干了 60 分钟"，与无人值守长任务直接冲突。
    // 挂起类根因由更精准的几层兜住（单轮 30min 硬顶 / 看门狗无进展 300s / 重试封顶）。
    const t = resolveLoopTimeouts({});
    expect(t.maxSessionDurationMs).toBe(0);
    // 单轮硬顶必须保留——它是关掉会话硬顶后真正的挂死兜底。
    expect(t.maxTurnDurationMs).toBeGreaterThan(0);
  });

  test("会话级硬顶一旦显式开启，仍须严格大于单轮硬顶（避免同时到期）", () => {
    // 原「不确定-1 副作用修复」的约束在"显式开启"语境下依然成立：会话级若与单轮级相等，
    // 单轮跑满时二者几乎同时触发，会话级兜不到额外东西。故重开时应取更大值。
    const t = resolveLoopTimeouts({ network: { maxSessionDurationMs: 2 * 60 * 60_000 } });
    expect(t.maxSessionDurationMs).toBeGreaterThan(t.maxTurnDurationMs);
  });

  test("maxSessionDurationMs=0 是合法值（nonNegative），不被当作未设置回退默认", () => {
    // 关键回归：这一项若走 readEnvMs（>0 校验），显式写 0 会被静默丢弃回退默认值，
    // 用户就无法用 env 表达"关闭会话硬顶"。settings 侧同理（Zod 须为 nonnegative）。
    process.env.SID_CODE_MAX_SESSION_DURATION_MS = "0";
    const t = resolveLoopTimeouts({ network: { maxSessionDurationMs: 45 * 60_000 } });
    expect(t.maxSessionDurationMs).toBe(0);
  });

  test("maxRetriesPerCall=0 是合法值（nonNegative），不被当作未设置", () => {
    process.env.SID_CODE_MAX_RETRIES_PER_CALL = "0";
    const t = resolveLoopTimeouts({});
    expect(t.maxRetriesPerCall).toBe(0);
  });

  test("统一默认值：保活优先（阈值足够宽）", () => {
    const t = resolveLoopTimeouts({});
    // 回归保护：这些是与用户对齐的"宁可多等不无声杀"的下限，不应被悄悄调小。
    expect(t.headerTimeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(t.watchdogNoProgressMs).toBeGreaterThanOrEqual(300_000);
    expect(t.maxTurnDurationMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(t.maxTimeoutRetries).toBeGreaterThanOrEqual(4);
    expect(t.retryBackoffBaseMs).toBeGreaterThan(0); // 不再零延迟重试
  });
});

describe("resolveHeaderTimeoutMs — provider 内部两层", () => {
  test("默认取统一 header 超时", () => {
    expect(resolveHeaderTimeoutMs()).toBe(DEFAULTS.headerTimeoutMs);
  });
  test("环境变量覆盖", () => {
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "99000";
    expect(resolveHeaderTimeoutMs()).toBe(99_000);
  });
});

describe("resolveProviderStreamTimeouts — provider 流式看门狗（配置-3 / 必删-1/-2）", () => {
  test("无覆盖 → 全部取统一默认值（不按模型分档）", () => {
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(t).toEqual({ ...PROVIDER_STREAM_DEFAULTS });
    // 回归保护：不再有 deepseek(180/300) vs default(90/120) 的分档，一律取一套够宽的值。
    //
    // PR10 后这里**不再钉具体数字**：档① 240s / 档② 480s 的取值归
    // `tests/config/timeout-ladder-sentinel.test.ts` 管（它同时钉数值阶梯与谓词阶梯）。
    // 两处都钉同一个字面量，只会在调档时同时红两处、其中一处的注释还落后于事实。
    // 本用例要守的是"不分档"这个不变量，所以断言形态改成：档① < 档②、且都足够宽。
    expect(t.idleTimeoutMs).toBeLessThan(t.contentProgressTimeoutMs);
    expect(t.idleTimeoutMs).toBeGreaterThanOrEqual(180_000);
  });

  test("openai idle / content-progress env 覆盖", () => {
    process.env.SID_CODE_IDLE_TIMEOUT_MS = "150";
    process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS = "200";
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(t.idleTimeoutMs).toBe(150);
    expect(t.contentProgressTimeoutMs).toBe(200);
  });

  test("anthropic content-progress / overall 用各自 env 名", () => {
    process.env.SID_CODE_ANTHROPIC_CONTENT_PROGRESS_TIMEOUT_MS = "111";
    process.env.SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS = "222";
    const t = resolveProviderStreamTimeouts({ providerKind: "anthropic" });
    expect(t.contentProgressTimeoutMs).toBe(111);
    expect(t.overallTimeoutMs).toBe(222);
    // openai 的 content-progress env 不应串味到 anthropic
    process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS = "999";
    const t2 = resolveProviderStreamTimeouts({ providerKind: "anthropic" });
    expect(t2.contentProgressTimeoutMs).toBe(111); // 仍取 anthropic 专用 env
  });

  test("fetch-absolute env 两 provider 共用", () => {
    process.env.SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS = "333";
    expect(resolveProviderStreamTimeouts({ providerKind: "openai" }).fetchAbsoluteTimeoutMs).toBe(
      333,
    );
    expect(
      resolveProviderStreamTimeouts({ providerKind: "anthropic" }).fetchAbsoluteTimeoutMs,
    ).toBe(333);
  });

  test("非法 env（负数/非数字）被忽略，回退默认", () => {
    process.env.SID_CODE_IDLE_TIMEOUT_MS = "-5";
    process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS = "abc";
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(t.idleTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.idleTimeoutMs);
    expect(t.contentProgressTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs);
  });

  test("默认 providerKind 为 openai", () => {
    const t = resolveProviderStreamTimeouts();
    expect(t).toEqual({ ...PROVIDER_STREAM_DEFAULTS });
  });
});

describe("resolveSideCallTimeouts — side-call 子表（配置-4）", () => {
  test("无覆盖 → 全部取默认值", () => {
    const t = resolveSideCallTimeouts();
    expect(t).toEqual({ ...SIDE_CALL_DEFAULTS });
  });

  test("各 env 独立覆盖", () => {
    process.env.SID_CODE_WARMUP_TIMEOUT_MS = "5000";
    process.env.SID_CODE_COMPACT_TIMEOUT_MS = "30000";
    process.env.SID_CODE_COLLAPSE_SEGMENT_TIMEOUT_MS = "20000";
    process.env.SID_CODE_RECALL_TIMEOUT_MS = "8000";
    process.env.SID_CODE_TITLE_TIMEOUT_MS = "12000";
    const t = resolveSideCallTimeouts();
    expect(t.warmupMs).toBe(5000);
    expect(t.compactMs).toBe(30000);
    expect(t.collapseSegmentMs).toBe(20000);
    expect(t.recallMs).toBe(8000);
    expect(t.titleMs).toBe(12000);
  });

  test("非法 env 被忽略，回退默认", () => {
    process.env.SID_CODE_WARMUP_TIMEOUT_MS = "abc";
    process.env.SID_CODE_RECALL_TIMEOUT_MS = "-1";
    process.env.SID_CODE_TITLE_TIMEOUT_MS = "0";
    const t = resolveSideCallTimeouts();
    expect(t.warmupMs).toBe(SIDE_CALL_DEFAULTS.warmupMs);
    expect(t.recallMs).toBe(SIDE_CALL_DEFAULTS.recallMs);
    expect(t.titleMs).toBe(SIDE_CALL_DEFAULTS.titleMs);
  });
});

describe("computeBackoffMs — 指数退避 + jitter + 封顶", () => {
  test("随 attempt 指数增长（含 ±15% jitter，取区间断言）", () => {
    // attempt=0: base*1；attempt=1: base*2；attempt=2: base*4
    const base = 1_000;
    const max = 100_000;
    const a0 = computeBackoffMs(0, base, max);
    const a2 = computeBackoffMs(2, base, max);
    expect(a0).toBeGreaterThanOrEqual(Math.round(1_000 * 0.85));
    expect(a0).toBeLessThanOrEqual(Math.round(1_000 * 1.15));
    expect(a2).toBeGreaterThanOrEqual(Math.round(4_000 * 0.85));
    expect(a2).toBeLessThanOrEqual(Math.round(4_000 * 1.15));
  });

  test("封顶 maxMs（含 jitter 上界）", () => {
    const capped = computeBackoffMs(20, 1_000, 5_000); // 1000*2^20 远超 5000
    expect(capped).toBeLessThanOrEqual(Math.round(5_000 * 1.15));
    expect(capped).toBeGreaterThanOrEqual(Math.round(5_000 * 0.85));
  });
});
