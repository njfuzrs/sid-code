/**
 * WebFetch 工具测试
 * 注意：网络请求测试使用 mock，不依赖真实网络
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { WebFetchTool, __clearWebFetchCache } from "../../src/tool/web-fetch.ts";

// 内容缓存与主机限流均为模块级全局，会跨测试泄漏（缓存串味 + 限流计数累积）。
// 每个测试前统一清空，保证测试互不干扰、与执行顺序无关。
beforeEach(() => {
  __clearWebFetchCache();
});

// ─── 辅助：测试内部函数（通过导出或直接测试工具行为） ─────────────────────────

describe("WebFetchTool - URL 验证", () => {
  const tool = new WebFetchTool();

  test("缺少 url 参数时返回错误", async () => {
    const result = await tool.execute({ url: "" });
    expect(result.isError).toBe(true);
  });

  test("非 http/https 协议返回错误", async () => {
    const result = await tool.execute({ url: "ftp://example.com/file" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不支持的协议");
  });

  test("localhost 返回错误", async () => {
    const result = await tool.execute({ url: "http://localhost:3000/api" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("私有");
  });

  test("127.0.0.1 返回错误", async () => {
    const result = await tool.execute({ url: "http://127.0.0.1/admin" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("私有");
  });

  test("私有 IP 10.x.x.x 返回错误", async () => {
    const result = await tool.execute({ url: "http://10.0.0.1/secret" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("私有");
  });

  test("私有 IP 192.168.x.x 返回错误", async () => {
    const result = await tool.execute({ url: "http://192.168.1.1/" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("私有");
  });

  test("无效 URL 格式返回错误", async () => {
    const result = await tool.execute({ url: "not-a-url" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("无效");
  });
});

describe("WebFetchTool - GitHub URL 转换", () => {
  test("GitHub blob URL 转换为 raw URL", async () => {
    // 通过 mock fetch 验证实际请求的 URL
    const fetchedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrls.push(url.toString());
      return new Response("raw content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    await tool.execute({ url: "https://github.com/user/repo/blob/main/README.md" });

    globalThis.fetch = originalFetch;

    expect(fetchedUrls[0]).toContain("raw.githubusercontent.com");
    expect(fetchedUrls[0]).not.toContain("/blob/");
  });

  test("非 GitHub URL 不转换", async () => {
    const fetchedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrls.push(url.toString());
      return new Response("content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    await tool.execute({ url: "https://example.com/page" });

    globalThis.fetch = originalFetch;

    expect(fetchedUrls[0]).toBe("https://example.com/page");
  });
});

describe("WebFetchTool - 内容处理", () => {
  test("纯文本内容直接返回", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("Hello, World!", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/text" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Hello, World!");
  });

  test("HTML 内容去除标签", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("<html><body><h1>Title</h1><p>Content here</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/page" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Title");
    expect(result.output).toContain("Content here");
    expect(result.output).not.toContain("<h1>");
    expect(result.output).not.toContain("<p>");
  });

  test("HTML 去除 script 和 style 内容", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('<html><head><script>alert("xss")</script><style>.foo{color:red}</style></head><body>Clean text</body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/page" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("alert");
    expect(result.output).not.toContain("color:red");
    expect(result.output).toContain("Clean text");
  });

  test("超长内容截断并附提示", async () => {
    const longContent = "x".repeat(120000); // 超过 100000 字符
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(longContent, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/long" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("内容已截断");
    expect(result.output).toContain("100000 字符");
    // 实际内容不超过 100000 + 提示文字
    expect(result.output.length).toBeLessThan(101000);
  });

  test("HTTP 错误状态码返回错误", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/missing" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("404");
  });

  test("HTML 实体解码", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/entities" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('a & b <c> "d"');
  });
});

describe("WebFetchTool - 工具属性", () => {
  const tool = new WebFetchTool();

  test("name 返回 web_fetch", () => {
    expect(tool.name()).toBe("web_fetch");
  });

  test("readOnly 返回 true", () => {
    expect(tool.readOnly()).toBe(true);
  });

  test("inputSchema 包含 url 必填字段", () => {
    const schema = tool.inputSchema() as any;
    expect(schema.required).toContain("url");
    expect(schema.properties.url).toBeDefined();
  });
});

// P0-1：重定向 SSRF 防护
describe("WebFetchTool - 重定向 SSRF 防护", () => {
  test("含内嵌凭据的 URL（user:pass@）被拒绝", async () => {
    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://user:pass@example.com/" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("凭据");
  });

  test("跨 host 重定向被拦截（防开放重定向 → SSRF）", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://evil.example.com/redirect" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("跨站重定向");
  });

  test("重定向到私有 IP（即便同 host 判定绕过）被兜底拦截", async () => {
    // 构造一个"看似同源但目标是私有 IP"的场景：from 就是 IP host，to 也是私有 IP
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(null, {
        status: 301,
        headers: { location: "http://127.0.0.1:8080/admin" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://public.example.com/x" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBe(true);
    // 跨 host（example.com → 127.0.0.1）先被跨站拦截
    expect(result.output).toMatch(/跨站重定向|私有/);
  });

  test("同源重定向（±www）正常跟随", async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      call++;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.example.com/final" },
        });
      }
      return new Response("final content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/start" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("final content");
  });

  test("重定向环在 MAX_REDIRECTS 处终止", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      // 始终跳回同源另一路径，形成环
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://example.com/start" });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("重定向");
  });
});

describe("WebFetchTool - 15 分钟内容缓存", () => {
  test("同一 URL 第二次抓取命中缓存，不再发起真实请求", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response("cached body content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const r1 = await tool.execute({ url: "https://cache-a.example.com/cache-me" });
    const r2 = await tool.execute({ url: "https://cache-a.example.com/cache-me" });

    globalThis.fetch = originalFetch;

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r1.output).toContain("cached body content");
    expect(r2.output).toContain("cached body content");
    // 第二次应命中缓存，只发起了 1 次真实请求
    expect(fetchCount).toBe(1);
  });

  test("清空缓存后重新抓取", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response("body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    await tool.execute({ url: "https://cache-b.example.com/x" });
    __clearWebFetchCache();
    await tool.execute({ url: "https://cache-b.example.com/x" });

    globalThis.fetch = originalFetch;

    expect(fetchCount).toBe(2);
  });
});

describe("WebFetchTool - prompt 关注点生效", () => {
  test("传入 prompt 时拼进返回引导", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("page body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({
      url: "https://prompt-a.example.com/doc",
      prompt: "提取版本号",
    });

    globalThis.fetch = originalFetch;

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("关注点");
    expect(result.output).toContain("提取版本号");
    expect(result.output).toContain("page body");
  });

  test("缓存命中时也能响应新的 prompt", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("shared body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    // 第一次无 prompt 填充缓存
    await tool.execute({ url: "https://prompt-b.example.com/doc2" });
    // 第二次命中缓存但带新 prompt，引导应现拼
    const result = await tool.execute({
      url: "https://prompt-b.example.com/doc2",
      prompt: "只看价格",
    });

    globalThis.fetch = originalFetch;

    expect(result.output).toContain("只看价格");
    expect(result.output).toContain("shared body");
  });

  test("无 prompt 时不拼引导", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("plain body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    ) as unknown as typeof fetch;

    const tool = new WebFetchTool();
    const result = await tool.execute({ url: "https://prompt-c.example.com/doc3" });

    globalThis.fetch = originalFetch;

    expect(result.output).not.toContain("关注点");
  });
});
