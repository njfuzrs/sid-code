/**
 * WebSearch allowed_domains / blocked_domains 域名过滤测试（P2-5）
 *
 * 对齐 CC WebSearch 的 allowed_domains/blocked_domains：后端无关的结果域名过滤，
 * allowed 只保留命中的、blocked 剔除命中的，两者互斥。
 */

import { describe, test, expect } from "bun:test";
import { WebSearchTool, filterResultsByDomain } from "@sid-code/core/tool/web-search.ts";
import type {
  SearchBackend,
  SearchResponse,
  SearchOptions,
} from "@sid-code/core/tool/search-backends/types.ts";

/** 假后端：返回固定一组跨域名结果 */
function fakeBackend(results: { title: string; url: string; snippet: string }[]): SearchBackend {
  return {
    name: "fake",
    isAvailable: () => true,
    async search(_query: string, _options?: SearchOptions): Promise<SearchResponse> {
      return { results, durationMs: 1, backend: "fake" };
    },
  };
}

const SAMPLE = [
  { title: "Py docs", url: "https://docs.python.org/3/library/os.html", snippet: "os" },
  { title: "SO", url: "https://stackoverflow.com/q/123", snippet: "q" },
  { title: "Sub docs", url: "https://sub.docs.python.org/x", snippet: "sub" },
  { title: "Evil", url: "https://spam.example.com/x", snippet: "spam" },
];

describe("filterResultsByDomain（纯函数）", () => {
  test("allowed_domains 只保留命中域名（含子域后缀匹配）", () => {
    const out = filterResultsByDomain(SAMPLE, ["docs.python.org"], undefined);
    expect(out.map((r) => r.url)).toEqual([
      "https://docs.python.org/3/library/os.html",
      "https://sub.docs.python.org/x",
    ]);
  });

  test("blocked_domains 剔除命中域名", () => {
    const out = filterResultsByDomain(SAMPLE, undefined, ["example.com"]);
    expect(out.some((r) => r.url.includes("example.com"))).toBe(false);
    expect(out).toHaveLength(3);
  });

  test("无过滤参数时原样返回", () => {
    expect(filterResultsByDomain(SAMPLE)).toHaveLength(4);
  });
});

describe("WebSearchTool 域名过滤集成", () => {
  test("allowed_domains 生效", async () => {
    const tool = new WebSearchTool(fakeBackend(SAMPLE));
    const result = await tool.execute({ query: "os", allowed_domains: ["docs.python.org"] });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("docs.python.org");
    expect(result.output).not.toContain("stackoverflow.com");
  });

  test("blocked_domains 生效", async () => {
    const tool = new WebSearchTool(fakeBackend(SAMPLE));
    const result = await tool.execute({ query: "os", blocked_domains: ["example.com"] });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("spam.example.com");
  });

  test("allowed 与 blocked 同时给 → 报错（互斥）", async () => {
    const tool = new WebSearchTool(fakeBackend(SAMPLE));
    const result = await tool.execute({
      query: "os",
      allowed_domains: ["docs.python.org"],
      blocked_domains: ["example.com"],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不能同时使用");
  });

  test("allowed 过滤后无匹配 → 友好提示", async () => {
    const tool = new WebSearchTool(fakeBackend(SAMPLE));
    const result = await tool.execute({ query: "os", allowed_domains: ["nonexistent.invalid"] });
    expect(result.output).toContain("域名过滤后无匹配结果");
  });

  test("schema 暴露 allowed_domains/blocked_domains", () => {
    const tool = new WebSearchTool(fakeBackend(SAMPLE));
    const schema = tool.inputSchema() as any;
    expect(schema.properties.allowed_domains).toBeDefined();
    expect(schema.properties.blocked_domains).toBeDefined();
  });
});
