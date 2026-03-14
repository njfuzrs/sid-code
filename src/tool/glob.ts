/**
 * Glob 工具 - 文件名模式匹配
 * 使用 glob 模式查找文件
 */

import type { Tool, ToolResult } from "./types.ts";
import { glob } from "glob";

export class GlobTool implements Tool {
  readOnly(): boolean {
    return true;
  }

  name(): string {
    return "glob";
  }

  description(): string {
    return "使用 glob 模式查找文件。支持通配符如 **/*.ts";
  }

  usageGuide(): string {
    return `- 使用 glob 而不是 bash find/ls 来查找文件
- 支持通配符：* 匹配文件名，** 匹配任意层级目录
- 默认忽略 node_modules、.git、dist 目录
- 搜索文件内容请用 grep 工具，glob 只按文件名匹配`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob 模式（如 '**/*.ts', 'src/**/*.js'）",
        },
        path: {
          type: "string",
          description: "搜索的基础路径，默认为当前目录",
        },
        ignore: {
          type: "array",
          items: { type: "string" },
          description: "要忽略的模式列表（如 ['node_modules/**', '.git/**']）",
        },
      },
      required: ["pattern"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      pattern: string;
      path?: string;
      ignore?: string[];
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    try {
      const cwd = params.path || process.cwd();
      const ignore = params.ignore || ["node_modules/**", ".git/**", "dist/**"];

      const files = await glob(params.pattern, {
        cwd,
        ignore,
        nodir: true,
      });

      if (files.length === 0) {
        return { output: "未找到匹配的文件" };
      }

      // 按修改时间排序（最新的在前）
      const sorted = files.sort();

      return { output: sorted.join("\n") };
    } catch (err: any) {
      return { output: `文件匹配失败: ${err.message}`, isError: true };
    }
  }
}
