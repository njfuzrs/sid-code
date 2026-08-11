/**
 * MCP OAuth 凭据存储测试
 * 覆盖：server key 隔离、token/client/discovery 持久化、tokens-only 清除、
 *       hasDiscoveryButNoToken 判定
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

let tmpDir: string;
let prevConfigDir: string | undefined;

// 每个测试用独立临时配置目录隔离 ~/.sid-code/mcp-oauth.json
beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-oauth-store-"));
  process.env.SID_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const httpConfig = (url: string): MCPServerConfig => ({ transport: "http", url, oauth: {} });

describe("oauth-storage", () => {
  test("getServerKey 对同名但不同 URL 的服务器生成不同键", async () => {
    const { getServerKey } = await import("@sid-code/core/mcp/oauth-storage.ts");
    const k1 = getServerKey("srv", httpConfig("https://a.example.com/mcp"));
    const k2 = getServerKey("srv", httpConfig("https://b.example.com/mcp"));
    expect(k1).not.toBe(k2);
    expect(k1.startsWith("srv|")).toBe(true);
  });

  test("getServerKey 对相同配置稳定", async () => {
    const { getServerKey } = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://a.example.com/mcp");
    expect(getServerKey("srv", cfg)).toBe(getServerKey("srv", cfg));
  });

  test("saveTokens / getOAuthEntry 往返", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://x.example.com/mcp");
    store.saveTokens("x", cfg, { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "read" });

    const entry = store.getOAuthEntry("x", cfg);
    expect(entry?.accessToken).toBe("AT");
    expect(entry?.refreshToken).toBe("RT");
    expect(entry?.scope).toBe("read");
    expect(entry!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("expires_in 缺省按 1 小时", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://y.example.com/mcp");
    const before = Date.now();
    store.saveTokens("y", cfg, { access_token: "AT" });
    const entry = store.getOAuthEntry("y", cfg);
    // 约 3600s 后过期（留 10s 容差）
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 3590_000);
  });

  test("clearOAuthEntry tokens 只清 token 保留 client", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://z.example.com/mcp");
    store.saveClientInformation("z", cfg, { client_id: "CID", client_secret: "CS" });
    store.saveTokens("z", cfg, { access_token: "AT", refresh_token: "RT", expires_in: 3600 });

    store.clearOAuthEntry("z", cfg, "tokens");
    const entry = store.getOAuthEntry("z", cfg);
    expect(entry?.clientId).toBe("CID");       // client 保留
    expect(entry?.accessToken).toBe("");        // token 清空
    expect(entry?.refreshToken).toBeUndefined();
    expect(entry?.expiresAt).toBe(0);
  });

  test("clearOAuthEntry all 删除整个条目", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://w.example.com/mcp");
    store.saveTokens("w", cfg, { access_token: "AT" });
    store.clearOAuthEntry("w", cfg, "all");
    expect(store.getOAuthEntry("w", cfg)).toBeUndefined();
  });

  test("hasDiscoveryButNoToken：有条目无 token 为 true", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://d.example.com/mcp");
    // 仅保存 discovery（无 token）
    store.saveDiscoveryState("d", cfg, { authorizationServerUrl: "https://as.example.com" });
    expect(store.hasDiscoveryButNoToken("d", cfg)).toBe(true);

    // 有 token 后为 false
    store.saveTokens("d", cfg, { access_token: "AT" });
    expect(store.hasDiscoveryButNoToken("d", cfg)).toBe(false);
  });

  test("无条目时 hasDiscoveryButNoToken 为 false", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    expect(store.hasDiscoveryButNoToken("none", httpConfig("https://n.example.com/mcp"))).toBe(false);
  });

  test("updateOAuthEntry 合并不丢失既有字段", async () => {
    const store = await import("@sid-code/core/mcp/oauth-storage.ts");
    const cfg = httpConfig("https://m.example.com/mcp");
    store.saveClientInformation("m", cfg, { client_id: "CID" });
    store.saveTokens("m", cfg, { access_token: "AT", expires_in: 3600 });
    const entry = store.getOAuthEntry("m", cfg);
    expect(entry?.clientId).toBe("CID");   // client 未被 token 写入覆盖
    expect(entry?.accessToken).toBe("AT");
  });
});
