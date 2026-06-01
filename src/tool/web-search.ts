/**
 * WebSearch 工具 - 搜索互联网
 * 返回结构化的搜索结果（标题、URL、摘要），与 web_fetch 形成互补
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import type { SearchBackend, SearchResponse } from "./search-backends/types.ts";
import { getLogger } from "../debug/logger.ts";

/** 全局限流：每分钟最多 20 次搜索 */
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const searchHistory: number[] = [];

export class WebSearchTool implements Tool {
  constructor(private backend: SearchBackend) {}

  name(): string {
    return "web_search";
  }

  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  description(): string {
    return "搜索互联网，返回与查询相关的网页结果（标题、URL、摘要）。适用于查找最新文档、排查错误、技术调研等需要联网获取信息的场景。";
  }

  usageGuide(): string {
    return `- 当你不知道具体 URL 但需要查找信息时使用此工具
- 返回搜索结果列表（标题 + URL + 摘要），不返回完整页面内容
- 如果需要深入阅读某个搜索结果，请用 web_fetch 抓取对应 URL
- 搜索词建议使用英文以获得更好的结果，除非用户明确要求中文搜索
- 典型工作流：web_search 找到相关 URL → web_fetch 深入阅读 → 综合回答`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词或自然语言问题",
        },
        max_results: {
          type: "number",
          description: "最大返回结果数（默认 5，最大 10）",
        },
      },
      required: ["query"],
    };
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { query: string; max_results?: number };

    // 1. 参数校验
    if (!params.query || params.query.trim() === "") {
      return { output: "错误: query 参数不能为空", isError: true };
    }

    // 2. 限流检查
    const now = Date.now();
    const recent = searchHistory.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      return {
        output: `错误: 搜索过于频繁（每分钟最多 ${RATE_LIMIT} 次），请稍后重试`,
        isError: true,
      };
    }
    searchHistory.length = 0;
    searchHistory.push(...recent, now);

    // 3. 检查后端可用性
    if (!this.backend.isAvailable()) {
      return {
        output: `错误: 搜索后端 "${this.backend.name}" 不可用，请检查配置`,
        isError: true,
      };
    }

    // 4. 执行搜索
    const maxResults = Math.min(params.max_results ?? 5, 10);
    log.info("TOOL", `▶ 搜索 "${params.query}" (后端: ${this.backend.name}, 最多 ${maxResults} 条)`);

    try {
      const response = await this.backend.search(params.query, {
        maxResults,
        signal,
      });

      // 5. 格式化输出
      if (response.results.length === 0) {
        log.info("TOOL", `✓ 搜索完成，无结果`);
        return { output: `未找到与 "${params.query}" 相关的搜索结果。` };
      }

      log.info("TOOL", `✓ 搜索完成，${response.results.length} 条结果，耗时 ${response.durationMs}ms`);
      return { output: this.formatResults(params.query, response) };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { output: "搜索已取消", isError: true };
      }
      log.error("TOOL", `✗ 搜索失败: ${err.message}`);
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }

  /** 将搜索结果格式化为 LLM 友好的文本 */
  private formatResults(query: string, response: SearchResponse): string {
    const lines: string[] = [
      `搜索 "${query}" 的结果（${response.results.length} 条，耗时 ${response.durationMs}ms，来源: ${response.backend}）：`,
      "",
    ];

    for (let i = 0; i < response.results.length; i++) {
      const r = response.results[i];
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    URL: ${r.url}`);
      if (r.age) lines.push(`    时间: ${r.age}`);
      lines.push(`    ${r.snippet}`);
      lines.push("");
    }

    lines.push("提示: 如需查看某个结果的完整内容，请使用 web_fetch 工具抓取对应 URL。");

    return lines.join("\n");
  }
}
