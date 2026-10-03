/**
 * P2 CLI 飞书登录：backend.url 解析、登录全流程、exchange 各分支、登出、getIdentity 读登录态。
 *
 * 全流程用例不碰真实网络：openBrowser 注入成「假后端」——解析 cli/start 参数后，
 * 直接用 node:http 打本地回调服务器（不用 fetch：系统代理可能拦 loopback），
 * exchange 用注入的 fetchImpl 校验 S256(verifier)==challenge。
 *
 * 隔离：SID_CONFIG_DIR → tmpdir，存/恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import {
  __resetIdentityForTest,
  getDeviceCredential,
  getIdentity,
  getOrCreateDeviceId,
  saveDeviceCredential,
  setIdentityConfig,
} from "@sid-code/core/identity/index.ts";
import {
  backendApiUrl,
  normalizeBackendUrl,
  resolveBackendUrl,
} from "@sid-code/core/identity/backend-url.ts";
import {
  CliLoginError,
  buildCliStartUrl,
  exchangeLoginCode,
  performCliLogin,
  performCliLogout,
  verifyCredentialRemote,
} from "@sid-code/core/identity/cli-login.ts";
import { filterProjectSettings } from "@sid-code/core/config/settings/security.ts";

const BACKEND = "https://backend.example/traj";

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevBackend: string | undefined;
let prevUser: string | undefined;
let warnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevBackend = process.env.SID_CODE_BACKEND_URL;
  prevUser = process.env.SID_CODE_IDENTITY_USER_ID;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-cli-login-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  delete process.env.SID_CODE_BACKEND_URL;
  delete process.env.SID_CODE_IDENTITY_USER_ID;
  __resetIdentityForTest();
  warnSpy = spyOn(getLogger(), "warn");
});

afterEach(() => {
  warnSpy?.mockRestore();
  __resetIdentityForTest();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("SID_CONFIG_DIR", prevConfigDir);
  restore("SID_CODE_BACKEND_URL", prevBackend);
  restore("SID_CODE_IDENTITY_USER_ID", prevUser);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 打本地回调；返回状态码 */
function hitCallback(port: number, query: Record<string, string>): Promise<number> {
  const qs = new URLSearchParams(query).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: `/callback?${qs}`, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 假后端：记住 start 发来的 challenge，exchange 时按 PKCE 校验 */
function fakeBackend(opts: { tamperState?: boolean; exchangeStatus?: number } = {}) {
  const seen: { start?: URL; exchangeBody?: any } = {};
  let challenge = "";
  const issuedCode = "L-one-time";
  const openBrowser = async (url: string) => {
    const u = new URL(url);
    seen.start = u;
    challenge = u.searchParams.get("challenge") ?? "";
    const port = Number(u.searchParams.get("port"));
    const state = opts.tamperState ? "attacker-state" : (u.searchParams.get("cli_state") ?? "");
    // 浏览器异步跟随 302，不阻塞 openBrowser 返回
    setTimeout(() => void hitCallback(port, { code: issuedCode, state }).catch(() => {}), 10);
    return true;
  };
  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/auth/cli/exchange")) {
      const body = JSON.parse(init.body);
      seen.exchangeBody = body;
      if (opts.exchangeStatus) return jsonResponse(opts.exchangeStatus, { detail: "nope" });
      const ok =
        body.code === issuedCode &&
        createHash("sha256").update(body.verifier).digest("base64url") === challenge;
      if (!ok) return jsonResponse(400, { detail: "invalid_code_or_verifier" });
      return jsonResponse(200, {
        credential: "dev-cred-xyz",
        expires_at: "2099-01-01T00:00:00Z",
        user: { id: 7, name: "张三", union_id: "on_abc" },
      });
    }
    return jsonResponse(404, {});
  }) as unknown as typeof fetch;
  return { openBrowser, fetchImpl, seen };
}

