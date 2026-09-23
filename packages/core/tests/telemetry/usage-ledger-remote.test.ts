/**
 * M5 PR-5.1：账本远程 upsert 出口。
 *
 * 隔离：SID_CONFIG_DIR + SID_CODE_USAGE_LEDGER + SID_CODE_FAILED_USAGE_LEDGER
 * 均指 tmpdir。必须存/恢复原值，不能无条件 delete。
 * fetch 一律 mock，零真实网络。
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertUsageLedger } from "@sid-code/core/telemetry/usage-ledger.ts";
import type { UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";
import {
  __resetUsageLedgerRemoteForTest,
  pushUsageLedgerRemote,
  readFailedUsageLedger,
  replayFailedUsageLedger,
} from "@sid-code/core/telemetry/usage-ledger-remote.ts";
import { __resetIdentityForTest, saveDeviceCredential } from "@sid-code/core/identity/index.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";

const realFetch = globalThis.fetch;

function entry(over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    ts: 1_700_000_000,
    sessionId: "20260923-181500-a1b2c3d4",
    model: "deepseek-v4-pro",
    provider: "openai",
    promptTotal: 128000,
    cacheHit: 96000,
    cacheWrite: 0,
    uncachedInput: 32000,
    output: 2400,
    costUSD: 0.1842,
    savingsUSD: 0.072,
    durationMs: 185000,
    ...over,
  };
}

function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 40));
}

describe("账本远程 upsert（M5 PR-5.1）", () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let prevLedger: string | undefined;
  let prevFailed: string | undefined;
  let prevEndpoint: string | undefined;
  let prevDisableTelemetry: string | undefined;
  let prevEssential: string | undefined;
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    prevLedger = process.env.SID_CODE_USAGE_LEDGER;
    prevFailed = process.env.SID_CODE_FAILED_USAGE_LEDGER;
    prevEndpoint = process.env.SID_CODE_USAGE_ENDPOINT;
    prevDisableTelemetry = process.env.SID_CODE_DISABLE_TELEMETRY;
    prevEssential = process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    dir = mkdtempSync(join(tmpdir(), "sid-usage-remote-"));
    process.env.SID_CONFIG_DIR = dir;
    process.env.SID_CODE_USAGE_LEDGER = join(dir, "usage-ledger.jsonl");
    process.env.SID_CODE_FAILED_USAGE_LEDGER = join(dir, "failed-usage-ledger.jsonl");
    delete process.env.SID_CODE_USAGE_ENDPOINT;
    delete process.env.SID_CODE_DISABLE_TELEMETRY;
    delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    assertIsolated();
    __resetIdentityForTest();
    __resetUsageLedgerRemoteForTest();
    warnSpy = spyOn(getLogger(), "warn");
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    globalThis.fetch = realFetch;
    __resetIdentityForTest();
    __resetUsageLedgerRemoteForTest();
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    if (prevLedger === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
    else process.env.SID_CODE_USAGE_LEDGER = prevLedger;
    if (prevFailed === undefined) delete process.env.SID_CODE_FAILED_USAGE_LEDGER;
    else process.env.SID_CODE_FAILED_USAGE_LEDGER = prevFailed;
    if (prevEndpoint === undefined) delete process.env.SID_CODE_USAGE_ENDPOINT;
    else process.env.SID_CODE_USAGE_ENDPOINT = prevEndpoint;
    if (prevDisableTelemetry === undefined) delete process.env.SID_CODE_DISABLE_TELEMETRY;
    else process.env.SID_CODE_DISABLE_TELEMETRY = prevDisableTelemetry;
    if (prevEssential === undefined) delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    else process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = prevEssential;
    rmSync(dir, { recursive: true, force: true });
  });

  function stubFetch(status = 200): {
    calls: Array<{ url: string; body: UsageLedgerEntry; headers: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; body: UsageLedgerEntry; headers: Record<string, string> }> =
      [];
    globalThis.fetch = (async (url: any, opts: any) => {
      calls.push({
        url: String(url),
        body: JSON.parse(opts.body) as UsageLedgerEntry,
        headers: opts.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ upserted: "inserted" }), { status });
    }) as any;
    return { calls };
  }

  test("不配 endpoint：零 fetch，不写失败盘", async () => {
    const { calls } = stubFetch();
    saveDeviceCredential({ credential: "dev-cred" });
    await pushUsageLedgerRemote(entry());
    expect(calls.length).toBe(0);
    expect(existsSync(process.env.SID_CODE_FAILED_USAGE_LEDGER!)).toBe(false);
  });

  test("配了但无凭据：零 fetch，live 不写失败盘", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    const { calls } = stubFetch();
    await pushUsageLedgerRemote(entry());
    expect(calls.length).toBe(0);
    expect(existsSync(process.env.SID_CODE_FAILED_USAGE_LEDGER!)).toBe(false);
  });

  test("明文非本地 http：零 fetch", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "http://corp.example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    const { calls } = stubFetch();
    await pushUsageLedgerRemote(entry());
    expect(calls.length).toBe(0);
    expect(existsSync(process.env.SID_CODE_FAILED_USAGE_LEDGER!)).toBe(false);
  });

  test("2xx inserted：fetch 1 次，body 含 sessionId / costUSD，带 Bearer", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred-1" });
    const { calls } = stubFetch();
    const e = entry({ sessionId: "s-ok", costUSD: 0.42 });
    await pushUsageLedgerRemote(e);
    expect(calls.length).toBe(1);
    expect(calls[0].body.sessionId).toBe("s-ok");
    expect(calls[0].body.costUSD).toBe(0.42);
    expect(calls[0].headers.Authorization).toBe("Bearer dev-cred-1");
    expect(existsSync(process.env.SID_CODE_FAILED_USAGE_LEDGER!)).toBe(false);
  });

  test("http://127.0.0.1 放行", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "http://127.0.0.1:8900/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred-4" });
    const { calls } = stubFetch();
    await pushUsageLedgerRemote(entry());
    expect(calls.length).toBe(1);
  });

  test("连续 30 次 upsert 同 sessionId：fetch 30 次，每次 body.costUSD 为当时累计", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    const { calls } = stubFetch();
    for (let i = 1; i <= 30; i++) {
      await pushUsageLedgerRemote(entry({ sessionId: "long", costUSD: 0.001 * i }));
    }
    expect(calls.length).toBe(30);
    expect(calls[0].body.costUSD).toBeCloseTo(0.001, 10);
    expect(calls[29].body.costUSD).toBeCloseTo(0.03, 10);
    for (const c of calls) expect(c.body.sessionId).toBe("long");
  });

  test("5xx：失败盘 1 行；同 sessionId 再失败仍 1 行（覆盖）", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    stubFetch(500);
    await pushUsageLedgerRemote(entry({ sessionId: "s5", costUSD: 0.01 }));
    await pushUsageLedgerRemote(entry({ sessionId: "s5", costUSD: 0.09 }));
    const rows = readFailedUsageLedger();
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe("s5");
    expect(rows[0].payload.costUSD).toBeCloseTo(0.09, 10);
  });

  test("401：不写失败盘", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "revoked" });
    stubFetch(401);
    await pushUsageLedgerRemote(entry());
    expect(existsSync(process.env.SID_CODE_FAILED_USAGE_LEDGER!)).toBe(false);
  });

  test("SID_CODE_USAGE_LEDGER 指 tmpdir：不碰真实 ~/.sid-code/", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    stubFetch();
    upsertUsageLedger(entry({ sessionId: "iso" }));
    await drain();
    const ledger = process.env.SID_CODE_USAGE_LEDGER!;
    expect(ledger.startsWith(dir)).toBe(true);
    expect(readFileSync(ledger, "utf-8")).toContain("iso");
  });

  test("upsertUsageLedger 写盘成功后会 fire-and-forget 远程", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    const { calls } = stubFetch();
    upsertUsageLedger(entry({ sessionId: "hook", costUSD: 1.25 }));
    await drain();
    expect(calls.length).toBe(1);
    expect(calls[0].body.sessionId).toBe("hook");
    expect(calls[0].body.costUSD).toBe(1.25);
  });

  test("重放成功后删除该 sessionId 行", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    stubFetch(500);
    await pushUsageLedgerRemote(entry({ sessionId: "replay-me", costUSD: 0.5 }));
    expect(readFailedUsageLedger().length).toBe(1);
    stubFetch(200);
    await replayFailedUsageLedger();
    expect(readFailedUsageLedger().length).toBe(0);
  });

  test("重放无凭据时不删已有失败盘", async () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "https://example.com/api/v1/usage/ledger";
    saveDeviceCredential({ credential: "dev-cred" });
    stubFetch(500);
    await pushUsageLedgerRemote(entry({ sessionId: "keep-me" }));
    expect(readFailedUsageLedger().length).toBe(1);
    __resetIdentityForTest();
    // 清缓存不够：凭据文件还在。必须真正删盘，模拟「这台机器没凭据」。
    const { clearDeviceCredential } = await import("@sid-code/core/identity/index.ts");
    clearDeviceCredential();
    const { calls } = stubFetch();
    await replayFailedUsageLedger();
    expect(calls.length).toBe(0);
    expect(readFailedUsageLedger().length).toBe(1);
  });
});
