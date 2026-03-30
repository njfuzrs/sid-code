/**
 * 搜索后端接口定义
 * 所有搜索后端（Brave、Tavily、SearXNG、DuckDuckGo）必须实现 SearchBackend 接口
 */

/** 单条搜索结果 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 结果时间（如 "2 days ago"） */
  age?: string;
  /** 相关性评分 */
  score?: number;
}

/** 搜索响应 */
export interface SearchResponse {
  results: SearchResult[];
  /** 搜索耗时（毫秒） */
  durationMs: number;
  /** 后端名称 */
  backend: string;
}

/** 搜索选项 */
export interface SearchOptions {
  maxResults?: number;
  locale?: string;
  signal?: AbortSignal;
}

/** 搜索后端接口 */
export interface SearchBackend {
  name: string;
  /** 后端是否可用（API Key 是否配置等） */
  isAvailable(): boolean;
  /** 执行搜索 */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
