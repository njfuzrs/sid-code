/**
 * Write 工具 - 写入文件内容
 * 自动创建目录，覆盖已存在的文件
 */

import type { Tool, ToolResult } from "./types.ts";
import { dirname } from "path";
import { mkdirSync, existsSync } from "fs";

export class WriteTool implements Tool {
  name(): string {
    return "write";
  }

  description(): string {
    return "写入内容到文件。如果文件已存在则覆盖，自动创建所需的目录。";
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "要写入的文件的绝对路径",
        },
        content: {
          type: "string",
          description: "要写入的内容",
        },
      },
      required: ["file_path", "content"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { file_path: string; content: string };

    if (!params.file_path) {
      return { output: "错误: 缺少 file_path 参数", isError: true };
    }

    if (params.content === undefined) {
      return { output: "错误: 缺少 content 参数", isError: true };
    }

    try {
      // 确保目录存在
      const dir = dirname(params.file_path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 写入文件
      await Bun.write(params.file_path, params.content);

      return { output: `文件已写入: ${params.file_path}` };
    } catch (err: any) {
      return { output: `写入文件失败: ${err.message}`, isError: true };
    }
  }
}
