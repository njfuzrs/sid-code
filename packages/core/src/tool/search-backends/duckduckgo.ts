/**
 * DuckDuckGo HTML 抓取搜索后端（免费兜底方案）
 * 通过抓取 DuckDuckGo /html/ 端点解析搜索结果，无需 API Key
 *
 * 注意：2025 Q3/Q4 DDG 加强了反爬机制，需要：
 * - 只请求第一页，不翻页
 * - 模拟浏览器 Headers
 * - 控制请求频率
 * - 查询不超过 499 字符
 */

import type { SearchBackend, SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const DDG_HTML_URL = "https://duckduckgo.com/html/";
const TIMEOUT_MS = 10_000;
const MAX_QUERY_LENGTH = 499;

export class DuckDuckGoSearchBackend implements SearchBackend {
  name = "duckduckgo";

  isAvailable(): boolean {
    return true; // 永远可用，无需 API Key
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();
    const maxResults = options?.maxResults ?? 5;

    // DDG 不接受超过 499 字符的查询
    const trimmedQuery = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;

    const url = new URL(DDG_HTML_URL);
    url.searchParams.set("q", trimmedQuery);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const combinedSignal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          Referer: "https://html.duckduckgo.com/",
        },
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new Error(`DuckDuckGo 请求失败: HTTP ${response.status}`);
      }

      const html = await response.text();
      const results = this.parseHTML(html, maxResults);

      return {
        results,
        durationMs: Date.now() - startTime,
        backend: this.name,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 解析 DuckDuckGo HTML 搜索结果页
   *
   * /html/ 端点结构：
   * <div class="result results_links results_links_deep web-result">
   *   <h2 class="result__title">
   *     <a class="result__a" href="...">标题</a>
   *   </h2>
   *   <a class="result__snippet">摘要文本...</a>
   * </div>
   */
  private parseHTML(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    const resultBlockRegex =
      /<div[^>]*class="[^"]*result[^"]*web-result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let blockMatch: RegExpExecArray | null;

    while ((blockMatch = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
      const block = blockMatch[0];

      // 提取标题和 URL
      const titleMatch = block.match(
        /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
      );
      if (!titleMatch) continue;

      let url = titleMatch[1];
      const title = this.stripTags(titleMatch[2]).trim();

      // DDG 链接可能是重定向 URL，提取真实 URL
      if (url.includes("uddg=")) {
        try {
          const uddg = new URL(url, "https://duckduckgo.com").searchParams.get("uddg");
          if (uddg) url = decodeURIComponent(uddg);
        } catch {
          /* 保留原始 URL */
        }
      }

      // 提取摘要
      const snippetMatch =
        block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ||
        block.match(/<span[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/span>/i);
      const snippet = snippetMatch ? this.stripTags(snippetMatch[1]).trim() : "";

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  }

  private stripTags(html: string): string {
    return html
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
  }
}
