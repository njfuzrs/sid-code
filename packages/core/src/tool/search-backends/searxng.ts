/**
 * SearXNG 搜索后端
 * 连接自托管的 SearXNG 实例，通过 JSON API 获取搜索结果
 */

import type { SearchBackend, SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const TIMEOUT_MS = 10_000;

export class SearXNGSearchBackend implements SearchBackend {
  name = "searxng";

  constructor(private baseUrl: string) {}

  isAvailable(): boolean {
    return !!this.baseUrl;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();

    // 保留 baseUrl 的路径前缀（如 /searxng），拼接 /search
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    const url = new URL("search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", "1");
    if (options?.locale) {
      url.searchParams.set("language", options.locale);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const combinedSignal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new Error(`SearXNG 错误: HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const maxResults = options?.maxResults ?? 5;
      const results: SearchResult[] = (data.results ?? [])
        .slice(0, maxResults)
        .map((item: any) => ({
          title: item.title ?? "无标题",
          url: item.url ?? "",
          snippet: item.content ?? "",
        }));

      return {
        results,
        durationMs: Date.now() - startTime,
        backend: this.name,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
