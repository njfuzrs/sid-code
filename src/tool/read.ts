/**
 * Read 工具 - 读取文件内容
 * 支持行偏移和限制，用于读取大文件的部分内容
 * 读取后会记录到 FileReadTracker，供 Edit 工具校验
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { statSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";

/** 未指定 limit 时的默认最大行数，防止超大文件撑爆上下文 */
const DEFAULT_MAX_LINES = 2000;

export class ReadTool implements Tool {
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "read";
  }

  description(): string {
    return "读取文件内容。支持指定行偏移和限制来读取大文件的部分内容。默认最多读取 2000 行，超出时会提示如何继续读取。";
  }

  usageGuide(): string {
    return `- 使用 read 而不是 bash cat/head/tail 来读取文件
- 默认最多读取 2000 行，超出时输出末尾会有截断提示
- 对于大文件，使用 offset 和 limit 参数只读取需要的部分
- 修改文件前必须先用 read 读取，确保了解当前内容
- file_path 必须是绝对路径`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "要读取的文件的绝对路径",
        },
        offset: {
          type: "number",
          description: "起始行号（从 1 开始），默认为 1",
        },
        limit: {
          type: "number",
          description: `读取的最大行数，默认 ${DEFAULT_MAX_LINES} 行`,
        },
      },
      required: ["file_path"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { file_path: string; offset?: number; limit?: number };

    if (!params.file_path) {
      return { output: "错误: 缺少 file_path 参数", isError: true };
    }

    let filePath: string;
    try {
      filePath = normalizeToolPath(params.file_path);
    } catch (err: any) {
      return { output: `路径无效: ${err.message}`, isError: true };
    }

    log.info("TOOL", `▶ 读取 ${filePath} offset=${params.offset ?? 1} limit=${params.limit ?? DEFAULT_MAX_LINES}`);

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) {
        return { output: formatPathNotFoundError(filePath), isError: true };
      }

      const content = await file.text();
      const lines = content.split("\n");
      const totalLines = lines.length;

      // 处理偏移和限制（未指定 limit 时应用默认上限）
      const offset = Math.max(1, params.offset || 1);
      const startIdx = offset - 1;
      const maxLines = params.limit ?? DEFAULT_MAX_LINES;
      const endIdx = Math.min(startIdx + maxLines, totalLines);
      const selectedLines = lines.slice(startIdx, endIdx);
      const isTruncated = endIdx < totalLines;

      // 记录文件已被读取
      if (this.tracker) {
        const mtime = statSync(filePath).mtimeMs;
        this.tracker.markAsRead(filePath, mtime);
      }

      // 格式化输出（带行号）
      let output = selectedLines
        .map((line, idx) => `${startIdx + idx + 1}→${line}`)
        .join("\n");

      // 截断提示：告知 LLM 当前显示的行范围和总行数
      if (isTruncated) {
        const shownStart = offset;
        const shownEnd = endIdx;
        const nextOffset = endIdx + 1;
        output += `\n\n[文件已截断：当前显示第 ${shownStart}-${shownEnd} 行，共 ${totalLines} 行。如需读取更多，请使用 offset=${nextOffset} 继续读取。]`;
      }

      log.info("TOOL", `✓ 读取 ${filePath} ${selectedLines.length}行 ${isTruncated ? `(截断，共${totalLines}行)` : ""}`);

      return { output };
    } catch (err: any) {
      return { output: `读取文件失败: ${err.message}`, isError: true };
    }
  }
}
