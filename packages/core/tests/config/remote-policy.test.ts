/**
 * M3 RemotePolicyLoader：Bearer + ETag/304 + 磁盘缓存 + fail-open。
 *
 * 隔离：SID_CONFIG_DIR + SID_CODE_POLICY_ENDPOINT 存/恢复，对标 identity.test.ts。
 * fetch 一律 mock，零真实网络。
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  ManagedFileLoader,
  PolicyManager,
  RemotePolicyLoader,
  __resetRemotePolicyLoaderForTest,
  isNonLocalHttp,
  sanitizeRemotePolicy,
} from "@sid-code/core/config/policy.ts";
import {
  __resetCredentialCacheForTest,
  saveDeviceCredential,
} from "@sid-code/core/identity/index.ts";

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevEndpoint: string | undefined;
let origFetch: typeof globalThis.fetch;

function installFetch(impl: typeof globalThis.fetch): void {
  globalThis.fetch = impl;
}

function jsonResponse(body: unknown, init?: { status?: number; etag?: string }): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (init?.etag) headers.set("ETag", init.etag);
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers });
}

function emptyResponse(status: number, etag?: string): Response {
  const headers = new Headers();
  if (etag) headers.set("ETag", etag);
  return new Response(null, { status, headers });
}

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevEndpoint = process.env.SID_CODE_POLICY_ENDPOINT;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-remote-policy-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  delete process.env.SID_CODE_POLICY_ENDPOINT;
  __resetRemotePolicyLoaderForTest();
  __resetCredentialCacheForTest();
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  __resetRemotePolicyLoaderForTest();
  __resetCredentialCacheForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevEndpoint === undefined) delete process.env.SID_CODE_POLICY_ENDPOINT;
  else process.env.SID_CODE_POLICY_ENDPOINT = prevEndpoint;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function enroll(): void {
  saveDeviceCredential({
    credential: "secret-token-32bytes-minimum-ok",
    enrolledAt: new Date().toISOString(),
  });
}

describe("isNonLocalHttp", () => {
  test("https 一律放行", () => {
    expect(isNonLocalHttp("https://www.sid-code.cc/traj/api/v1/ctl/policy")).toBe(false);
  });
  test("http://127.0.0.1 与 localhost 放行", () => {
    expect(isNonLocalHttp("http://127.0.0.1:8900/api/v1/ctl/policy")).toBe(false);
    expect(isNonLocalHttp("http://localhost:8900/api/v1/ctl/policy")).toBe(false);
  });
  test("http://example.com 拒绝", () => {
    expect(isNonLocalHttp("http://example.com/api/v1/ctl/policy")).toBe(true);
  });
});

describe("sanitizeRemotePolicy", () => {
  test("body 含 policyEndpoint 时结果里没有该键", () => {
    const s = sanitizeRemotePolicy({
      source: "managed_file",
      policyEndpoint: "http://evil",
      endpoint: "http://evil",
      SID_CODE_POLICY_ENDPOINT: "http://evil",
      permissions: { deny: ["Bash(curl *)"] },
    });
    expect(s).not.toBeNull();
    expect(s!.source).toBe("remote");
    expect(Object.keys(s!)).not.toContain("policyEndpoint");
    expect(Object.keys(s!)).not.toContain("endpoint");
    expect(Object.keys(s!)).not.toContain("SID_CODE_POLICY_ENDPOINT");
    expect(s!.permissions?.deny).toEqual(["Bash(curl *)"]);
  });

  test("无 gate 的 policyLimits key 丢掉，有 gate 的保留", () => {
    const s = sanitizeRemotePolicy({
      policyLimits: {
        mcp: { allowed: false, reason: "未审计" },
        network_access: { allowed: false, reason: "假装断网" },
        file_upload: { allowed: false },
      },
    });
    expect(s!.policyLimits).toEqual({ mcp: { allowed: false, reason: "未审计" } });
    expect(s!.policyLimits?.network_access).toBeUndefined();
  });

  test("非对象返回 null", () => {
    expect(sanitizeRemotePolicy(null)).toBeNull();
    expect(sanitizeRemotePolicy("nope")).toBeNull();
    expect(sanitizeRemotePolicy([])).toBeNull();
  });
});

describe("RemotePolicyLoader.load", () => {
  test("未设 endpoint → load() 为 null，零 fetch", async () => {
    const fetchMock = mock(async () => emptyResponse(200));
    installFetch(fetchMock as unknown as typeof fetch);
    enroll();
    const got = await new RemotePolicyLoader().load();
    expect(got).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("mock 200 + 合法 JSON → source=remote，磁盘出现 0o600 缓存", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    installFetch(
      mock(async () =>
        jsonResponse(
          { permissions: { deny: ["Bash(curl *)"] }, disableAllHooks: true },
          { etag: '"abc"' },
        ),
      ) as unknown as typeof fetch,
    );
    const got = await new RemotePolicyLoader().load();
    expect(got?.source).toBe("remote");
    expect(got?.permissions?.deny).toEqual(["Bash(curl *)"]);
    expect(got?.disableAllHooks).toBe(true);
    const cachePath = sidPaths.policyCache();
    expect(existsSync(cachePath)).toBe(true);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  test("第二次带 If-None-Match；mock 304 → 返回缓存，不依赖 body", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    const first = mock(async () =>
      jsonResponse({ permissions: { deny: ["Bash(curl *)"] } }, { etag: '"v1"' }),
    );
    installFetch(first as unknown as typeof fetch);
    await new RemotePolicyLoader().load();

    const seen: { url: string; ifNone?: string }[] = [];
    installFetch(
      mock(async (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), ifNone: headers.get("If-None-Match") ?? undefined });
        return emptyResponse(304, '"v1"');
      }) as unknown as typeof fetch,
    );
    const got = await new RemotePolicyLoader().load();
    expect(got?.permissions?.deny).toEqual(["Bash(curl *)"]);
    expect(got?.source).toBe("remote");
    expect(seen[0]?.ifNone).toBe('"v1"');
  });

  test("mock 5xx / abort → 返回缓存；无缓存 → null（不抛）", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";

    installFetch(mock(async () => emptyResponse(503)) as unknown as typeof fetch);
    expect(await new RemotePolicyLoader().load()).toBeNull();

    installFetch(
      mock(async () =>
        jsonResponse({ permissions: { deny: ["Bash(curl *)"] } }, { etag: '"v1"' }),
      ) as unknown as typeof fetch,
    );
    await new RemotePolicyLoader().load();

    installFetch(mock(async () => emptyResponse(500)) as unknown as typeof fetch);
    const fromCache = await new RemotePolicyLoader().load();
    expect(fromCache?.permissions?.deny).toEqual(["Bash(curl *)"]);

    installFetch(
      mock(async () => {
        throw new Error("aborted");
      }) as unknown as typeof fetch,
    );
    const afterAbort = await new RemotePolicyLoader().load();
    expect(afterAbort?.permissions?.deny).toEqual(["Bash(curl *)"]);
  });

  test("mock 204 → null，且缓存被清", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    installFetch(
      mock(async () =>
        jsonResponse({ permissions: { deny: ["Bash(curl *)"] } }, { etag: '"v1"' }),
      ) as unknown as typeof fetch,
    );
    await new RemotePolicyLoader().load();
    expect(existsSync(sidPaths.policyCache())).toBe(true);

    installFetch(mock(async () => emptyResponse(204)) as unknown as typeof fetch);
    expect(await new RemotePolicyLoader().load()).toBeNull();
    expect(existsSync(sidPaths.policyCache())).toBe(false);
  });

  test("mock 401 → 返回缓存 / null，不抛", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    installFetch(mock(async () => emptyResponse(401)) as unknown as typeof fetch);
    expect(await new RemotePolicyLoader().load()).toBeNull();

    installFetch(
      mock(async () =>
        jsonResponse({ permissions: { deny: ["Bash(curl *)"] } }, { etag: '"v1"' }),
      ) as unknown as typeof fetch,
    );
    await new RemotePolicyLoader().load();
    installFetch(mock(async () => emptyResponse(401)) as unknown as typeof fetch);
    const got = await new RemotePolicyLoader().load();
    expect(got?.permissions?.deny).toEqual(["Bash(curl *)"]);
  });

  test("http://example.com/... → 不请求，null", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://example.com/api/v1/ctl/policy";
    const fetchMock = mock(async () => jsonResponse({ permissions: { deny: ["Bash(*)"] } }));
    installFetch(fetchMock as unknown as typeof fetch);
    expect(await new RemotePolicyLoader().load()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("http://127.0.0.1:... → 允许发请求", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    const fetchMock = mock(async () => jsonResponse({ permissions: { deny: ["Bash(curl *)"] } }));
    installFetch(fetchMock as unknown as typeof fetch);
    const got = await new RemotePolicyLoader().load();
    expect(fetchMock).toHaveBeenCalled();
    expect(got?.permissions?.deny).toEqual(["Bash(curl *)"]);
  });

  test("无凭据 → 不请求，用缓存", async () => {
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    writeFileSync(
      sidPaths.policyCache(),
      JSON.stringify({
        etag: '"v1"',
        endpoint: process.env.SID_CODE_POLICY_ENDPOINT,
        fetched_at: new Date().toISOString(),
        settings: { source: "remote", permissions: { deny: ["Bash(curl *)"] } },
      }),
      { mode: 0o600 },
    );
    const fetchMock = mock(async () => jsonResponse({ permissions: { deny: ["Bash(*)"] } }));
    installFetch(fetchMock as unknown as typeof fetch);
    const got = await new RemotePolicyLoader().load();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(got?.permissions?.deny).toEqual(["Bash(curl *)"]);
  });
});

describe("PolicyManager 默认链", () => {
  test("无参：remote 返回非 null 时不读 managed 文件", async () => {
    enroll();
    process.env.SID_CODE_POLICY_ENDPOINT = "http://127.0.0.1:8900/api/v1/ctl/policy";
    writeFileSync(
      sidPaths.managedSettings(),
      JSON.stringify({ permissions: { deny: ["Bash(*)"] }, disableAllHooks: false }),
      { mode: 0o600 },
    );
    const loadSpy = spyOn(ManagedFileLoader.prototype, "load");
    installFetch(
      mock(async () =>
        jsonResponse({ permissions: { deny: ["Bash(curl *)"] }, disableAllHooks: true }),
      ) as unknown as typeof fetch,
    );
    const policy = await new PolicyManager().load();
    expect(policy?.source).toBe("remote");
    expect(policy?.disableAllHooks).toBe(true);
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  test("remote 返回 null 时落到 managed 文件", async () => {
    writeFileSync(
      sidPaths.managedSettings(),
      JSON.stringify({ permissions: { deny: ["Bash(*)"] } }),
      { mode: 0o600 },
    );
    const policy = await new PolicyManager().load();
    expect(policy?.source).toBe("managed_file");
    expect(policy?.permissions?.deny).toEqual(["Bash(*)"]);
  });
});
