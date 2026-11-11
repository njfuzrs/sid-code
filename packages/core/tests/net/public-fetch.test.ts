/**
 * `net/public-fetch` 单测 —— 钉死「域名路径不通时回退 IPv4」这条修复的主干。
 *
 * 背景（2026-11-11 实测）：Bun 1.4 的内置 `fetch` 没有 Happy Eyeballs，域名同时有
 * AAAA / A 记录时会去连 IPv6 且**不回落**。在「有全局 IPv6 地址但上游黑洞」的网络上
 * （国内家宽/办公网常见），它会一直挂到调用方自己的超时，报
 * `AbortError: The operation was aborted.`。
 *
 * 这些用例把修复钉在两个方向上：
 * - 域名路径正常 → 行为与裸 fetch 一致，且**不触发 DNS 查询**（不给正常网络加开销）；
 * - 域名路径失败 → 自动改试 IPv4 直连，且 SNI / Host 仍是域名（证书校验语义不变）。
 *
 * 全部不触网：`fetch` 与 DNS 解析都被替换成内联假实现。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PublicFetchBodyTooLargeError,
  __setIpv4ResolverForTest,
  fetchPublicUrl,
} from "../../src/net/public-fetch.ts";

const ORIGIN = "https://models.example/api.json";
const HOSTNAME = "models.example";

let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  __setIpv4ResolverForTest(null);
});

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

describe("域名路径可用时", () => {
  test("正常返回 body，且不查 DNS、只发一次请求", async () => {
    let dnsCalls = 0;
    __setIpv4ResolverForTest(async () => {
      dnsCalls++;
      return ["1.2.3.4"];
    });
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return jsonResponse('{"ok":true}');
    }) as any;

    const out = await fetchPublicUrl(ORIGIN, { timeoutMs: 2000 });

    expect(out.status).toBe(200);
    expect(new TextDecoder().decode(out.bytes)).toBe('{"ok":true}');
    // 关键断言：正常网络不该为「防御 IPv6 黑洞」付出任何代价。
    expect(dnsCalls).toBe(0);
    expect(urls).toEqual([ORIGIN]);
  });

  test("method 与自定义请求头原样透传", async () => {
    let seenInit: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      seenInit = init;
      return new Response(null, { status: 200 });
    }) as any;

    await fetchPublicUrl(ORIGIN, {
      method: "HEAD",
      headers: { accept: "application/json", "if-none-match": 'W/"abc"' },
      timeoutMs: 2000,
    });

    expect(seenInit.method).toBe("HEAD");
    expect(seenInit.headers.accept).toBe("application/json");
    expect(seenInit.headers["if-none-match"]).toBe('W/"abc"');
  });
});

describe("域名路径失败时回退 IPv4", () => {
  test("回退成功，且直连请求的 SNI / Host 仍是域名", async () => {
    __setIpv4ResolverForTest(async () => ["104.18.10.66"]);
    const seen: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      // 第一次是域名路径，模拟 IPv6 黑洞：挂到 abort。
      if (seen.length === 1) throw abortError();
      return jsonResponse('{"ok":true}');
    }) as any;

    const out = await fetchPublicUrl(ORIGIN, { timeoutMs: 2000 });

    expect(new TextDecoder().decode(out.bytes)).toBe('{"ok":true}');
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toBe("https://104.18.10.66/api.json");
    // 直连 IP 只是绕开「Bun 选了不通的 IPv6」，不是跳过 TLS：
    // SNI 与 Host 必须写回域名，证书校验才仍然按域名做、CDN 分流才对得上。
    expect(seen[1].init.tls?.servername).toBe(HOSTNAME);
    expect(seen[1].init.headers?.host).toBe(HOSTNAME);
    // 重定向留给域名路径去跟（Location 可能指回域名，自己跟会再踩黑洞）。
    expect(seen[1].init.redirect).toBe("manual");
  });

  test("多个 A 记录时逐个尝试，前一个不通就用下一个", async () => {
    __setIpv4ResolverForTest(async () => ["10.0.0.1", "10.0.0.2"]);
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      if (urls.length === 1) throw abortError(); // 域名路径
      if (urls.length === 2) throw abortError(); // 第一个 IP
      return jsonResponse('{"ok":true}');
    }) as any;

    const out = await fetchPublicUrl(ORIGIN, { timeoutMs: 5000 });

    expect(out.status).toBe(200);
    expect(urls).toEqual([ORIGIN, "https://10.0.0.1/api.json", "https://10.0.0.2/api.json"]);
  });

  test("直连拿到 3xx 时改回域名路径跟随", async () => {
    __setIpv4ResolverForTest(async () => ["104.18.10.66"]);
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      if (urls.length === 1) throw abortError(); // 域名首试失败
      if (urls.length === 2) {
        // 直连 IP 拿到重定向：不自己跟，交回域名路径。
        return new Response(null, {
          status: 301,
          headers: { location: "https://models.example/final.json" },
        });
      }
      return jsonResponse('{"ok":true}'); // 域名路径跟随成功
    }) as any;

    const out = await fetchPublicUrl(ORIGIN, { timeoutMs: 2000 });

    expect(out.status).toBe(200);
    expect(urls).toEqual([ORIGIN, "https://104.18.10.66/api.json", ORIGIN]);
  });

  test("没有 A 记录时不再尝试直连，直接失败", async () => {
    __setIpv4ResolverForTest(async () => []);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw abortError();
    }) as any;

    await expect(fetchPublicUrl(ORIGIN, { timeoutMs: 2000 })).rejects.toThrow(/拉取失败/);
    // 只有域名首试这一次：没有 IPv4 可试，也不该无限重试。
    expect(calls).toBe(1);
  });

  test("外部 signal 取消时原样抛出（不当作可回退的网络失败）", async () => {
    const ctl = new AbortController();
    ctl.abort();
    globalThis.fetch = (async () => {
      throw abortError();
    }) as any;

    await expect(fetchPublicUrl(ORIGIN, { timeoutMs: 2000, signal: ctl.signal })).rejects.toThrow();
    expect(ctl.signal.aborted).toBe(true);
  });
});

describe("body 体积上限", () => {
  test("content-length 声明超限时抛 BodyTooLarge", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "999999" },
      })) as any;

    await expect(fetchPublicUrl(ORIGIN, { timeoutMs: 2000, maxBytes: 100 })).rejects.toBeInstanceOf(
      PublicFetchBodyTooLargeError,
    );
  });

  test("流式读取超限时中断并 cancel 流", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(64);
    const stream = new ReadableStream({
      pull(c) {
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as any;

    await expect(fetchPublicUrl(ORIGIN, { timeoutMs: 2000, maxBytes: 100 })).rejects.toBeInstanceOf(
      PublicFetchBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
  });
});
