/**
 * MCP OAuth 核心流程集成测试
 * 用本地 mock HTTP 服务器模拟 OAuth 授权服务器，测试完整链路：
 *   discovery → 动态注册 → 授权码交换 → token 刷新 → NeedsAuthorizationError
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

let tmpDir: string;
let prevConfigDir: string | undefined;
let mockAS: Server;
let mockASPort: number;
let mockASUrl: string;

// 测试用临时配置目录
beforeEach(async () => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-oauth-core-"));
  process.env.SID_CONFIG_DIR = tmpDir;

  // 启动 mock 授权服务器
  await startMockAuthServer();
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  mockAS?.close();
});

/** 启动 mock 授权服务器：提供 metadata、注册、token 端点 */
function startMockAuthServer(): Promise<void> {
  return new Promise((resolve) => {
    mockAS = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const path = url.pathname;

      // RFC 8414 metadata
      if (path === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: mockASUrl,
            authorization_endpoint: `${mockASUrl}/authorize`,
            token_endpoint: `${mockASUrl}/token`,
            registration_endpoint: `${mockASUrl}/register`,
            scopes_supported: ["read", "write"],
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
          }),
        );
        return;
      }

      // RFC 7591 动态注册
      if (path === "/register" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              client_id: "dyn-client-001",
              client_name: parsed.client_name,
              redirect_uris: parsed.redirect_uris,
            }),
          );
        });
        return;
      }

      // Token 端点
      if (path === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const params = new URLSearchParams(body);
          const grantType = params.get("grant_type");

          if (grantType === "authorization_code") {
            // 验证 PKCE（code_verifier 存在）
            const codeVerifier = params.get("code_verifier");
            if (!codeVerifier) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "invalid_request",
                  error_description: "missing code_verifier",
                }),
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: "access-token-001",
                refresh_token: "refresh-token-001",
                expires_in: 3600,
                scope: "read write",
                token_type: "Bearer",
              }),
            );
            return;
          }

          if (grantType === "refresh_token") {
            const rt = params.get("refresh_token");
            if (rt === "invalid-rt") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            // 模拟恶意授权服务器：刷新时返回越权 scope（RFC 6749 §6 违规）
            if (rt === "escalate-rt") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  access_token: "escalated-token",
                  refresh_token: "escalate-rt",
                  expires_in: 3600,
                  scope: "read write admin", // 原始只授予 read，这里多出 write admin
                  token_type: "Bearer",
                }),
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: "access-token-refreshed",
                refresh_token: "refresh-token-002",
                expires_in: 3600,
                scope: "read write",
                token_type: "Bearer",
              }),
            );
            return;
          }

          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unsupported_grant_type" }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    mockAS.listen(0, "127.0.0.1", () => {
      const addr = mockAS.address() as { port: number };
      mockASPort = addr.port;
      mockASUrl = `http://localhost:${mockASPort}`;
      resolve();
    });
  });
}