describe("backend.url", () => {
  test("规范化：去尾斜杠、去 query；只允许 https 或 loopback http", () => {
    expect(normalizeBackendUrl("https://a.example/traj/?x=1#h")?.url).toBe(
      "https://a.example/traj",
    );
    expect(normalizeBackendUrl("http://127.0.0.1:8900")?.url).toBe("http://127.0.0.1:8900");
    expect(normalizeBackendUrl("http://evil.example/traj")).toBeNull();
    expect(normalizeBackendUrl("ftp://a.example")).toBeNull();
    expect(normalizeBackendUrl("https://u:p@a.example")).toBeNull();
    expect(normalizeBackendUrl("not a url")).toBeNull();
  });

  test("优先级：env > managed-settings > user settings；未配置为 null", () => {
    expect(resolveBackendUrl()).toBeNull();
    writeFileSync(
      sidPaths.settings(),
      JSON.stringify({ backend: { url: "https://user.example" } }),
    );
    expect(resolveBackendUrl()).toMatchObject({ url: "https://user.example", source: "user" });
    // 用户级 managed-settings 只在系统级 /etc 文件不存在时生效；本机有系统级文件就跳过这一段
    const managed = sidPaths.managedPolicyCandidates().find((p) => existsSync(p));
    if (!managed) {
      writeFileSync(
        sidPaths.managedSettings(),
        JSON.stringify({ backend: { url: "https://managed.example" } }),
      );
      expect(resolveBackendUrl()?.source).toBe("managed");
    }
    process.env.SID_CODE_BACKEND_URL = "https://env.example/traj/";
    expect(resolveBackendUrl()).toMatchObject({
      url: "https://env.example/traj",
      origin: "https://env.example",
      source: "env",
    });
  });

  test("配了明文非本地地址 → null + 告警（不降级用下一个来源）", () => {
    writeFileSync(
      sidPaths.settings(),
      JSON.stringify({ backend: { url: "https://user.example" } }),
    );
    process.env.SID_CODE_BACKEND_URL = "http://evil.example";
    expect(resolveBackendUrl()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("项目级 settings 的 backend 字段被过滤（不能把凭据导到别处）", () => {
    const filtered = filterProjectSettings({ backend: { url: "https://evil.example" } } as any);
    expect((filtered as any).backend).toBeUndefined();
  });

  test("backendApiUrl 拼 /api/v1", () => {
    expect(backendApiUrl("https://a.example/traj/", "/auth/cli/exchange")).toBe(
      "https://a.example/traj/api/v1/auth/cli/exchange",
    );
  });
});

describe("performCliLogin 全流程", () => {
  test("成功：start 参数齐全、PKCE 校验通过、凭据带 user 段落盘 0600", async () => {
    const fb = fakeBackend();
    const result = await performCliLogin(BACKEND, {
      openBrowser: fb.openBrowser,
      fetchImpl: fb.fetchImpl,
      timeoutMs: 5000,
      version: "0.0.1",
    });

    const start = fb.seen.start!;
    expect(start.origin + start.pathname).toBe(`${BACKEND}/api/v1/auth/feishu/cli/start`);
    expect(start.searchParams.get("challenge_method")).toBe("S256");
    expect(start.searchParams.get("device_id")).toBe(getOrCreateDeviceId());
    expect(Number(start.searchParams.get("port"))).toBeGreaterThan(0);
    // verifier 只在 exchange 里出现，绝不进浏览器 URL
    expect(start.toString()).not.toContain(fb.seen.exchangeBody.verifier);
    expect(fb.seen.exchangeBody.device_id).toBe(getOrCreateDeviceId());
    expect(fb.seen.exchangeBody.ver).toBe("0.0.1");

    expect(result.user).toEqual({ id: "7", name: "张三", unionId: "on_abc" });
    const disk = JSON.parse(readFileSync(sidPaths.deviceCredential(), "utf-8"));
    expect(disk).toMatchObject({
      credential: "dev-cred-xyz",
      expires_at: "2099-01-01T00:00:00Z",
      user: { id: "7", name: "张三", union_id: "on_abc" },
    });
    if (process.platform !== "win32") {
      expect(statSync(sidPaths.deviceCredential()).mode & 0o777).toBe(0o600);
    }
  });

  test("回调 state 不匹配 → state_mismatch，不调 exchange、不落盘", async () => {
    const fb = fakeBackend({ tamperState: true });
    const err = await performCliLogin(BACKEND, {
      openBrowser: fb.openBrowser,
      fetchImpl: fb.fetchImpl,
      timeoutMs: 5000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliLoginError);
    expect(err.reason).toBe("state_mismatch");
    expect(fb.seen.exchangeBody).toBeUndefined();
    expect(existsSync(sidPaths.deviceCredential())).toBe(false);
  });

  test("浏览器一直没回调 → timeout", async () => {
    const err = await performCliLogin(BACKEND, {
      openBrowser: async () => true,
      fetchImpl: fakeBackend().fetchImpl,
      timeoutMs: 50,
    }).catch((e) => e);
    expect(err.reason).toBe("timeout");
  });

  test("device_id 已绑定他人 → 409 映射为 device_conflict，不落盘", async () => {
    const fb = fakeBackend({ exchangeStatus: 409 });
    const err = await performCliLogin(BACKEND, {
      openBrowser: fb.openBrowser,
      fetchImpl: fb.fetchImpl,
      timeoutMs: 5000,
    }).catch((e) => e);
    expect(err.reason).toBe("device_conflict");
    expect(err.message).toContain("logout");
    expect(existsSync(sidPaths.deviceCredential())).toBe(false);
  });
});

describe("exchangeLoginCode 分支", () => {
  const body = { code: "L", verifier: "V", deviceId: "D" };
  const respond = (status: number, json: unknown) =>
    (async () => jsonResponse(status, json)) as unknown as typeof fetch;

  test("400 / 401（登录码重放、verifier 不匹配、用户被吊销）→ rejected", async () => {
    for (const s of [400, 401, 403]) {
      const err = await exchangeLoginCode(BACKEND, body, respond(s, { detail: "x" })).catch(
        (e) => e,
      );
      expect(err.reason).toBe("rejected");
    }
  });

  test("5xx → server_error；网络异常 → network", async () => {
    expect((await exchangeLoginCode(BACKEND, body, respond(502, {})).catch((e) => e)).reason).toBe(
      "server_error",
    );
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await exchangeLoginCode(BACKEND, body, boom).catch((e) => e)).reason).toBe("network");
  });

  test("200 但缺 credential → bad_response", async () => {
    const err = await exchangeLoginCode(BACKEND, body, respond(200, { user: {} })).catch((e) => e);
    expect(err.reason).toBe("bad_response");
  });
});

describe("logout / verify", () => {
  test("logout：通知后端解绑 + 删本地凭据", async () => {
    saveDeviceCredential({ credential: "c1", user: { name: "A" } });
    let auth = "";
    const fetchImpl = (async (_u: any, init: any) => {
      auth = init.headers.Authorization;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    const r = await performCliLogout(BACKEND, fetchImpl);
    expect(auth).toBe("Bearer c1");
    expect(r).toMatchObject({ hadCredential: true, remote: "ok" });
    expect(existsSync(sidPaths.deviceCredential())).toBe(false);
  });

  test("logout：后端没有解绑端点（旧后端 404）→ 仍删本地，标 unsupported", async () => {
    saveDeviceCredential({ credential: "c1" });
    const r = await performCliLogout(BACKEND, (async () =>
      jsonResponse(404, {})) as unknown as typeof fetch);
    expect(r.remote).toBe("unsupported");
    expect(getDeviceCredential()).toBeNull();
  });

  test("logout：无后端 → 只删本地", async () => {
    saveDeviceCredential({ credential: "c1" });
    const r = await performCliLogout(null);
    expect(r).toMatchObject({ hadCredential: true, remote: "skipped" });
  });

  test("verify：401 → unauthorized（服务端吊销能被发现）", async () => {
    const r = await verifyCredentialRemote(BACKEND, "c1", (async () =>
      jsonResponse(401, {})) as unknown as typeof fetch);
    expect(r.kind).toBe("unauthorized");
  });
});

describe("getIdentity 优先读登录态", () => {
  test("登录态 union_id 优先于 env / settings，不一致时告警一次", () => {
    process.env.SID_CODE_IDENTITY_USER_ID = "self-claimed@corp.com";
    setIdentityConfig({ userId: "settings@corp.com", orgId: "corp" });
    expect(getIdentity().userId).toBe("self-claimed@corp.com");

    saveDeviceCredential({ credential: "c", user: { id: "7", unionId: "on_abc" } });
    const id = getIdentity();
    expect(id.userId).toBe("on_abc");
    expect(id.orgId).toBe("corp"); // org / team 仍来自配置
    getIdentity();
    const mismatchWarns = warnSpy!.mock.calls.filter((c: any[]) => String(c[1]).includes("不一致"));
    expect(mismatchWarns.length).toBe(1);
  });

  test("没有 union_id 时回落到后端 users 主键", () => {
    saveDeviceCredential({ credential: "c", user: { id: "7", name: "张三" } });
    expect(getIdentity().userId).toBe("7");
  });

  test("注册码流程的凭据（无 user 段）不改变 userId", () => {
    process.env.SID_CODE_IDENTITY_USER_ID = "a@corp.com";
    saveDeviceCredential({ credential: "c" });
    expect(getIdentity().userId).toBe("a@corp.com");
  });

  test("凭据文件 round-trip：user 段 snake_case 落盘、读回 camelCase", () => {
    writeFileSync(
      sidPaths.deviceCredential(),
      JSON.stringify({ credential: "c", user: { id: 9, name: "李四", union_id: "on_x" } }),
    );
    __resetIdentityForTest();
    expect(getDeviceCredential()?.user).toEqual({ id: "9", name: "李四", unionId: "on_x" });
  });
});

test("buildCliStartUrl 只带 challenge，不带 verifier", () => {
  const u = new URL(
    buildCliStartUrl(BACKEND, { port: 5000, challenge: "C", cliState: "s", deviceId: "D" }),
  );
  expect([...u.searchParams.keys()].sort()).toEqual(
    ["challenge", "challenge_method", "cli_state", "device_id", "port"].sort(),
  );
});
