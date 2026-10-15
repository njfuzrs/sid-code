/**
 * `auth enroll`（D2 注册码通道）CLI 层：参数解析、成功输出、错误路径提示。
 *
 * 走公开入口 handleAuthCommand（不为测试新增导出——命令体系 G1 死导出门禁）。
 * 错误路径的 process.exit(1) 用 spy 拦成异常，测试进程不退出。
 * 隔离：SID_CONFIG_DIR → tmpdir；SID_CODE_BACKEND_URL / fetch / console 存恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __resetIdentityForTest, getDeviceCredential } from "@sid-code/core/identity/index.ts";
import { handleAuthCommand } from "../../src/command/auth.ts";

const BACKEND = "https://backend.example.com/traj";

class ProcessExitError extends Error {
  constructor(readonly code: number | string | undefined) {
    super(`process.exit(${code})`);
  }
}

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevBackend: string | undefined;
const origFetch = globalThis.fetch;
let exitSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let fetchedUrls: string[];

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async (url: unknown) => {
    fetchedUrls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const okBody = {
  credential: "dev-cred-1",
  expires_at: "2099-01-01T00:00:00Z",
  device_id: "dev-x",
  org_id: "corp-shanghai",
  team_id: "infra",
};

const logText = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
const errText = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
const jsonOut = () => {
  const out = logSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .find((s: string) => s.trimStart().startsWith("{"));
  expect(out).toBeDefined();
  return JSON.parse(out!) as Record<string, unknown>;
};

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevBackend = process.env.SID_CODE_BACKEND_URL;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-auth-enroll-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  process.env.SID_CODE_BACKEND_URL = BACKEND;
  fetchedUrls = [];
  __resetIdentityForTest();
  exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  globalThis.fetch = origFetch;
  __resetIdentityForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevBackend === undefined) delete process.env.SID_CODE_BACKEND_URL;
  else process.env.SID_CODE_BACKEND_URL = prevBackend;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth enroll", () => {
  test("成功：POST /ctl/enroll，凭据落盘，输出组织 / 团队与有效期", async () => {
    stubFetch(201, okBody);
    await handleAuthCommand([
      "enroll",
      "--code",
      "code-1",
      "--org",
      "corp-shanghai",
      "--team",
      "infra",
    ]);

    expect(fetchedUrls[0]).toBe(`${BACKEND}/api/v1/ctl/enroll`);
    expect(logText()).toContain("注册成功：corp-shanghai / infra");
    expect(logText()).toContain("凭据有效期至 2099-01-01T00:00:00Z");
    expect(getDeviceCredential()?.credential).toBe("dev-cred-1");
  });

  test("--json：输出结构化结果", async () => {
    stubFetch(201, okBody);
    await handleAuthCommand(["enroll", "--code", "code-1", "--org", "corp-shanghai", "--json"]);

    const parsed = jsonOut();
    expect(parsed.ok).toBe(true);
    expect(parsed.orgId).toBe("corp-shanghai");
    expect(parsed.teamId).toBe("infra");
    expect(parsed.expiresAt).toBe("2099-01-01T00:00:00Z");
  });

  test("--code=value 等号形式同样可用", async () => {
    stubFetch(201, okBody);
    await handleAuthCommand(["enroll", "--code=code-1", "--org=corp-shanghai"]);
    expect(fetchedUrls[0]).toBe(`${BACKEND}/api/v1/ctl/enroll`);
  });

  test("缺 --code 或 --org：给用法并以 1 退出，不发请求", async () => {
    await expect(handleAuthCommand(["enroll", "--org", "corp-shanghai"])).rejects.toThrow(
      ProcessExitError,
    );
    expect(errText()).toContain("用法: sid-code auth enroll --code <注册码> --org <组织ID>");

    await expect(handleAuthCommand(["enroll", "--code", "c"])).rejects.toThrow(ProcessExitError);
    expect(fetchedUrls.length).toBe(0);
  });

  test("服务端 403：提示未开启注册端点（指向管理员）并以 1 退出", async () => {
    stubFetch(403, { detail: "enroll is disabled" });
    await expect(
      handleAuthCommand(["enroll", "--code", "c", "--org", "corp-shanghai"]),
    ).rejects.toThrow(ProcessExitError);
    expect(errText()).toContain("未开启注册端点");
    expect(errText()).toContain("管理员");
  });

  test("服务端 401：提示码无效 / 已用 / 过期", async () => {
    stubFetch(401, { detail: "Invalid enroll token" });
    await expect(
      handleAuthCommand(["enroll", "--code", "c", "--org", "corp-shanghai"]),
    ).rejects.toThrow(ProcessExitError);
    expect(errText()).toContain("注册码无效");
  });

  test("--json + 失败：输出 ok:false 与机器可读 reason", async () => {
    stubFetch(403, { detail: "enroll is disabled" });
    await expect(
      handleAuthCommand(["enroll", "--code", "c", "--org", "corp-shanghai", "--json"]),
    ).rejects.toThrow(ProcessExitError);
    const parsed = jsonOut();
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("disabled");
  });

  test("未配置 backend.url：给配置提示，不发请求", async () => {
    delete process.env.SID_CODE_BACKEND_URL;
    await expect(
      handleAuthCommand(["enroll", "--code", "c", "--org", "corp-shanghai"]),
    ).rejects.toThrow(ProcessExitError);
    expect(errText()).toContain("未配置后端地址");
    expect(fetchedUrls.length).toBe(0);
  });
});
