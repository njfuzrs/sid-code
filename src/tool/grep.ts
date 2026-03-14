/**
 * Grep 工具 - 搜索文件内容
 * 使用正则表达式在文件中搜索匹配的行
 */

import type { Tool, ToolResult } from "./types.ts";
import { spawn } from "bun";

export class GrepTool implements Tool {
  readOnly(): boolean {
    return true;
  }

  name(): string {
    return "grep";
  }

  description(): string {
    return "在文件中搜索匹配正则表达式的内容。支持递归搜索目录。";
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "要搜索的正则表达式模式",
        },
        path: {
          type: "string",
          description: "要搜索的文件或目录路径，默认为当前目录",
        },
        case_insensitive: {
          type: "boolean",
          description: "是否忽略大小写，默认 false",
        },
        glob: {
          type: "string",
          description: "文件名过滤模式（如 '*.ts'）",
        },
      },
      required: ["pattern"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      pattern: string;
      path?: string;
      case_insensitive?: boolean;
      glob?: string;
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    const path = params.path || ".";
    const args = ["grep", "-n", "-r"];

    if (params.case_insensitive) {
      args.push("-i");
    }

    if (params.glob) {
      args.push("--include", params.glob);
    }

    args.push(params.pattern, path);

    try {
      const proc = spawn({
        cmd: args,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      // grep 退出码 1 表示未找到匹配，不是错误
      if (exitCode === 1) {
        return { output: "未找到匹配的内容" };
      }

      if (exitCode !== 0 && stderr) {
        return { output: `搜索失败: ${stderr}`, isError: true };
      }

      return { output: stdout || "未找到匹配的内容" };
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }
}
