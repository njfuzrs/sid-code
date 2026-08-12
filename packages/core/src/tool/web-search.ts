/**
 * WebSearch 工具 - 搜索互联网
 * 返回结构化的搜索结果（标题、URL、摘要），与 web_fetch 形成互补
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import type { SearchBackend, SearchResponse } from "./search-backends/types.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 全局限流：每分钟最多 20 次搜索 */
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const searchHistory: number[] = [];

/** WebSearch 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const webSearchSchema = lazySchema(() =>
  z.object({
    query: z.string().describe("搜索关键词或自然语言问题"),
    max_results: z.number().optional().describe("最大返回结果数（默认 5，最大 10）"),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('仅保留这些域名的结果（如 ["docs.python.org"]）。与 blocked_domains 互斥'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe("排除这些域名的结果。与 allowed_domains 互斥"),
  }),
);

/** 提取 URL 的 hostname（失败返回空串）。 */
function urlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 判断 host 是否匹配某个域名规则（后缀匹配：规则 "example.com" 命中 "docs.example.com"）。
 */
function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\*\./, "");
  if (!d) return false;
  return host === d || host.endsWith("." + d);
}

/**
 * 按 allowed/blocked 域名过滤搜索结果（后端无关，对齐 CC WebSearch 的 allowed/blocked_domains）。
 * allowed 非空：只保留命中 allowed 的；blocked 非空：剔除命中 blocked 的。
 */
export function filterResultsByDomain<T extends { url: string }>(
  results: T[],
  allowed?: string[],
  blocked?: string[],
): T[] {
  let out = results;
  if (allowed && allowed.length > 0) {
    out = out.filter((r) => {
      const host = urlHostname(r.url);
      return host && allowed.some((d) => hostMatchesDomain(host, d));
    });
  }
  if (blocked && blocked.length > 0) {
    out = out.filter((r) => {
      const host = urlHostname(r.url);
      return !host || !blocked.some((d) => hostMatchesDomain(host, d));
    });
  }
  return out;
}

export class WebSearchTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = webSearchSchema();

  constructor(private backend: SearchBackend) {}

  name(): string {
    return "web_search";
  }

  readOnly(): boolean {
    return true;
  }

  /**
   * 权限检查（SEC-AUDIT-2026-07-19 P1-2）：passthrough，交给权限系统按
   * `WebSearch` / `WebSearch(查询词模式)` 规则匹配；无匹配规则时落到 checker 默认 ask。
   *
   * 契约：网络出站需人类把关。web_search 不在 checker READ_ONLY_TOOLS，也不在
   * tool-classifier AUTO_ALLOW_TOOLS —— 两条自动放行路径都已摘除，故此处 passthrough
   * 的净效果是「默认询问」，而非上一轮审计时的「静默放行」。
   *
   * 与 web_fetch 的区别：搜索无具体 URL，无法做 domain: 粒度授权，故不设预授权白名单。
   */
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
- 典型工作流：web_search 找到相关 URL → web_fetch 深入阅读 → 综合回答
- 可用 allowed_domains 限定只搜某些站点（如官方文档域名），或 blocked_domains 排除干扰站点；两者互斥`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(webSearchSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      query: string;
      max_results?: number;
      allowed_domains?: string[];
      blocked_domains?: string[];
    };

    // 1. 参数校验
    if (!params.query || params.query.trim() === "") {
      return { output: "错误: query 参数不能为空", isError: true };
    }

    // allowed_domains 与 blocked_domains 互斥（对齐 CC 语义，避免歧义）
    const hasAllowed = Array.isArray(params.allowed_domains) && params.allowed_domains.length > 0;
    const hasBlocked = Array.isArray(params.blocked_domains) && params.blocked_domains.length > 0;
    if (hasAllowed && hasBlocked) {
      return {
        output: "错误: allowed_domains 与 blocked_domains 不能同时使用，请只用其中一个。",
        isError: true,
      };
    }

    // 2. 限流检查
    const now = Date.now();
    const recent = searchHistory.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
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
    // 有域名过滤时多取一些候选，过滤后再截断到 maxResults，避免过滤后结果过少。
    const fetchCount = hasAllowed || hasBlocked ? Math.min(maxResults * 3, 30) : maxResults;
    log.info(
      "TOOL",
      `▶ 搜索 "${params.query}" (后端: ${this.backend.name}, 最多 ${maxResults} 条)`,
    );

    try {
      const response = await this.backend.search(params.query, {
        maxResults: fetchCount,
        signal,
      });

      // 4.5 域名过滤（后端无关）+ 截断到 maxResults
      let results = filterResultsByDomain(
        response.results,
        params.allowed_domains,
        params.blocked_domains,
      );
      results = results.slice(0, maxResults);
      const filtered: SearchResponse = { ...response, results };

      // 5. 格式化输出
      if (filtered.results.length === 0) {
        const hint =
          hasAllowed || hasBlocked
            ? "（域名过滤后无匹配结果，可调整 allowed/blocked_domains）"
            : "";
        log.info("TOOL", `✓ 搜索完成，无结果`);
        return { output: `未找到与 "${params.query}" 相关的搜索结果。${hint}` };
      }

      log.info(
        "TOOL",
        `✓ 搜索完成，${filtered.results.length} 条结果，耗时 ${response.durationMs}ms`,
      );
      return { output: this.formatResults(params.query, filtered) };
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
