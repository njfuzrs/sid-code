/**
 * MCP OAuth 回调服务器测试
 * 覆盖：端口绑定、CSRF state 校验、超时、错误回调、正常授权码回调
 */

import { describe, test, expect, afterEach } from "bun:test";
import type { CallbackServerHandle } from "@sid-code/core/mcp/oauth-callback-server.ts";

let handle: CallbackServerHandle | null = null;

afterEach(() => {
  handle?.close();
  handle = null;
});

describe("oauth-callback-server", () => {
  test("startCallbackServer 成功绑定并返回 redirect URI", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.redirectUri).toBe(`http://localhost:${handle.port}/callback`);
  });

  test("配置固定端口时使用该端口", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    // 用一个不太常用的高端口
    handle = await startCallbackServer(51234);
    expect(handle.port).toBe(51234);
  });

  test("正确授权码回调解析成功", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();

    const codePromise = handle.waitForCode("test-state-123", 5000);

    // 模拟浏览器回调
    const callbackUrl = `${handle.redirectUri}?code=AUTH_CODE_XYZ&state=test-state-123`;
    await fetch(callbackUrl);

    const code = await codePromise;
    expect(code).toBe("AUTH_CODE_XYZ");
  });

  test("state 不匹配时拒绝", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();

    const codePromise = handle.waitForCode("expected-state", 5000);

    // 不 await fetch——server close 后 fetch 可能挂起；只要触发请求即可
    fetch(`${handle.redirectUri}?code=CODE&state=wrong-state`).catch(() => {});

    await expect(codePromise).rejects.toThrow("state 不匹配");
  });

  test("授权服务器返回错误时拒绝", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();

    const codePromise = handle.waitForCode("s", 5000);

    fetch(`${handle.redirectUri}?error=access_denied&error_description=User+denied`).catch(
      () => {},
    );

    await expect(codePromise).rejects.toThrow("access_denied");
  });

  test("超时拒绝", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();

    // 100ms 超时
    const codePromise = handle.waitForCode("s", 100);
    await expect(codePromise).rejects.toThrow("超时");
  });

  test("abort signal 取消", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();

    const controller = new AbortController();
    const codePromise = handle.waitForCode("s", 30000, controller.signal);

    // 立即取消
    controller.abort();
    await expect(codePromise).rejects.toThrow("取消");
  });

  test("非 /callback 路径返回 404", async () => {
    const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
    handle = await startCallbackServer();

    const resp = await fetch(`http://localhost:${handle.port}/other`);
    expect(resp.status).toBe(404);
  });
});
