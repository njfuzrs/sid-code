/**
 * D7 远程策略低频轮询：调度与「只采纳权威结果」两条契约。
 *
 * 调度部分注入 reload / shouldPoll，零网络零落盘；
 * 端到端那条走真实 reloadEnterprisePolicy + mock fetch，SID_CONFIG_DIR 指向 tmpdir。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nextPolicyPollDelay,
  startEnterprisePolicyPolling,
  POLICY_POLL_INTERVAL_MS,
} from "@sid-code/core/config/policy-poll.ts";
import {
  __resetRemotePolicyLoaderForTest,
  reloadEnterprisePolicy,
  POLICY_CACHE_STALE_MS,
  type PolicyLoadResult,
} from "@sid-code/core/config/policy.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  __resetCredentialCacheForTest,
  saveDeviceCredential,
} from "@sid-code/core/identity/index.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function result(
  outcome: PolicyLoadResult["meta"]["outcome"],
  remoteAuthoritative: boolean,
): PolicyLoadResult {
  return {
    settings: null,
    meta: { source: "remote", outcome, durationMs: 0 },
    remoteAuthoritative,
  };
}

describe("nextPolicyPollDelay", () => {
  test("缺省间隔是 30 分钟，抖动在 ±10% 内", () => {
    expect(POLICY_POLL_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(nextPolicyPollDelay(1000, () => 0)).toBe(900);
    expect(nextPolicyPollDelay(1000, () => 0.5)).toBe(1000);
    expect(nextPolicyPollDelay(1000, () => 0.999999)).toBe(1100);
  });
});

describe("startEnterprisePolicyPolling", () => {
  test("权威变更（applied / none）回调；304 与非权威不回调", async () => {
    const queue = [
      result("applied", true),
      result("unchanged", true),
      result("cache_fallback", false),
      result("error", false),
      result("none", true),
    ];
    const seen: string[] = [];
    const stop = startEnterprisePolicyPolling({
      intervalMs: 5,
      random: () => 0.5,
      shouldPoll: () => true,
      reload: async () => queue.shift() ?? result("unchanged", true),
      onChange: (r) => {
        seen.push(r.meta.outcome);
      },
    });
    await tick(120);
    stop();
    expect(queue.length).toBe(0);
    expect(seen).toEqual(["applied", "none"]);
  });

  test("shouldPoll=false（未登录 / 未配后端）时不发请求", async () => {
    const reload = mock(async () => result("applied", true));
    const stop = startEnterprisePolicyPolling({
      intervalMs: 5,
      shouldPoll: () => false,
      reload,
      onChange: () => {},
    });
    await tick(40);
    stop();
    expect(reload).toHaveBeenCalledTimes(0);
  });

  test("reload 抛错不停掉轮询；stop 之后不再触发", async () => {
    let calls = 0;
    const stop = startEnterprisePolicyPolling({
      intervalMs: 5,
      shouldPoll: () => true,
      reload: async () => {
        calls++;
        throw new Error("boom");
      },
      onChange: () => {},
    });
    await tick(60);
    stop();
    const after = calls;
    expect(after).toBeGreaterThanOrEqual(2);
    await tick(40);
    expect(calls).toBe(after);
  });

  test("上一轮未结束时不叠出第二个请求", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const stop = startEnterprisePolicyPolling({
      intervalMs: 2,
      shouldPoll: () => true,
      reload: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(20);
        inFlight--;
        return result("unchanged", true);
      },
      onChange: () => {},
    });
    await tick(80);
    stop();
    expect(maxInFlight).toBe(1);
  });
});

describe("reloadEnterprisePolicy 的 remoteAuthoritative", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let prevEndpoint: string | undefined;
  let origFetch: typeof globalThis.fetch;
  const endpoint = "http://127.0.0.1:8900/api/v1/ctl/policy";

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    prevEndpoint = process.env.SID_CODE_POLICY_ENDPOINT;
    tmpDir = mkdtempSync(join(tmpdir(), "sid-policy-poll-"));
    process.env.SID_CONFIG_DIR = tmpDir;
    process.env.SID_CODE_POLICY_ENDPOINT = endpoint;
    __resetRemotePolicyLoaderForTest();
    __resetCredentialCacheForTest();
    origFetch = globalThis.fetch;
    saveDeviceCredential({
      credential: "secret-token-32bytes-minimum-ok",
      enrolledAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    __resetRemotePolicyLoaderForTest();
    __resetCredentialCacheForTest();
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    if (prevEndpoint === undefined) delete process.env.SID_CODE_POLICY_ENDPOINT;
    else process.env.SID_CODE_POLICY_ENDPOINT = prevEndpoint;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("204 是权威；超时且缓存过期是非权威（轮询据此保留现状，不撤 deny）", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any;
    const none = await reloadEnterprisePolicy();
    expect(none.settings).toBeNull();
    expect(none.remoteAuthoritative).toBe(true);

    // 两轮相隔 30 分钟 > 10 分钟缓存寿命：loader 会返回 null，但这不是「远程撤销」
    writeFileSync(
      sidPaths.policyCache(),
      JSON.stringify({
        etag: '"v1"',
        endpoint,
        fetched_at: new Date(Date.now() - POLICY_CACHE_STALE_MS - 1000).toISOString(),
        last_status: 200,
        settings: { source: "remote", permissions: { deny: ["Bash(curl *)"] } },
      }),
      { mode: 0o600 },
    );
    globalThis.fetch = mock(async () => {
      throw new Error("aborted");
    }) as any;
    const flaky = await reloadEnterprisePolicy();
    expect(flaky.settings).toBeNull();
    expect(flaky.remoteAuthoritative).toBe(false);
  });

  test("304 带缓存 → unchanged 且权威", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } }), {
          status: 200,
          headers: { ETag: '"v1"', "Content-Type": "application/json" },
        }),
    ) as any;
    expect((await reloadEnterprisePolicy()).meta.outcome).toBe("applied");

    const fetch304 = mock(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["If-None-Match"]).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    globalThis.fetch = fetch304 as any;
    const again = await reloadEnterprisePolicy();
    expect(fetch304).toHaveBeenCalledTimes(1);
    expect(again.meta.outcome).toBe("unchanged");
    expect(again.remoteAuthoritative).toBe(true);
    expect(again.settings?.permissions?.deny).toEqual(["Bash(curl *)"]);
  });
});
