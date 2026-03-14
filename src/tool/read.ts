/**
 * Read 工具 - 读取文件内容
 * 支持行偏移和限制，用于读取大文件的部分内容
 * 读取后会记录到 FileReadTracker，供 Edit 工具校验
 */

import type { Tool, ToolResult } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { statSync } from "fs";

export class ReadTool implements Tool {
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  readOnly(): boolean {
    return true;
  }

  name(): string {
    return "read";
  }

  description(): string {
    return "读取文件内容。支持指定行偏移和限制来读取大文件的部分内容。";
  }

  usageGuide(): string {
    return `- 使用 read 而不是 bash cat/head/tail 来读取文件
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
          description: "读取的最大行数，默认读取全部",
        },
      },
      required: ["file_path"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { file_path: string; offset?: number; limit?: number };

    if (!params.file_path) {
      return { output: "错误: 缺少 file_path 参数", isError: true };
    }

    try {
      const file = Bun.file(params.file_path);
      const exists = await file.exists();
      if (!exists) {
        return { output: `错误: 文件不存在: ${params.file_path}`, isError: true };
      }

      const content = await file.text();
      const lines = content.split("\n");

      // 处理偏移和限制
      const offset = Math.max(1, params.offset || 1);
      const startIdx = offset - 1;
      const endIdx = params.limit ? startIdx + params.limit : lines.length;
      const selectedLines = lines.slice(startIdx, endIdx);

      // 记录文件已被读取
      if (this.tracker) {
        const mtime = statSync(params.file_path).mtimeMs;
        this.tracker.markAsRead(params.file_path, mtime);
      }

      // 格式化输出（带行号）
      const output = selectedLines
        .map((line, idx) => `${startIdx + idx + 1}→${line}`)
        .join("\n");

      return { output };
    } catch (err: any) {
      return { output: `读取文件失败: ${err.message}`, isError: true };
    }
  }
}
