/**
 * ReadMany 工具 - 批量读取文件
 * 通过 glob 模式一次性读取多个文件，大幅减少 LLM 轮次
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { glob } from "glob";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";

/** 每文件最大行数 */
const MAX_LINES_PER_FILE = 400;

/** 总输出上限 */
const MAX_TOTAL_OUTPUT = 100000;

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
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".mp4", ".avi", ".mov", ".mp3", ".wav",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".woff", ".woff2", ".ttf", ".eot",
]);

export class ReadManyTool implements Tool {
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
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
- 每文件最多 200 行，总输出上限 50000 字符
- 跳过二进制文件（图片、视频、压缩包等）
- 读取后自动注册到 FileReadTracker，后续可用 edit 工具编辑`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "array",
          items: { type: "string" },
          description: "glob 模式列表，如 [\"src/**/*.ts\", \"config/*.json\"]",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "排除模式列表（可选）",
        },
        path: {
          type: "string",
          description: "搜索根目录，默认为当前目录",
        },
      },
      required: ["pattern"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      pattern: string[];
      exclude?: string[];
      path?: string;
    };

    if (!params.pattern || params.pattern.length === 0) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    const searchPath = normalizeToolPath(params.path || process.cwd());
    const excludePatterns = [...DEFAULT_EXCLUDES, ...(params.exclude || [])];

    log.info("TOOL", `▶ 批量读取 ${params.pattern.join(", ")} in ${searchPath}`);

    try {
      // 收集所有匹配的文件
      const allFiles = new Set<string>();
      for (const pattern of params.pattern) {
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

      // 过滤二进制文件
      const textFiles = Array.from(allFiles).filter(f => {
        const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
        return !BINARY_EXTENSIONS.has(ext);
      });

      if (textFiles.length === 0) {
        return { output: `找到 ${allFiles.size} 个文件，但都是二进制文件（已跳过）` };
      }

      log.info("TOOL", `找到 ${textFiles.length} 个文本文件，开始并发读取`);

      // 并发读取所有文件
      const results = await Promise.allSettled(
        textFiles.map(async (filePath) => {
          const file = Bun.file(filePath);
          const content = await file.text();
          const lines = content.split("\n");

          // 截断超长文件
          let truncated = false;
          let fileContent = content;
          if (lines.length > MAX_LINES_PER_FILE) {
            fileContent = lines.slice(0, MAX_LINES_PER_FILE).join("\n");
            truncated = true;
          }

          // 注册到 FileReadTracker
          if (this.tracker) {
            try {
              const stats = await file.stat();
              this.tracker.markAsRead(filePath, stats.mtimeMs);
            } catch {
              // 忽略 stat 失败
            }
          }

          return {
            filePath: filePath.replace(searchPath + "/", ""),
            content: fileContent,
            truncated,
            totalLines: lines.length,
          };
        }),
      );

      // 收集成功读取的文件
      const successResults = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map(r => r.value);

      const failedCount = results.length - successResults.length;

      // 拼接输出
      let output = `成功读取 ${successResults.length} 个文件`;
      if (failedCount > 0) {
        output += `（${failedCount} 个失败）`;
      }
      output += ":\n\n";

      let totalChars = output.length;
      const parts: string[] = [output];

      for (const result of successResults) {
        const header = `--- ${result.filePath} ---\n`;
        const footer = result.truncated
          ? `\n... [文件已截断: 共 ${result.totalLines} 行，仅显示前 ${MAX_LINES_PER_FILE} 行，使用 read 工具获取完整内容]\n\n`
          : "\n\n";

        const part = header + result.content + footer;

        // 检查是否超过总输出上限
        if (totalChars + part.length > MAX_TOTAL_OUTPUT) {
          parts.push(`\n... [输出已截断: 已达到 ${MAX_TOTAL_OUTPUT} 字符上限，剩余 ${successResults.length - parts.length + 1} 个文件未显示]\n`);
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
