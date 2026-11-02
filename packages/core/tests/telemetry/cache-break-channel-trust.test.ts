/**
 * 缓存中断记录带渠道可信度；跨会话归因分布排除不可信渠道
 *
 * 背景：不可信渠道（如 ppchat，`channel-trust.json` 判 untrusted）的 cache_read 是编造的，
 * 它的「命中下降」不是缓存行为。2026-11-02 对齐轨迹：10-21~10-30 账单侧 696 条
 * 「两边都说字节没变」的 server_fluctuation 里有 459 条走这个渠道 —— 混进归因分布，
 * 会把渠道噪声读成服务端波动。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emitCacheBreakTelemetry,
  summarizeCacheBreakHistory,
  buildTelemetryEntry,
} from "@sid-code/core/telemetry/cache-telemetry.ts";
import { readChannelTrustCached } from "@sid-code/core/telemetry/channel-trust.ts";
import type { CacheBreakRecord } from "@sid-code/core/api/cache-detection.ts";

let dir: string;
const saved = {
  breaks: process.env.SID_CODE_CACHE_BREAKS,
  trust: process.env.SID_CODE_CHANNEL_TRUST,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-break-trust-"));
  process.env.SID_CODE_CACHE_BREAKS = join(dir, "cache-breaks.jsonl");
  process.env.SID_CODE_CHANNEL_TRUST = join(dir, "channel-trust.json");
});

afterEach(() => {
  for (const [k, v] of [
    ["SID_CODE_CACHE_BREAKS", saved.breaks],
    ["SID_CODE_CHANNEL_TRUST", saved.trust],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function rec(over: Partial<CacheBreakRecord>): CacheBreakRecord {
  return {
    ts: 1_793_000_000,
    model: "m",
    dropTokens: 5000,
    dropPercent: 50,
    changes: ["本地前缀 hash 未变（x），命中下降疑为服务端缓存波动"],
    categories: ["server_fluctuation"],
    previousCacheReadTokens: 10000,
    currentCacheReadTokens: 5000,
    ...over,
  };
}

describe("跨会话归因分布排除不可信渠道", () => {
  test("untrusted 记录不进 byCategory，单独计数；total 仍是全部条数", () => {
    emitCacheBreakTelemetry(rec({ endpointHost: "bad.example", channelTrust: "untrusted" }));
    emitCacheBreakTelemetry(rec({ endpointHost: "bad.example", channelTrust: "untrusted" }));
    emitCacheBreakTelemetry(rec({ endpointHost: "good.example", channelTrust: "trusted" }));
    emitCacheBreakTelemetry(
      rec({ categories: ["prefix_break"], endpointHost: "new.example", channelTrust: "unknown" }),
    );
    const s = summarizeCacheBreakHistory(10);
    expect(s.total).toBe(4);
    expect(s.excludedUntrusted).toBe(2);
    expect(s.byCategory).toEqual({ server_fluctuation: 1, prefix_break: 1 });
  });

  test("旧记录没有 channelTrust → 按 unknown 计入（不能因为缺字段就丢）", () => {
    emitCacheBreakTelemetry(rec({}));
    const s = summarizeCacheBreakHistory(10);
    expect(s.excludedUntrusted).toBe(0);
    expect(s.byCategory.server_fluctuation).toBe(1);
  });

  test("endpointHost / channelTrust 随记录落盘（默认透传，没被白名单拷贝丢掉）", () => {
    const e = buildTelemetryEntry(rec({ endpointHost: "bad.example", channelTrust: "untrusted" }));
    expect(e.endpointHost).toBe("bad.example");
    expect(e.channelTrust).toBe("untrusted");
  });
});

describe("readChannelTrustCached", () => {
  test("60 秒内复用同一份登记表，过期后重读", () => {
    const path = process.env.SID_CODE_CHANNEL_TRUST!;
    writeFileSync(
      path,
      JSON.stringify({ channels: { "a.example": { host: "a.example", verdict: "untrusted" } } }),
    );
    const t0 = 1_000_000_000_000;
    expect(readChannelTrustCached(t0).channels["a.example"].verdict).toBe("untrusted");

    writeFileSync(
      path,
      JSON.stringify({ channels: { "a.example": { host: "a.example", verdict: "trusted" } } }),
    );
    expect(readChannelTrustCached(t0 + 30_000).channels["a.example"].verdict).toBe("untrusted");
    expect(readChannelTrustCached(t0 + 61_000).channels["a.example"].verdict).toBe("trusted");
  });

  test("登记表路径变了立即失效（测试或用户改了 SID_CODE_CHANNEL_TRUST）", () => {
    const t0 = 2_000_000_000_000;
    readChannelTrustCached(t0);
    const other = join(dir, "other.json");
    writeFileSync(
      other,
      JSON.stringify({ channels: { "b.example": { host: "b.example", verdict: "untrusted" } } }),
    );
    process.env.SID_CODE_CHANNEL_TRUST = other;
    expect(readChannelTrustCached(t0 + 1).channels["b.example"]?.verdict).toBe("untrusted");
  });
});
