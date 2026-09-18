/**
 * 自动更新 — latest.txt 检查器测试
 */

import { afterEach, describe, expect, test } from "bun:test";
import { fetchLatestVersion } from "@sid-code/core/update/checker.ts";

describe("checker", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("成功返回合法稳定版本", async () => {
    globalThis.fetch = (async () =>
      new Response("0.1.604\n", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBe("0.1.604");
  });

  test("HTTP 错误返回 null", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  test("网络异常返回 null", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  test("非法版本返回 null", async () => {
    globalThis.fetch = (async () =>
      new Response("0.1.604-beta.1\n", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  test("空响应返回 null", async () => {
    globalThis.fetch = (async () => new Response("\n", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  test("请求超时返回 null", async () => {
    globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const promise = fetchLatestVersion();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    expect(await promise).toBeNull();
  }, 7000);
});
