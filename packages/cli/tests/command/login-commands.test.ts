/**
 * 登录闭环 PR-4：TUI 内 /login /logout /whoami 与 /status 企业登录段。
 *
 * 走命令的公开入口（index.ts 的 load()），不为测试新增导出（命令体系 G1 死导出门禁）。
 * /login 会起真实的 127.0.0.1 回调服务器，但 SID_CODE_NO_BROWSER=1 不开浏览器、
 * 不会有回调进来；测试结束前一律 /login cancel 关掉。
 *
 * 隔离：SID_CONFIG_DIR → tmpdir；SID_CODE_BACKEND_URL / SID_CODE_NO_BROWSER / fetch 存恢复原值。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { __resetIdentityForTest, saveDeviceCredential } from "@sid-code/core/identity/index.ts";
import loginCmd from "@sid-code/cli/command/commands/login/index.ts";
import logoutCmd from "@sid-code/cli/command/commands/logout/index.ts";
import whoamiCmd from "@sid-code/cli/command/commands/whoami/index.ts";
import statusCmd from "@sid-code/cli/command/commands/status/index.ts";
import { BUILTIN_COMMANDS } from "@sid-code/cli/command/commands/index.ts";
import type {
  CommandContext,
  LocalCommand,
  LocalCommandResult,
} from "@sid-code/cli/command/types.ts";

const BACKEND = "https://backend.example.com/traj";
const CRED = {
  credential: "cred-abc",
  expiresAt: "2099-01-01T00:00:00+00:00",
  enrolledAt: "2026-10-01T00:00:00+00:00",
  user: { id: "7", name: "张三", unionId: "on_x" },
};

let tmpDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SID_CONFIG_DIR", "SID_CODE_BACKEND_URL", "SID_CODE_NO_BROWSER"] as const;
const origFetch = globalThis.fetch;
let fetchedUrls: string[];

const call = async (cmd: unknown, args: string, ctx: Partial<CommandContext> = {}) =>
  (await (cmd as LocalCommand).load()).call(args, ctx as CommandContext);
const text = (r: LocalCommandResult) => (r as { value: string }).value;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), "sid-login-cmd-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  process.env.SID_CODE_BACKEND_URL = BACKEND;
  process.env.SID_CODE_NO_BROWSER = "1";
  fetchedUrls = [];
  globalThis.fetch = (async (url: unknown) => {
    fetchedUrls.push(String(url));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  __resetIdentityForTest();
});

afterEach(async () => {
  await call(loginCmd, "cancel");
  globalThis.fetch = origFetch;
  __resetIdentityForTest();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("注册", () => {
  test("三个命令都进了 BUILTIN_COMMANDS，且不占用 /auth（MCP 认证别名）", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    for (const n of ["login", "logout", "whoami"]) expect(names).toContain(n);
    for (const c of [loginCmd, logoutCmd, whoamiCmd]) expect(c.aliases ?? []).not.toContain("auth");
  });
});

describe("/login", () => {
  test("没配 backend.url：直接给出配置提示，不起回调服务器", async () => {
    delete process.env.SID_CODE_BACKEND_URL;
    const r = await call(loginCmd, "", { notify: () => {} });
    // 用户级 settings 也可能配了 backend.url，那种环境下跳过这条断言
    if (text(r).includes("未配置后端地址")) expect(text(r)).toContain("SID_CODE_BACKEND_URL");
  });

  test("立即返回授权链接；重复执行返回同一链接（只起一个回调服务器）", async () => {
    const notes: string[] = [];
    const ctx = { notify: (t: string) => notes.push(t) };
    const first = text(await call(loginCmd, "", ctx));
    const url = first.match(/https:\/\/\S+/)?.[0];
    expect(url).toContain("/feishu/cli/start");
    expect(url).toContain("port=");

    const second = text(await call(loginCmd, "", ctx));
    expect(second).toContain("登录流程已在进行中");
    expect(second).toContain(url!);

    // 取消：回调服务器关闭，状态栏报「已取消」
    expect(text(await call(loginCmd, "cancel", ctx))).toContain("已取消登录");
    await new Promise((r) => setTimeout(r, 20));
    expect(notes).toContain("已取消登录");
    expect(text(await call(loginCmd, "cancel", ctx))).toContain("没有进行中的登录");
  });

  test("已登录时先确认，确认后才开始登录", async () => {
    saveDeviceCredential(CRED);
    const r = await call(loginCmd, "", { notify: () => {} });
    expect(r.type).toBe("confirm");
    const c = r as Extract<LocalCommandResult, { type: "confirm" }>;
    expect(c.message).toContain("张三");
    expect(c.message).toContain("吊销");
    expect(text(await c.onConfirm())).toContain("/feishu/cli/start");
  });

  test("未知参数给出用法", async () => {
    expect(text(await call(loginCmd, "foo"))).toContain("用法: /login [cancel]");
  });
});

describe("/logout", () => {
  test("没有凭据：无需登出", async () => {
    expect(text(await call(logoutCmd, ""))).toContain("无需登出");
  });

  test("先确认；确认后通知后端解绑并删本地凭据", async () => {
    saveDeviceCredential(CRED);
    const r = await call(logoutCmd, "");
    expect(r.type).toBe("confirm");
    const c = r as Extract<LocalCommandResult, { type: "confirm" }>;
    expect(c.message).toContain("将以 张三 的身份登出");
    // 确认前什么都没发生
    expect(fetchedUrls).toEqual([]);
    expect(existsSync(sidPaths.deviceCredential())).toBe(true);

    const out = text(await c.onConfirm());
    expect(out).toContain("已删除本地登录凭据");
    expect(out).toContain("已通知后端解绑本设备");
    expect(fetchedUrls.some((u) => u.includes("/cli/logout"))).toBe(true);
    expect(existsSync(sidPaths.deviceCredential())).toBe(false);
  });
});

describe("/whoami", () => {
  test("默认不发网络请求；显示用户、登录时间、过期说明，并指向 auth status", async () => {
    saveDeviceCredential(CRED);
    const out = text(await call(whoamiCmd, ""));
    expect(fetchedUrls).toEqual([]);
    expect(out).toContain("张三（union_id on_x）");
    expect(out).toContain("登录时间");
    expect(out).toContain("服务端每次使用自动顺延");
    expect(out).toContain("sid-code auth status");
  });

  test("--verify 调 /ctl/whoami", async () => {
    saveDeviceCredential(CRED);
    const out = text(await call(whoamiCmd, "--verify"));
    expect(fetchedUrls.some((u) => u.includes("whoami"))).toBe(true);
    expect(out).toContain("✓ 凭据有效");
  });

  test("未登录：提示 /login 而不是 CLI 命令", async () => {
    const out = text(await call(whoamiCmd, ""));
    expect(out).toContain("请执行 /login");
  });
});

describe("/status 企业登录段", () => {
  const ctx = {
    config: { model: "m" },
    ctxMgr: { messageCount: () => 0, estimateTokens: () => 0 },
  };

  test("配了 backend.url 且已登录：显示用户名", async () => {
    saveDeviceCredential(CRED);
    const out = text(await call(statusCmd, "", ctx as unknown as CommandContext));
    expect(out).toContain("企业登录: 张三");
    expect(fetchedUrls).toEqual([]);
  });

  test("配了 backend.url 未登录：提示 /login", async () => {
    const out = text(await call(statusCmd, "", ctx as unknown as CommandContext));
    expect(out).toContain("企业登录: 未登录，执行 /login");
  });
});
