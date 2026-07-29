/**
 * ReadMany 工具 - 批量读取文件
 * 通过 glob 模式一次性读取多个文件，大幅减少 LLM 轮次
 *
 * 对标 CC FileReadTool 的稳定性保护（与 read.ts 对齐）：
 * - 二进制文件检测（扩展名 + 内容字节）
 * - 大文件跳过（>10MB 单文件不读）
 * - AbortSignal 全链路传递
 * - BOM/CRLF 规范化
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import type { FileStateCache } from "./file-state-cache.ts";
import { statSync } from "fs";
import { extname } from "path";
import { glob } from "glob";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { isBinaryContent, BINARY_CHECK_WINDOW } from "./binary-detect.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 每文件最大行数 */
const MAX_LINES_PER_FILE = 400;

/** 总输出上限（字符） */
const MAX_TOTAL_OUTPUT = 100000;

/** 单文件大小上限（字节）：超过此值跳过 */
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** 默认排除模式 */
const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.cache/**",
  "**/.next/**",
  "**/.nuxt/**",
];

/** 二进制文件扩展名 */
const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".class", ".jar", ".war", ".ear",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".tiff", ".tif", ".webp",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".mkv", ".wav", ".flac", ".ogg", ".m4a",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".wasm",
  ".sqlite", ".db", ".sqlite3",
  ".DS_Store",
]);

/** 检查文件扩展名是否为已知二进制格式 */
function hasBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// 二进制检测复用 ./binary-detect.ts —— 原先这里与 read.ts 各有一份逐字节相同的
// 实现，判据改一处就会漏另一处。read_many 只统计跳过数（不给单文件报错），
// 因此只用布尔封装即可；详细诊断信息由 read 工具在单文件路径上给出。

/** ReadMany 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const readManySchema = lazySchema(() =>
  z.object({
    pattern: z.array(z.string()).describe("glob 模式列表，如 [\"src/**/*.ts\", \"config/*.json\"]"),
    exclude: z.array(z.string()).optional().describe("排除模式列表（可选）"),
    path: z.string().optional().describe("搜索根目录，默认为当前目录"),
  }),
);

export class ReadManyTool implements Tool {
  private tracker: FileReadTracker | null;
  private stateCache: FileStateCache | null;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = readManySchema();

  /**
   * 构造函数兼容两种 tracker 类型（与 ReadTool 对齐）：
   * - FileReadTracker（旧版，用于 createStatefulTools 工厂和测试）
   * - FileStateCache（新版，LRU + 内容比对）
   */
  constructor(trackerOrCache?: FileReadTracker | FileStateCache) {
    if (!trackerOrCache) {
      this.stateCache = null;
      this.tracker = null;
    } else if ("set" in trackerOrCache && typeof trackerOrCache.set === "function") {
      this.stateCache = trackerOrCache as FileStateCache;
      this.tracker = null;
    } else {
      this.tracker = trackerOrCache as FileReadTracker;
      this.stateCache = null;
    }
  }

  readOnly(): boolean {
    return true;
  }

  name(): string {
    return "read_many";
  }

  description(): string {
    return "批量读取多个文件。通过 glob 模式匹配文件，一次性读取并拼接内容，大幅减少调用次数。";
  }

