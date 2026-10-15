/**
 * D2：注册码通道——一次性码换设备凭据（performCodeEnroll）。
 *
 * 不碰真实网络：fetchImpl 注入。凭据落盘走 saveDeviceCredential（尊重 SID_CONFIG_DIR），
 * 隔离：SID_CONFIG_DIR → tmpdir，存/恢复原值（不无条件 delete，避免抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __resetIdentityForTest, getDeviceCredential } from "@sid-code/core/identity/index.ts";
import { EnrollError, performCodeEnroll } from "@sid-code/core/identity/enroll.ts";

const BACKEND = "https://backend.example/traj";

let tmpDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-enroll-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetIdentityForTest();
});

afterEach(() => {
  __resetIdentityForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** 记录请求并返回指定响应的 fetch 桩 */
function stubFetch(status: number, body: unknown): { fetchImpl: typeof fetch; seen: Seen } {
  const seen: Seen = { url: "", method: "", headers: {}, body: undefined };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    seen.url = String(input);
    seen.method = init?.method ?? "";
    seen.headers = (init?.headers ?? {}) as Record<string, string>;
    seen.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    return jsonResponse(status, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** 跑一次并捕获 EnrollError（成功时 fail） */
async function enrollCatch(
  fetchImpl: typeof fetch,
  opts: { code: string; orgId: string; teamId?: string } = { code: "c", orgId: "corp-shanghai" },
): Promise<EnrollError> {
  try {
    await performCodeEnroll(BACKEND, opts, fetchImpl);
  } catch (err) {
    if (err instanceof EnrollError) return err;
    throw err;
  }
  throw new Error("预期抛出 EnrollError，但调用成功了");
}

const OK_BODY = {
  credential: "dev-cred-1",
  expires_at: "2099-01-01T00:00:00Z",
  device_id: "dev-x",
  org_id: "corp-shanghai",
  team_id: "infra",
};

describe("performCodeEnroll", () => {
  test("成功：POST /ctl/enroll，带 X-Enroll-Token 与请求体，凭据落盘（无 user 段）", async () => {
    const { fetchImpl, seen } = stubFetch(201, OK_BODY);
    const result = await performCodeEnroll(
      BACKEND,
      { code: "one-time-code", orgId: "corp-shanghai", teamId: "infra", version: "0.1.610" },
      fetchImpl,
    );

    expect(seen.url).toBe(`${BACKEND}/api/v1/ctl/enroll`);
    expect(seen.method).toBe("POST");
    expect(seen.headers["X-Enroll-Token"]).toBe("one-time-code");
    expect(seen.body?.org_id).toBe("corp-shanghai");
    expect(seen.body?.team_id).toBe("infra");
    expect(seen.body?.ver).toBe("0.1.610");
    expect(typeof seen.body?.device_id).toBe("string");
    expect(String(seen.body?.device_id ?? "").length).toBeGreaterThan(0);
    expect(typeof seen.body?.platform).toBe("string");

    expect(result.orgId).toBe("corp-shanghai");
    expect(result.teamId).toBe("infra");
    expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");

    const cred = getDeviceCredential();
    expect(cred?.credential).toBe("dev-cred-1");
    expect(cred?.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(cred?.enrolledAt).toBeTruthy();
    // 注册码流程不绑人：凭据不带 user 段（cli-login 才带）
    expect(cred?.user).toBeUndefined();
  });

  test("不带 teamId：请求体省略 team_id", async () => {
    const { fetchImpl, seen } = stubFetch(201, OK_BODY);
    await performCodeEnroll(BACKEND, { code: "c", orgId: "corp-shanghai" }, fetchImpl);
    expect(seen.body !== undefined && "team_id" in seen.body).toBe(false);
  });

  test("组织 / 团队以服务端响应为准（码自带团队绑定时可不同于入参）", async () => {
    const { fetchImpl } = stubFetch(201, { ...OK_BODY, team_id: "bound-team" });
    const result = await performCodeEnroll(
      BACKEND,
      { code: "c", orgId: "corp-shanghai" },
      fetchImpl,
    );
    expect(result.teamId).toBe("bound-team");
  });

  test("403：注册端点未开启 → disabled，提示指向管理员", async () => {
    const { fetchImpl } = stubFetch(403, { detail: "enroll is disabled" });
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("disabled");
    expect(err.message).toContain("CTL_ENROLL_ENABLED");
  });

  test("401：码无效 / 已用过 / 过期 → rejected", async () => {
    const { fetchImpl } = stubFetch(401, { detail: "Invalid enroll token" });
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("rejected");
  });

  test("409：设备冲突 → conflict，带服务端 detail 与解绑指引", async () => {
    const { fetchImpl } = stubFetch(409, {
      detail: "device is bound to a user; run `sid-code auth logout` first",
    });
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("conflict");
    expect(err.message).toContain("auth logout");
  });

  test("网络错误 → network", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("network");
  });

  test("响应缺 credential → bad_response", async () => {
    const { fetchImpl } = stubFetch(201, { expires_at: "2099-01-01T00:00:00Z" });
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("bad_response");
  });

  test("响应不是 JSON → bad_response", async () => {
    const fetchImpl = (async () =>
      new Response("<html>nginx</html>", { status: 201 })) as unknown as typeof fetch;
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("bad_response");
  });

  test("5xx → server_error", async () => {
    const { fetchImpl } = stubFetch(500, { detail: "boom" });
    const err = await enrollCatch(fetchImpl);
    expect(err.reason).toBe("server_error");
  });
});
