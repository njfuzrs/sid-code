/**
 * 登录闭环 §5.1 方案 A：启动时按服务端 whoami 回写凭据过期时间。
 *
 * 不碰真实网络：fetchImpl 注入。隔离：SID_CONFIG_DIR → tmpdir，存/恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  __resetIdentityForTest,
  getDeviceCredential,
  saveDeviceCredential,
} from "@sid-code/core/identity/index.ts";
import {
  CREDENTIAL_SYNC_INTERVAL_MS,
  syncCredentialFromServer,
} from "@sid-code/core/identity/credential-sync.ts";

const BACKEND = "https://backend.example/traj";
const OLD_EXPIRY = "2026-01-01T00:00:00+00:00";
const NEW_EXPIRY = "2027-01-12T08:00:00+00:00";

let tmpDir: string;
let prevConfigDir: string | undefined;

interface Call {
  url: string;
  auth: string | undefined;
}

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), auth: headers.Authorization });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function readFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(sidPaths.deviceCredential(), "utf-8"));
}

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-cred-sync-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetIdentityForTest();
  saveDeviceCredential({
    credential: "cred-abc",
    expiresAt: OLD_EXPIRY,
    enrolledAt: "2025-10-03T00:00:00+00:00",
    user: { id: "7", name: "张三", unionId: "on_x" },
  });
});

afterEach(() => {
  __resetIdentityForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("syncCredentialFromServer", () => {
  test("whoami 带 expires_at：回写本地文件，其它字段保留", async () => {
    const calls: Call[] = [];
    const r = await syncCredentialFromServer({
      backendUrl: BACKEND,
      fetchImpl: fakeFetch(200, { device_id: "d", org_id: "o", expires_at: NEW_EXPIRY }, calls),
    });
    expect(r).toEqual({ kind: "updated", expiresAt: NEW_EXPIRY });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/ctl/whoami`);
    expect(calls[0]!.auth).toBe("Bearer cred-abc");

    const file = readFile();
    expect(file.expires_at).toBe(NEW_EXPIRY);
    expect(file.credential).toBe("cred-abc");
    expect(file.enrolled_at).toBe("2025-10-03T00:00:00+00:00");
    expect(file.user).toEqual({ id: "7", name: "张三", union_id: "on_x" });
    // 进程内缓存也同步了
    expect(getDeviceCredential()?.expiresAt).toBe(NEW_EXPIRY);
  });

  test("本地已过期仍会发请求：同步不能被 B1 自己拦住", async () => {
    const calls: Call[] = [];
    // OLD_EXPIRY 早于 now
    const r = await syncCredentialFromServer({
      backendUrl: BACKEND,
      now: Date.parse("2026-10-14T00:00:00Z"),
      fetchImpl: fakeFetch(200, { expires_at: NEW_EXPIRY }, calls),
    });
    expect(calls[0]?.auth).toBe("Bearer cred-abc");
    expect(r.kind).toBe("updated");
  });

  test("旧后端（无 expires_at）：本地文件不动", async () => {
    const before = readFileSync(sidPaths.deviceCredential(), "utf-8");
    const r = await syncCredentialFromServer({
      backendUrl: BACKEND,
      fetchImpl: fakeFetch(200, { device_id: "d", org_id: "o" }),
    });
    expect(r).toEqual({ kind: "no-field" });
    expect(readFileSync(sidPaths.deviceCredential(), "utf-8")).toBe(before);
  });

  test("expires_at 为空串或无法解析：视为无字段，不写坏本地", async () => {
    for (const bad of ["", "not-a-date", 123]) {
      __resetIdentityForTest();
      const r = await syncCredentialFromServer({
        backendUrl: BACKEND,
        force: true,
        fetchImpl: fakeFetch(200, { expires_at: bad }),
      });
      expect(r).toEqual({ kind: "no-field" });
      expect(readFile().expires_at).toBe(OLD_EXPIRY);
    }
  });

  test("401：不改、不删本地凭据（删凭据是 logout 的职责）", async () => {
    const r = await syncCredentialFromServer({
      backendUrl: BACKEND,
      fetchImpl: fakeFetch(401, { detail: "Unauthorized" }),
    });
    expect(r).toEqual({ kind: "unauthorized" });
    expect(existsSync(sidPaths.deviceCredential())).toBe(true);
    expect(readFile().expires_at).toBe(OLD_EXPIRY);
  });

  test("网络错误：不改本地，也不记节流（下次启动再试）", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await syncCredentialFromServer({ backendUrl: BACKEND, fetchImpl: failing });
    expect(r).toEqual({ kind: "error", detail: "ECONNREFUSED" });
    expect(readFile().expires_at).toBe(OLD_EXPIRY);
    expect(existsSync(sidPaths.stateFile("credential-sync.json"))).toBe(false);
  });

  test("24 小时内只同步一次；超过间隔或 force 时再发", async () => {
    const calls: Call[] = [];
    const t0 = Date.parse("2026-10-14T00:00:00Z");
    const f = fakeFetch(200, { expires_at: NEW_EXPIRY }, calls);

    await syncCredentialFromServer({ backendUrl: BACKEND, now: t0, fetchImpl: f });
    expect(calls).toHaveLength(1);

    const throttled = await syncCredentialFromServer({
      backendUrl: BACKEND,
      now: t0 + CREDENTIAL_SYNC_INTERVAL_MS - 1,
      fetchImpl: f,
    });
    expect(throttled).toEqual({ kind: "skipped", reason: "throttled" });
    expect(calls).toHaveLength(1);

    await syncCredentialFromServer({ backendUrl: BACKEND, now: t0 + 1, force: true, fetchImpl: f });
    expect(calls).toHaveLength(2);

    // force 也记一次同步：节流窗口从 t0+1 重新起算
    await syncCredentialFromServer({
      backendUrl: BACKEND,
      now: t0 + CREDENTIAL_SYNC_INTERVAL_MS,
      fetchImpl: f,
    });
    expect(calls).toHaveLength(2);

    await syncCredentialFromServer({
      backendUrl: BACKEND,
      now: t0 + 1 + CREDENTIAL_SYNC_INTERVAL_MS,
      fetchImpl: f,
    });
    expect(calls).toHaveLength(3);
  });

  test("值与本地一致：unchanged", async () => {
    const r = await syncCredentialFromServer({
      backendUrl: BACKEND,
      fetchImpl: fakeFetch(200, { expires_at: OLD_EXPIRY }),
    });
    expect(r).toEqual({ kind: "unchanged" });
  });

  test("请求期间凭据被重新登录替换：不覆盖新凭据", async () => {
    const swapping = (async () => {
      saveDeviceCredential({ credential: "cred-new", expiresAt: "2027-06-01T00:00:00+00:00" });
      return new Response(JSON.stringify({ expires_at: NEW_EXPIRY }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await syncCredentialFromServer({ backendUrl: BACKEND, fetchImpl: swapping });
    expect(r).toEqual({ kind: "unchanged" });
    const file = readFile();
    expect(file.credential).toBe("cred-new");
    expect(file.expires_at).toBe("2027-06-01T00:00:00+00:00");
  });

  test("没配后端 / 没有凭据：不发请求", async () => {
    const calls: Call[] = [];
    const f = fakeFetch(200, { expires_at: NEW_EXPIRY }, calls);
    expect(await syncCredentialFromServer({ backendUrl: null, fetchImpl: f })).toEqual({
      kind: "skipped",
      reason: "no-backend",
    });

    writeFileSync(sidPaths.deviceCredential(), "{}", "utf-8");
    __resetIdentityForTest();
    expect(await syncCredentialFromServer({ backendUrl: BACKEND, fetchImpl: f })).toEqual({
      kind: "skipped",
      reason: "no-credential",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("启动接线", () => {
  test("initTelemetrySystem 后台调用 startCredentialSync()", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/init-helpers.ts"), "utf-8");
    expect(/\bstartCredentialSync\(\);/.test(src)).toBe(true);
    // 不能 await：同步失败或慢不能挡启动
    expect(/await\s+startCredentialSync\(/.test(src)).toBe(false);
  });
});