  usageGuide(): string {
    return `- 用于批量读取多个文件，如 "读取所有测试文件" 或 "读取整个配置目录"
- 支持 glob 模式，如 "src/**/*.ts" 或 "config/*.json"
- 自动排除 node_modules/.git/dist 等目录
- 每文件最多 ${MAX_LINES_PER_FILE} 行，总输出上限 ${MAX_TOTAL_OUTPUT} 字符
- 跳过二进制文件（图片、视频、压缩包等）和超过 10MB 的大文件
- 读取后自动注册到 tracker，后续可用 edit 工具编辑`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(readManySchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      pattern: string[];
      exclude?: string[];
      path?: string;
    };

    if (!params.pattern || params.pattern.length === 0) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    // AbortSignal 检查
    if (signal?.aborted) {
      return { output: "操作已取消", isError: true };
    }

    // 默认基于全局 cwd（"." 交给 normalizeToolPath 用 getCwd() 解析），跟随 bash 的 cd
    const searchPath = normalizeToolPath(params.path || ".");
    const excludePatterns = [...DEFAULT_EXCLUDES, ...(params.exclude || [])];

    log.info("TOOL", `▶ 批量读取 ${params.pattern.join(", ")} in ${searchPath}`);

    try {
      // 收集所有匹配的文件
      const allFiles = new Set<string>();
      for (const pattern of params.pattern) {
        if (signal?.aborted) {
          return { output: "操作已取消", isError: true };
        }
        const files = await glob(pattern, {
          cwd: searchPath,
          absolute: true,
          ignore: excludePatterns,
          nodir: true,
        });
        files.forEach(f => allFiles.add(f));
      }

      if (allFiles.size === 0) {
        return { output: "未找到匹配的文件" };
      }

      // 过滤二进制文件（扩展名检测）
      const textFiles = Array.from(allFiles).filter(f => !hasBinaryExtension(f));
      const skippedBinary = allFiles.size - textFiles.length;

      if (textFiles.length === 0) {
        return { output: `找到 ${allFiles.size} 个文件，但都是二进制文件（已跳过）` };
      }

      log.info("TOOL", `找到 ${textFiles.length} 个文本文件，开始并发读取`);

      // 并发读取所有文件
      let skippedLarge = 0;
      let skippedBinaryContent = 0;

      const results = await Promise.allSettled(
        textFiles.map(async (filePath) => {
          // AbortSignal 检查
          if (signal?.aborted) {
            throw new Error("操作已取消");
          }

          // 大文件保护：检查文件大小
          try {
            const stat = statSync(filePath);
            if (stat.size > MAX_SINGLE_FILE_BYTES) {
              skippedLarge++;
              return null; // 跳过大文件
            }
          } catch {
            return null; // stat 失败跳过
          }

          const file = Bun.file(filePath);
          const content = await file.text();

          // 二进制内容检测
          const contentBuffer = Buffer.from(content.slice(0, BINARY_CHECK_WINDOW));
          if (contentBuffer.length > 0 && isBinaryContent(contentBuffer)) {
            skippedBinaryContent++;
            return null;
          }

          // BOM 剥离
          let text = content;
          if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
          }

          const lines = text.split("\n");

          // CRLF → LF 规范化 + 截断超长文件
          let truncated = false;
          let fileLines: string[];
          if (lines.length > MAX_LINES_PER_FILE) {
            fileLines = lines.slice(0, MAX_LINES_PER_FILE);
            truncated = true;
          } else {
            fileLines = lines;
          }
          const normalizedLines = fileLines.map(line =>
            line.endsWith("\r") ? line.slice(0, -1) : line
          );
          const fileContent = normalizedLines.join("\n");

          // 注册到 tracker
          try {
            const mtime = statSync(filePath).mtimeMs;
            if (this.stateCache) {
              this.stateCache.set(filePath, {
                content: text,
                mtime,
                isPartialView: truncated,
              });
            } else if (this.tracker) {
              // 对标 claude-code：截断视图不足以安全 edit，记 isPartialView；
              // 完整读取时连内容一起记供 edit 前内容比对兜底。
              this.tracker.markAsRead(filePath, mtime, {
                isPartialView: truncated,
                content: truncated ? null : text,
              });
            }
          } catch {
            // 忽略 stat 失败
          }

          return {
            filePath: filePath.replace(searchPath + "/", ""),
            content: fileContent,
            truncated,
            totalLines: lines.length,
          };
        }),
      );

      // AbortSignal 最终检查
      if (signal?.aborted) {
        return { output: "操作已取消", isError: true };
      }

      // 收集成功读取的文件（过滤 null 和 rejected）
      const successResults = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
        .map(r => r.value);

      const failedCount = results.filter(r => r.status === "rejected").length;

      // 拼接输出
      let header = `成功读取 ${successResults.length} 个文件`;
      const notes: string[] = [];
      if (failedCount > 0) notes.push(`${failedCount} 个读取失败`);
      if (skippedBinary > 0) notes.push(`${skippedBinary} 个二进制文件跳过`);
      if (skippedLarge > 0) notes.push(`${skippedLarge} 个大文件跳过(>10MB)`);
      if (skippedBinaryContent > 0) notes.push(`${skippedBinaryContent} 个文件内容为二进制跳过`);
      if (notes.length > 0) header += `（${notes.join("，")}）`;
      header += ":\n\n";

      let totalChars = header.length;
      const parts: string[] = [header];

      for (const result of successResults) {
        const partHeader = `--- ${result.filePath} ---\n`;
        const footer = result.truncated
          ? `\n[文件已截断: 共 ${result.totalLines} 行，仅显示前 ${MAX_LINES_PER_FILE} 行，使用 read 工具获取完整内容]\n\n`
          : "\n\n";

        const part = partHeader + result.content + footer;

        // 检查是否超过总输出上限
        if (totalChars + part.length > MAX_TOTAL_OUTPUT) {
          const remaining = successResults.length - (parts.length - 1);
          parts.push(`\n[输出已截断: 已达到 ${MAX_TOTAL_OUTPUT} 字符上限，剩余 ${remaining} 个文件未显示]\n`);
          break;
        }

        parts.push(part);
        totalChars += part.length;
      }

      log.info("TOOL", `✓ 批量读取完成 ${successResults.length}个文件 ${totalChars}字符`);

      return { output: parts.join("") };
    } catch (err: any) {
      return { output: `批量读取失败: ${err.message}`, isError: true };
    }
  }
}
