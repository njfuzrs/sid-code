/**
 * `auth status` 登录段（B1 / B3 回归，2026-10-14）。
 *
 * 服务端是滑动续期，本地 expires_at 是登录时快照：
 * - 本地快照过期不算登出（loggedIn 仍为 true，凭据照常携带）
 * - `--verify` 在本地快照过期时也必须调服务端核验，否则用户无法自查
 *
 * 走公开入口 handleAuthCommand(["status", "--json"])，不为测试额外导出内部函数
 * （命令体系门禁会把只被测试引用的导出计为死导出）。
 *
 * 隔离：SID_CONFIG_DIR → tmpdir；SID_CODE_BACKEND_URL / fetch / console.log 存恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __resetIdentityForTest, saveDeviceCredential } from "@sid-code/core/identity/index.ts";
import { handleAuthCommand } from "../../src/command/auth.ts";

const BACKEND = "https://backend.example.com/traj";

interface LoginJson {
  loggedIn: boolean;
  expired: boolean;
  enrolledAt: string | null;
  remote?: string;
}

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevBackend: string | undefined;
const origFetch = globalThis.fetch;
let fetchedUrls: string[];
let logSpy: ReturnType<typeof spyOn> | undefined;

function stubFetch(status: number): void {
  globalThis.fetch = (async (url: unknown) => {
    fetchedUrls.push(String(url));
    return new Response("{}", { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** 跑 `auth status --json [--verify]`，取输出里的 login 段 */
async function status(verify: boolean): Promise<LoginJson> {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await handleAuthCommand(["status", "--json", ...(verify ? ["--verify"] : [])]);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((s: string) => s.trimStart().startsWith("{"));
    expect(out).toBeDefined();
    return (JSON.parse(out!) as { login: LoginJson }).login;
  } finally {
    logSpy.mockRestore();
    logSpy = undefined;
  }
}

const whoamiCalls = () => fetchedUrls.filter((u) => u.includes("whoami"));

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevBackend = process.env.SID_CODE_BACKEND_URL;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-auth-status-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  process.env.SID_CODE_BACKEND_URL = BACKEND;
  fetchedUrls = [];
  __resetIdentityForTest();
});

afterEach(() => {
  logSpy?.mockRestore();
  globalThis.fetch = origFetch;
  __resetIdentityForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevBackend === undefined) delete process.env.SID_CODE_BACKEND_URL;
  else process.env.SID_CODE_BACKEND_URL = prevBackend;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth status 登录段：本地快照过期", () => {
  const expired = {
    credential: "c-exp",
    expiresAt: "2020-01-01T00:00:00Z",
    enrolledAt: "2019-10-01T00:00:00Z",
    user: { name: "张三" },
  };

  test("不加 --verify：本地过期仍算已登录，带出登录时间，不调 whoami", async () => {
    saveDeviceCredential(expired);
    stubFetch(200);
    const st = await status(false);
    expect(st.expired).toBe(true);
    expect(st.loggedIn).toBe(true);
    expect(st.enrolledAt).toBe("2019-10-01T00:00:00Z");
    expect(st.remote).toBeUndefined();
    expect(whoamiCalls().length).toBe(0);
  });

  test("--verify 本地过期也调服务端；200 → ok 且仍登录（B3）", async () => {
    saveDeviceCredential(expired);
    stubFetch(200);
    const st = await status(true);
    // 登录段核验必调一次；企业通道探测视配置可能再探一次 whoami，所以只断言「至少一次」
    expect(whoamiCalls().length).toBeGreaterThanOrEqual(1);
    expect(st.remote).toBe("ok");
    expect(st.loggedIn).toBe(true);
  });

  test("--verify 本地过期且服务端 401 → unauthorized、未登录", async () => {
    saveDeviceCredential(expired);
    stubFetch(401);
    const st = await status(true);
    expect(st.remote).toBe("unauthorized");
    expect(st.loggedIn).toBe(false);
  });

  test("--verify 无凭据 → skipped，不调 whoami", async () => {
    stubFetch(200);
    const st = await status(true);
    expect(st.remote).toBe("skipped");
    expect(st.loggedIn).toBe(false);
    expect(whoamiCalls().length).toBe(0);
  });
});
