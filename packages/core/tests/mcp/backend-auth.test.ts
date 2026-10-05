/**
 * MCP auth:"sid-backend"（P4）：设备凭据只发往 backend.url 同 origin。
 *
 * 隔离：SID_CONFIG_DIR 指 tmpdir（凭据与 settings 都落在那里），SID_CODE_BACKEND_URL 存取复原。
 * 端到端用例起两个本地 MCP（同 origin / 异 origin），断言服务端真正收到的 Authorization，
 * 而不是只看 headers 对象——外泄发生在网络上，镜头要对准网络。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import {
  BackendAuthRejectedError,
  buildSidBackendHeaders,
} from "@sid-code/core/mcp/backend-auth.ts";
import { __resetBackendUrlWarningsForTest } from "@sid-code/core/identity/backend-url.ts";
import {
  __resetIdentityForTest,
  clearDeviceCredential,
  saveDeviceCredential,
} from "@sid-code/core/identity/index.ts";
import { validateConfig } from "@sid-code/core/config/schema.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

const ENV_KEYS = ["SID_CONFIG_DIR", "SID_CODE_BACKEND_URL"] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mcp-backend-auth-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  delete process.env.SID_CODE_BACKEND_URL;
  __resetBackendUrlWarningsForTest();
  __resetIdentityForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetIdentityForTest();
  rmSync(tmpHome, { recursive: true, force: true });
});

function login(token = "dev-cred-1"): void {
  saveDeviceCredential({ credential: token });
}

describe("buildSidBackendHeaders：origin 校验", () => {
  test("同 origin（含路径差异）→ 注入 Bearer，配置里的 Authorization 被覆盖", () => {
    process.env.SID_CODE_BACKEND_URL = "https://corp.example/traj";
    login();
    const h = buildSidBackendHeaders(
      "feishu-docs",
      "https://corp.example/traj/api/v1/ctl/feishu/mcp",
      { authorization: "Bearer forged", "X-Extra": "1" },
    );
    expect({ ...h }).toEqual({ "X-Extra": "1", Authorization: "Bearer dev-cred-1" });
  });

  const foreign: Array<[string, string]> = [
    ["外部域名", "https://attacker.example/api/v1/ctl/feishu/mcp"],
    ["子域名", "https://evil.corp.example/traj/mcp"],
    ["前缀相同的域名", "https://corp.example.attacker.example/traj/mcp"],
    ["端口不同", "https://corp.example:8443/traj/mcp"],
    ["协议降级", "http://corp.example/traj/mcp"],
    ["userinfo 伪装", "https://corp.example@attacker.example/traj/mcp"],
    ["websocket", "wss://corp.example/traj/mcp"],
  ];
  for (const [label, url] of foreign) {
    test(`异 origin（${label}）→ 拒绝`, () => {
      process.env.SID_CODE_BACKEND_URL = "https://corp.example/traj";
      login();
      expect(() => buildSidBackendHeaders("p", url, undefined)).toThrow(BackendAuthRejectedError);
    });
  }

  test("未配置 backend.url → 拒绝（不是不带凭据照连）", () => {
    login();
    expect(() => buildSidBackendHeaders("p", "https://corp.example/mcp", undefined)).toThrow(
      /未配置合法的 backend\.url/,
    );
  });

  test("未登录 → 拒绝并提示重新登录", () => {
    process.env.SID_CODE_BACKEND_URL = "https://corp.example/traj";
    expect(() => buildSidBackendHeaders("p", "https://corp.example/traj/mcp", undefined)).toThrow(
      /auth login/,
    );
  });

  test("每次读取都取最新凭据：续期后换新值，登出后不再发旧值", () => {
    process.env.SID_CODE_BACKEND_URL = "https://corp.example/traj";
    login("old");
    const h = buildSidBackendHeaders("p", "https://corp.example/traj/mcp", undefined);
    expect({ ...h }.Authorization).toBe("Bearer old");
    login("renewed");
    expect({ ...h }.Authorization).toBe("Bearer renewed");
    clearDeviceCredential();
    expect({ ...h }.Authorization).toBe("Bearer ");
  });
});

describe("MCPManager 端到端：服务端实际收到的 Authorization", () => {
  /** 最小 Streamable HTTP MCP：记录每个请求的 Authorization，initialize / tools/list 应答 */
  function startMcp(seen: Array<string | null>) {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push(req.headers.get("authorization"));
        const msg = (await req.json()) as { id?: number; method: string };
        if (msg.id === undefined) return new Response(null, { status: 202 });
        const result =
          msg.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "t", version: "1" },
              }
            : msg.method === "tools/list"
              ? { tools: [{ name: "feishu_doc_read", inputSchema: { type: "object" } }] }
              : {};
        return Response.json({ jsonrpc: "2.0", id: msg.id, result });
      },
    });
  }

  test("同 origin 带凭据连上；异 origin 一个请求都不发", async () => {
    const backendSeen: Array<string | null> = [];
    const attackerSeen: Array<string | null> = [];
    const backend = startMcp(backendSeen);
    // localhost 与 127.0.0.1 是不同 origin，正好模拟「外部」服务器
    const attacker = startMcp(attackerSeen);
    process.env.SID_CODE_BACKEND_URL = `http://127.0.0.1:${backend.port}/traj`;
    login("e2e-cred");

    const manager = new MCPManager();
    try {
      const servers: Record<string, MCPServerConfig> = {
        ok: {
          transport: "http",
          url: `http://127.0.0.1:${backend.port}/traj/api/v1/ctl/feishu/mcp`,
          auth: "sid-backend",
          retries: 0,
        },
        evil: {
          transport: "http",
          url: `http://localhost:${attacker.port}/mcp`,
          auth: "sid-backend",
          retries: 0,
        },
      };
      const tools = await manager.connectAll(servers);
      expect(tools.map((t) => t.name())).toEqual(["mcp__ok__feishu_doc_read"]);
      expect(backendSeen.length).toBeGreaterThan(0);
      expect(backendSeen.every((a) => a === "Bearer e2e-cred")).toBe(true);
      expect(attackerSeen).toEqual([]);
    } finally {
      manager.closeAll();
      backend.stop(true);
      attacker.stop(true);
    }
  });
});

describe("validateConfig：auth 字段", () => {
  test("拼错的 auth 值报错，不静默当没写", () => {
    const r = validateConfig({
      mcpServers: { x: { transport: "http", url: "https://a.example", auth: "sid_backend" } },
    } as never);
    expect(r.errors.some((e) => e.path === "mcpServers.x.auth")).toBe(true);
  });

  test("stdio + sid-backend 报错", () => {
    const r = validateConfig({
      mcpServers: { x: { transport: "stdio", command: "echo", auth: "sid-backend" } },
    } as never);
    expect(r.errors.some((e) => e.path === "mcpServers.x.auth")).toBe(true);
  });
});
