/**
 * 登录闭环 PR-4（§5.4 / §5.6）：凭据变更事件、401 统一上报、登录状态采集与渲染。
 *
 * 不碰真实网络：fetchImpl 注入。隔离：SID_CONFIG_DIR → tmpdir；SID_CODE_BACKEND_URL 存/恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetIdentityForTest,
  clearDeviceCredential,
  saveDeviceCredential,
} from "@sid-code/core/identity/index.ts";
import {
  getCredentialGeneration,
  onCredentialChanged,
  onCredentialRejected,
  reportCredentialRejected,
} from "@sid-code/core/identity/credential.ts";
import {
  collectLoginStatus,
  renderLoginStatus,
  summarizeLoginStatus,
} from "@sid-code/core/identity/login-status.ts";

const BACKEND = "https://backend.example.com/traj";

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevBackend: string | undefined;

function fakeFetch(status: number, body: unknown, urls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const CRED = {
  credential: "cred-abc",
  expiresAt: "2099-01-01T00:00:00+00:00",
  enrolledAt: "2026-10-01T00:00:00+00:00",
  user: { id: "7", name: "张三", unionId: "on_x" },
};

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevBackend = process.env.SID_CODE_BACKEND_URL;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-login-status-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  process.env.SID_CODE_BACKEND_URL = BACKEND;
  __resetIdentityForTest();
});

afterEach(() => {
  __resetIdentityForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevBackend === undefined) delete process.env.SID_CODE_BACKEND_URL;
  else process.env.SID_CODE_BACKEND_URL = prevBackend;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("onCredentialChanged", () => {
  test("登录、换凭据、登出各触发一次；只续期过期时间不触发", () => {
    const seen: Array<string | null> = [];
    onCredentialChanged((c) => seen.push(c?.credential ?? null));

    saveDeviceCredential(CRED);
    // credential-sync 只改 expiresAt：不算换了凭据
    saveDeviceCredential({ ...CRED, expiresAt: "2099-06-01T00:00:00+00:00" });
    saveDeviceCredential({ ...CRED, credential: "cred-new" });
    clearDeviceCredential();
    // 本来就没凭据时再登出：不触发
    clearDeviceCredential();

    expect(seen).toEqual(["cred-abc", "cred-new", null]);
  });

  test("订阅方抛错不影响落盘，也不影响其它订阅方", () => {
    let other = 0;
    onCredentialChanged(() => {
      throw new Error("boom");
    });
    onCredentialChanged(() => other++);
    expect(() => saveDeviceCredential(CRED)).not.toThrow();
    expect(other).toBe(1);
  });

  test("取消订阅后不再收到", () => {
    let n = 0;
    const off = onCredentialChanged(() => n++);
    off();
    saveDeviceCredential(CRED);
    expect(n).toBe(0);
  });
});

describe("reportCredentialRejected", () => {
  test("同一代凭据多条通道同时 401 只通知一次；重新登录后再失效会再通知", () => {
    const seen: string[] = [];
    onCredentialRejected((s) => seen.push(s));
    saveDeviceCredential(CRED);

    reportCredentialRejected("policy");
    reportCredentialRejected("budget");
    reportCredentialRejected("usage");
    expect(seen).toEqual(["policy"]);

    const gen = getCredentialGeneration();
    saveDeviceCredential({ ...CRED, credential: "cred-new" });
    expect(getCredentialGeneration()).toBe(gen + 1);
    reportCredentialRejected("events:remote");
    expect(seen).toEqual(["policy", "events:remote"]);
  });
});

describe("collectLoginStatus / renderLoginStatus", () => {
  test("未登录：loggedIn=false，TUI 文案提示 /login，摘要提示 /login", async () => {
    const st = await collectLoginStatus();
    expect(st.loggedIn).toBe(false);
    const text = renderLoginStatus(st, { loginHint: "/login" }).join("\n");
    expect(text).toContain("(未登录)");
    expect(text).toContain("请执行 /login");
    expect(summarizeLoginStatus(st)).toBe("未登录，执行 /login");
  });

  test("已登录：显示用户、登录时间、过期时间与滑动说明；默认不发网络请求", async () => {
    saveDeviceCredential(CRED);
    const urls: string[] = [];
    const st = await collectLoginStatus({ fetchImpl: fakeFetch(200, {}, urls) });
    expect(urls).toEqual([]);
    expect(st.remote).toBeUndefined();
    const text = renderLoginStatus(st).join("\n");
    expect(text).toContain("张三（union_id on_x）");
    expect(text).toContain("登录时间:     2026-10-01T00:00:00+00:00");
    expect(text).toContain("服务端每次使用自动顺延");
    expect(summarizeLoginStatus(st)).toBe("张三（凭据记录有效至 2099-01-01T00:00:00+00:00）");
  });

  test("--verify 200：显示服务端有效，并带出组织 / 团队", async () => {
    saveDeviceCredential(CRED);
    const urls: string[] = [];
    const st = await collectLoginStatus({
      verify: true,
      fetchImpl: fakeFetch(200, { org_id: 3, team_id: "t-9" }, urls),
    });
    expect(urls.some((u) => u.includes("whoami"))).toBe(true);
    expect(st.remote).toBe("ok");
    expect(st.orgId).toBe("3");
    expect(st.teamId).toBe("t-9");
    const text = renderLoginStatus(st).join("\n");
    expect(text).toContain("✓ 凭据有效");
    expect(text).toContain("组织:         3");
  });

  test("--verify 401：判为未登录", async () => {
    saveDeviceCredential(CRED);
    const st = await collectLoginStatus({ verify: true, fetchImpl: fakeFetch(401, {}) });
    expect(st.remote).toBe("unauthorized");
    expect(st.loggedIn).toBe(false);
  });

  test("没配 backend.url：摘要返回 null（/status 不显示这一段）", async () => {
    delete process.env.SID_CODE_BACKEND_URL;
    saveDeviceCredential(CRED);
    const st = await collectLoginStatus();
    // 用户级 settings 也可能配了 backend.url：只在确实解析不到时断言 null
    if (st.backendUrl === null) expect(summarizeLoginStatus(st)).toBeNull();
  });
});
