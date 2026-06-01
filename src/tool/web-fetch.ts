/**
 * WebFetch 工具 - 抓取网页内容
 * 将 HTTP/HTTPS URL 的内容转换为纯文本返回给 LLM
 * 安全限制：拒绝私有 IP 和 localhost
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

const FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 100000; // 从 50000 提升到 100000

/** 每主机限流：每分钟最多 10 次请求 */
const RATE_LIMIT_PER_HOST = 10;
const RATE_LIMIT_WINDOW_MS = 60000;

/** 重试配置 */
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 3000]; // 1s, 3s

/** 主机请求历史记录 */
const hostRequestHistory = new Map<string, number[]>();

// ─── 限流检查 ─────────────────────────────────────────────────────────────────

/** 检查主机是否超过限流 */
function checkRateLimit(hostname: string): { allowed: boolean; waitTime?: number } {
  const now = Date.now();
  const history = hostRequestHistory.get(hostname) || [];

  // 清理过期记录（超过 1 分钟）
  const recentRequests = history.filter(time => now - time < RATE_LIMIT_WINDOW_MS);

  if (recentRequests.length >= RATE_LIMIT_PER_HOST) {
    const oldestRequest = recentRequests[0];
    const waitTime = Math.ceil((oldestRequest + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, waitTime };
  }

  // 记录本次请求
  recentRequests.push(now);
  hostRequestHistory.set(hostname, recentRequests);

  return { allowed: true };
}

// ─── 安全检查 ─────────────────────────────────────────────────────────────────

/** 检查是否为私有/本地 IP，防止 SSRF */
function isPrivateOrLocalhost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  // 10.x.x.x
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  // 172.16-31.x.x
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return true;
  // 192.168.x.x
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  return false;
}

/** 验证 URL 合法性，返回错误信息或 null */
function validateUrl(urlStr: string): string | null {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return `无效的 URL: ${urlStr}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `不支持的协议 ${url.protocol}，仅支持 http/https`;
  }
  if (isPrivateOrLocalhost(url.hostname)) {
    return `拒绝访问私有/本地地址: ${url.hostname}`;
  }
  return null;
}

// ─── GitHub URL 转换 ──────────────────────────────────────────────────────────

/** 将 GitHub blob URL 转换为 raw URL */
function convertGithubUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    if (url.hostname === "github.com" && url.pathname.includes("/blob/")) {
      url.hostname = "raw.githubusercontent.com";
      url.pathname = url.pathname.replace(/^\/([^/]+\/[^/]+)\/blob\//, "/$1/");
      return url.href;
    }
  } catch { /* 忽略无效 URL */ }
  return urlStr;
}

// ─── HTML 转纯文本 ────────────────────────────────────────────────────────────

/** 轻量 HTML 转纯文本（无外部依赖） */
function htmlToText(html: string): string {
  // 去除 <script> 和 <style> 及其内容
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // 块级标签转换为换行
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|br)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // 去除所有剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, "");

  // 解码常见 HTML 实体
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // 合并多余空行（超过 2 个连续空行压缩为 2 个）
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ─── WebFetchTool 类 ──────────────────────────────────────────────────────────

export class WebFetchTool implements Tool {
  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "web_fetch";
  }

  description(): string {
    return "抓取指定 URL 的网页内容，转换为纯文本返回。支持 http/https，自动转换 GitHub blob URL，拒绝私有 IP。";
  }

  usageGuide(): string {
    return `- 用于查阅在线文档、API 参考、GitHub 文件等
- 仅支持 http/https，不支持 ftp 等其他协议
- GitHub blob URL 会自动转换为 raw URL
- 内容超过 50000 字符时自动截断
- 不能访问需要登录的页面`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要抓取的 URL（必须是 http 或 https）",
        },
        prompt: {
          type: "string",
          description: "可选：说明关注哪些内容（仅作提示，不影响抓取行为）",
        },
      },
      required: ["url"],
    };
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { url: string; prompt?: string };

    if (!params.url) {
      return { output: "错误: 缺少 url 参数", isError: true };
    }

    // 安全验证
    const validationError = validateUrl(params.url);
    if (validationError) {
      return { output: `错误: ${validationError}`, isError: true };
    }

    // GitHub blob URL 转换
    const fetchUrl = convertGithubUrl(params.url);
    const isConverted = fetchUrl !== params.url;

    // 限流检查
    const url = new URL(fetchUrl);
    const rateCheck = checkRateLimit(url.hostname);
    if (!rateCheck.allowed) {
      return {
        output: `错误: 主机 ${url.hostname} 请求过于频繁，请等待 ${rateCheck.waitTime} 秒后重试`,
        isError: true,
      };
    }

    log.info("TOOL", `▶ 抓取 ${fetchUrl}${isConverted ? ` (转换自 ${params.url})` : ""}`);

    // 带重试的抓取
    return this.fetchWithRetry(fetchUrl, isConverted, signal, log);
  }

  /** 带重试的抓取 */
  private async fetchWithRetry(
    fetchUrl: string,
    isConverted: boolean,
    signal: AbortSignal | undefined,
    log: ReturnType<typeof getLogger>,
    retryCount = 0,
  ): Promise<ToolResult> {
    try {
      // 超时控制
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);

      // 合并 AbortSignal
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      let response: Response;
      try {
        response = await fetch(fetchUrl, {
          signal: combinedSignal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; sid-code/1.0)",
            "Accept": "text/html,text/plain,application/json,*/*",
          },
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        return {
          output: `错误: HTTP ${response.status} ${response.statusText}`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const rawText = await response.text();

      // 根据 Content-Type 处理内容
      let text: string;
      if (contentType.toLowerCase().includes("text/html")) {
        text = htmlToText(rawText);
      } else {
        // text/plain, application/json, text/markdown 等直接返回
        text = rawText;
      }

      // 截断超长内容
      let output: string;
      if (text.length > MAX_CONTENT_LENGTH) {
        output = text.slice(0, MAX_CONTENT_LENGTH);
        output += `\n\n... [内容已截断：共 ${text.length} 字符，仅显示前 ${MAX_CONTENT_LENGTH} 字符]`;
      } else {
        output = text;
      }

      const header = isConverted
        ? `[已将 GitHub blob URL 转换为 raw URL]\n来源: ${fetchUrl}\n\n`
        : `来源: ${fetchUrl}\n\n`;

      log.info("TOOL", `✓ 抓取完成 ${text.length}字符${text.length > MAX_CONTENT_LENGTH ? "(已截断)" : ""}`);

      return { output: header + output };
    } catch (err: any) {
      // 判断是否应该重试
      const shouldRetry = this.shouldRetryError(err) && retryCount < MAX_RETRIES;

      if (shouldRetry) {
        const delay = RETRY_DELAYS[retryCount];
        log.info("TOOL", `⚠ 抓取失败，${delay}ms 后重试 (${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(fetchUrl, isConverted, signal, log, retryCount + 1);
      }

      if (err?.name === "AbortError") {
        return { output: `错误: 请求超时（${FETCH_TIMEOUT_MS / 1000}秒）`, isError: true };
      }
      return { output: `抓取失败: ${err.message}`, isError: true };
    }
  }

  /** 判断错误是否应该重试 */
  private shouldRetryError(err: any): boolean {
    // 网络错误重试
    if (err?.name === "NetworkError" || err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT") {
      return true;
    }

    // 5xx 服务器错误重试
    if (err?.status && err.status >= 500 && err.status < 600) {
      return true;
    }

    // 4xx 客户端错误不重试
    return false;
  }
}