describe("oauth core", () => {
  test("discoverAuthServerMetadata 通过 RFC 8414 发现元数据", async () => {
    const { discoverAuthServerMetadata } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };
    const meta = await discoverAuthServerMetadata("test", mockASUrl, cfg);
    expect(meta).toBeDefined();
    expect(meta!.issuer).toBe(mockASUrl);
    expect(meta!.authorization_endpoint).toBe(`${mockASUrl}/authorize`);
    expect(meta!.token_endpoint).toBe(`${mockASUrl}/token`);
    expect(meta!.registration_endpoint).toBe(`${mockASUrl}/register`);
  });

  test("discoverAuthServerMetadata 配置 authServerMetadataUrl 强制 https 校验", async () => {
    const { discoverAuthServerMetadata } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = {
      transport: "http",
      url: mockASUrl,
      oauth: { authServerMetadataUrl: "http://evil.com/meta" },
    };
    await expect(discoverAuthServerMetadata("test", mockASUrl, cfg)).rejects.toThrow("https://");
  });

  test("getValidAccessToken 无凭据时抛 NeedsAuthorizationError", async () => {
    const { getValidAccessToken, NeedsAuthorizationError } =
      await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };
    await expect(getValidAccessToken("test", cfg)).rejects.toBeInstanceOf(NeedsAuthorizationError);
  });

  test("getValidAccessToken 有有效 token 时直接返回", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const { getValidAccessToken } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };
    // 手动写入一个有效 token（过期时间在未来）
    store.saveTokens("test", cfg, { access_token: "valid-token", expires_in: 7200 });
    const token = await getValidAccessToken("test", cfg);
    expect(token).toBe("valid-token");
  });

  test("getValidAccessToken token 过期+有 refresh_token 时自动刷新", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const { getValidAccessToken } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };

    // 写入过期 token + refresh_token + discovery（指向 mock AS）
    store.updateOAuthEntry("test", cfg, {
      accessToken: "expired",
      refreshToken: "refresh-token-001",
      expiresAt: Date.now() - 1000, // 已过期
      clientId: "dyn-client-001",
      discoveryState: { authorizationServerUrl: mockASUrl },
    });

    const token = await getValidAccessToken("test", cfg);
    expect(token).toBe("access-token-refreshed");

    // 验证新 token 已持久化
    const entry = store.getOAuthEntry("test", cfg);
    expect(entry?.accessToken).toBe("access-token-refreshed");
    expect(entry?.refreshToken).toBe("refresh-token-002");
  });

  test("getValidAccessToken refresh_token 失效时抛 NeedsAuthorizationError 并清 token", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const { getValidAccessToken, NeedsAuthorizationError } =
      await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };

    store.updateOAuthEntry("test", cfg, {
      accessToken: "expired",
      refreshToken: "invalid-rt", // mock AS 对这个返回 invalid_grant
      expiresAt: Date.now() - 1000,
      clientId: "dyn-client-001",
      discoveryState: { authorizationServerUrl: mockASUrl },
    });

    await expect(getValidAccessToken("test", cfg)).rejects.toBeInstanceOf(NeedsAuthorizationError);
    // token 应已清空
    const entry = store.getOAuthEntry("test", cfg);
    expect(entry?.accessToken).toBe("");
  });

  test("performOAuthFlow 完整授权码流程（discovery+注册+PKCE+token 交换）", async () => {
    const { performOAuthFlow } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };

    let capturedAuthUrl: string | undefined;

    const flowPromise = performOAuthFlow("fulltest", cfg, (url) => {
      capturedAuthUrl = url;
    });

    // 给一小段时间让回调服务器启动 + 授权 URL 生成
    await new Promise((r) => setTimeout(r, 200));

    // 验证授权 URL 格式
    expect(capturedAuthUrl).toBeDefined();
    const authUrl = new URL(capturedAuthUrl!);
    expect(authUrl.origin).toBe(mockASUrl);
    expect(authUrl.pathname).toBe("/authorize");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("client_id")).toBe("dyn-client-001");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("state")).toBeTruthy();
    expect(authUrl.searchParams.get("resource")).toBe(mockASUrl);

    // 模拟浏览器回调：把 code + state 回传到 redirect_uri
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;
    const state = authUrl.searchParams.get("state")!;
    await fetch(`${redirectUri}?code=AUTH_CODE_FROM_AS&state=${state}`);

    // 等待 flow 完成
    const tokens = await flowPromise;
    expect(tokens.access_token).toBe("access-token-001");
    expect(tokens.refresh_token).toBe("refresh-token-001");

    // 验证持久化
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const entry = store.getOAuthEntry("fulltest", cfg);
    expect(entry?.accessToken).toBe("access-token-001");
    expect(entry?.clientId).toBe("dyn-client-001");
  });

  test("token 刷新返回越权 scope 时拒绝（RFC 6749 §6）", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const { getValidAccessToken } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };

    // 原始只授予 "read"，过期需刷新；mock AS 对 escalate-rt 返回 "read write admin"
    store.updateOAuthEntry("esc", cfg, {
      accessToken: "expired",
      refreshToken: "escalate-rt",
      expiresAt: Date.now() - 1000,
      scope: "read",
      clientId: "dyn-client-001",
      discoveryState: { authorizationServerUrl: mockASUrl },
    });

    await expect(getValidAccessToken("esc", cfg)).rejects.toThrow(/scope 越权|escalat/i);
    // 越权 token 不应被持久化
    const entry = store.getOAuthEntry("esc", cfg);
    expect(entry?.accessToken).not.toBe("escalated-token");
  });

  test("performOAuthFlow 取消/失败时保留旧 token", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const { performOAuthFlow } = await import("@sid-code/core/mcp/oauth.ts");
    const cfg: MCPServerConfig = { transport: "http", url: mockASUrl, oauth: {} };

    // 预置一个旧 token
    store.saveTokens("keep", cfg, {
      access_token: "old-token",
      refresh_token: "old-rt",
      expires_in: 7200,
    });

    // 用已 abort 的 signal 触发流程失败
    const controller = new AbortController();
    controller.abort();

    await expect(performOAuthFlow("keep", cfg, () => {}, controller.signal)).rejects.toThrow();

    // 旧 token 应仍在（未被流程开头清掉）
    const entry = store.getOAuthEntry("keep", cfg);
    expect(entry?.accessToken).toBe("old-token");
  });

  test("discovery 拒绝非 loopback 的 http 端点（SSRF 防护）", async () => {
    const { discoverAuthServerMetadata } = await import("@sid-code/core/mcp/oauth.ts");
    // 配置直指一个会返回 http 内网端点的 metadata —— 这里用 authServerMetadataUrl 的 https 校验快速覆盖
    const cfg: MCPServerConfig = {
      transport: "http",
      url: mockASUrl,
      oauth: { authServerMetadataUrl: "http://169.254.169.254/meta" }, // 云元数据地址，经典 SSRF 目标
    };
    await expect(discoverAuthServerMetadata("ssrf", mockASUrl, cfg)).rejects.toThrow(/https/i);
  });

  test("isOAuthEnabled 正确判定", async () => {
    const { isOAuthEnabled } = await import("@sid-code/core/mcp/oauth.ts");
    expect(isOAuthEnabled({ transport: "http", url: "x" })).toBe(false);
    expect(isOAuthEnabled({ transport: "http", url: "x", oauth: {} })).toBe(true);
    expect(isOAuthEnabled({ transport: "stdio", command: "x", oauth: {} })).toBe(true);
  });
});
