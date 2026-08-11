/**
 * 搜索后端工厂
 * 根据配置和环境变量自动选择最佳搜索后端
 * 优先级：显式配置 > 环境变量自动检测 > DuckDuckGo 兜底
 *
 * Phase 1 支持：SearXNG、DuckDuckGo
 * 后续扩展：Brave、Tavily（添加对应文件后取消注释即可）
 */

import type { SearchBackend } from "./types.ts";
import type { SearchConfig } from "../../config/config.ts";
import { SearXNGSearchBackend } from "./searxng.ts";
import { DuckDuckGoSearchBackend } from "./duckduckgo.ts";

export function createSearchBackend(config?: SearchConfig): SearchBackend {
  const cfg = config ?? {};
  const backend = cfg.backend
    ?? process.env.SEARCH_BACKEND
    ?? autoDetectBackend(cfg);

  switch (backend) {
    case "searxng": {
      const url = cfg.searxngUrl ?? process.env.SEARXNG_URL;
      return url ? new SearXNGSearchBackend(url) : new DuckDuckGoSearchBackend();
    }
    // Phase 2: 取消注释并创建对应文件即可启用
    // case "brave": { ... }
    // case "tavily": { ... }
    case "duckduckgo":
    default:
      return new DuckDuckGoSearchBackend();
  }
}

/** 自动检测可用的后端（按优先级） */
function autoDetectBackend(config: SearchConfig): string {
  if (config.searxngUrl || process.env.SEARXNG_URL) return "searxng";
  // if (config.braveApiKey || process.env.BRAVE_API_KEY) return "brave";
  // if (config.tavilyApiKey || process.env.TAVILY_API_KEY) return "tavily";
  return "duckduckgo";
}
