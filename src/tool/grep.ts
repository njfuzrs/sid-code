/**
 * Grep 工具 - 搜索文件内容
 * 对标 Claude Code：基于 ripgrep 构建，支持 output_mode、上下文行数、文件类型过滤
 */

import type { Tool, ToolResult } from "./types.ts";
import { spawn } from "bun";
import { getLogger } from "../debug/logger.ts";

/** 输出截断阈值 */
const MAX_OUTPUT_LENGTH = 30000;

export class GrepTool implements Tool {
  readOnly(): boolean {
    return true;
  }

  name(): string {
    return "grep";
  }

  description(): string {
    return "在文件中搜索匹配正则表达式的内容。基于 ripgrep 构建，支持三种输出模式：files_with_matches（默认，最省 token）、content（显示匹配行和上下文）、count（显示匹配数）。";
  }

  usageGuide(): string {
    return `- 使用 grep 工具而不是 bash grep/rg 来搜索文件内容
- 支持正则表达式模式
- 默认 output_mode=files_with_matches，只返回文件路径，最省 token
- 需要看匹配内容时用 output_mode=content，配合 context 参数控制上下文行数
- 用 glob 参数过滤文件类型（如 '*.ts'），用 type 参数按语言过滤（如 'ts'）
- 搜索文件名请用 glob 工具，搜索内容请用 grep 工具`;
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
        output_mode: {
          type: "string",
          enum: ["files_with_matches", "content", "count"],
          description: "输出模式：files_with_matches（默认，只返回文件路径）、content（显示匹配行）、count（显示匹配数）",
        },
        case_insensitive: {
          type: "boolean",
          description: "是否忽略大小写，默认 false",
        },
        glob: {
          type: "string",
          description: "文件名过滤模式（如 '*.ts'、'*.{ts,tsx}'）",
        },
        type: {
          type: "string",
          description: "按文件类型过滤（如 'ts'、'py'、'js'），比 glob 更高效",
        },
        context: {
          type: "number",
          description: "显示匹配行前后的上下文行数（-C 参数），仅 output_mode=content 时有效",
        },
        before_context: {
          type: "number",
          description: "显示匹配行之前的行数（-B 参数），仅 output_mode=content 时有效",
        },
        after_context: {
          type: "number",
          description: "显示匹配行之后的行数（-A 参数），仅 output_mode=content 时有效",
        },
      },
      required: ["pattern"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      pattern: string;
      path?: string;
      output_mode?: "files_with_matches" | "content" | "count";
      case_insensitive?: boolean;
      glob?: string;
      type?: string;
      context?: number;
      before_context?: number;
      after_context?: number;
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    const searchPath = params.path || ".";
    const mode = params.output_mode || "files_with_matches";

    log.info("TOOL", `▶ 搜索 "${params.pattern}" in ${searchPath}`);

    // 优先尝试 ripgrep，降级到系统 grep
    const useRipgrep = await this.hasRipgrep();

    if (useRipgrep) {
      const result = await this.executeRipgrep(params, searchPath, mode);
      const matchCount = result.output === "未找到匹配的内容" ? 0 : result.output.split("\n").filter(Boolean).length;
      log.info("TOOL", `✓ 搜索完成 ${matchCount}个匹配`);
      return result;
    }
    const result = await this.executeFallbackGrep(params, searchPath, mode);
    const matchCount = result.output === "未找到匹配的内容" ? 0 : result.output.split("\n").filter(Boolean).length;
    log.info("TOOL", `✓ 搜索完成 ${matchCount}个匹配`);
    return result;
  }

  /** 检查 ripgrep 是否可用 */
  private async hasRipgrep(): Promise<boolean> {
    try {
      const proc = spawn({ cmd: ["rg", "--version"], stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** 使用 ripgrep 执行搜索 */
  private async executeRipgrep(
    params: {
      pattern: string;
      case_insensitive?: boolean;
      glob?: string;
      type?: string;
      context?: number;
      before_context?: number;
      after_context?: number;
    },
    searchPath: string,
    mode: string,
  ): Promise<ToolResult> {
    const args = ["rg"];

    // 输出模式
    switch (mode) {
      case "files_with_matches":
        args.push("--files-with-matches");
        break;
      case "count":
        args.push("--count");
        break;
      case "content":
        args.push("--line-number");
        // 上下文参数
        if (params.context !== undefined) {
          args.push("-C", String(params.context));
        }
        if (params.before_context !== undefined) {
          args.push("-B", String(params.before_context));
        }
        if (params.after_context !== undefined) {
          args.push("-A", String(params.after_context));
        }
        break;
    }

    // 大小写
    if (params.case_insensitive) {
      args.push("-i");
    }

    // 文件过滤
    if (params.glob) {
      args.push("--glob", params.glob);
    }
    if (params.type) {
      args.push("--type", params.type);
    }

    args.push(params.pattern, searchPath);

    try {
      const proc = spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      // rg 退出码 1 = 未找到匹配
      if (exitCode === 1) {
        return { output: "未找到匹配的内容" };
      }

      if (exitCode !== 0 && stderr) {
        return { output: `搜索失败: ${stderr}`, isError: true };
      }

      let output = stdout || "未找到匹配的内容";

      // 截断超长输出
      if (output.length > MAX_OUTPUT_LENGTH) {
        const truncated = output.slice(0, MAX_OUTPUT_LENGTH);
        const totalLines = output.split("\n").length;
        const shownLines = truncated.split("\n").length;
        output = `${truncated}\n\n... [输出已截断: 共 ${totalLines} 行，仅显示前 ${shownLines} 行]`;
      }

      return { output };
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }

  /** 降级到系统 grep */
  private async executeFallbackGrep(
    params: {
      pattern: string;
      case_insensitive?: boolean;
      glob?: string;
      context?: number;
      before_context?: number;
      after_context?: number;
    },
    searchPath: string,
    mode: string,
  ): Promise<ToolResult> {
    const args = ["grep", "-r"];

    switch (mode) {
      case "files_with_matches":
        args.push("-l");
        break;
      case "count":
        args.push("-c");
        break;
      case "content":
        args.push("-n");
        if (params.context !== undefined) {
          args.push("-C", String(params.context));
        }
        if (params.before_context !== undefined) {
          args.push("-B", String(params.before_context));
        }
        if (params.after_context !== undefined) {
          args.push("-A", String(params.after_context));
        }
        break;
    }

    if (params.case_insensitive) {
      args.push("-i");
    }

    if (params.glob) {
      args.push("--include", params.glob);
    }

    args.push(params.pattern, searchPath);

    try {
      const proc = spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      if (exitCode === 1) {
        return { output: "未找到匹配的内容" };
      }

      if (exitCode !== 0 && stderr) {
        return { output: `搜索失败: ${stderr}`, isError: true };
      }

      let output = stdout || "未找到匹配的内容";

      if (output.length > MAX_OUTPUT_LENGTH) {
        const truncated = output.slice(0, MAX_OUTPUT_LENGTH);
        output = `${truncated}\n\n... [输出已截断: 共 ${output.length} 字符]`;
      }

      return { output };
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }
}
