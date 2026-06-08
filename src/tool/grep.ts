/**
 * Grep 工具 - 搜索文件内容
 * 对标 Claude Code：基于 ripgrep 构建，支持 output_mode、分页、mtime 排序
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { ripGrep, hasRipgrep, RipgrepTimeoutError } from "./ripgrep.ts";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { statSync } from "node:fs";
import { relative, resolve, normalize } from "node:path";

/** 输出截断阈值 */
const MAX_OUTPUT_LENGTH = 30000;

/** 默认 head_limit（与 CC 一致） */
const DEFAULT_HEAD_LIMIT = 250;

/** VCS 排除 glob 模式 */
const VCS_EXCLUDE_GLOBS = ["!.git", "!.svn", "!.hg"];

/** max-columns 限制（防止 minified 文件输出过大） */
const MAX_COLUMNS = 500;

/** 结构化输出类型 */
interface StructuredOutput {
  mode: "files_with_matches" | "content" | "count";
  numFiles: number;
  filenames: string[];
  content: string;
  numLines?: number;
  numMatches: number;
  appliedLimit?: number;
  appliedOffset?: number;
}

export class GrepTool implements Tool {
  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "grep";
  }

  description(): string {
    return "在文件中搜索匹配正则表达式的内容。基于 ripgrep 构建，支持三种输出模式：files_with_matches（默认，最省 token）、content（显示匹配行和上下文）、count（显示匹配数）。";
  }

  usageGuide(): string {
    return `- 使用 grep 工具而不是 bash grep/rg 来搜索文件内容
- 支持正则表达式模式，用 fixed_strings=true 可按字面量搜索
- 默认 output_mode=files_with_matches，只返回文件路径，最省 token
- 需要看匹配内容时用 output_mode=content，配合 context 参数控制上下文行数
- 用 glob 参数过滤文件类型（如 '*.ts'），用 type 参数按语言过滤（如 'ts'）
- 用 head_limit 限制结果数（默认 250），用 offset 翻页（默认 0）；显式传 0 表示无限制
- 结果文件按修改时间降序排列（最近编辑的文件在前）
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
        head_limit: {
          type: "number",
          description: "输出结果数上限，默认 250；显式传 0 表示无限制。替代旧的 total_max_matches",
        },
        offset: {
          type: "number",
          description: "分页偏移量（从 0 开始），默认 0",
        },
        max_matches_per_file: {
          type: "number",
          description: "单文件结果数上限，用于限制单个文件的匹配数",
        },
        fixed_strings: {
          type: "boolean",
          description: "按字面量搜索（不作为正则表达式），默认 false",
        },
        // 向后兼容：total_max_matches 作为 head_limit 别名
        total_max_matches: {
          type: "number",
          description: "已废弃，请使用 head_limit 代替",
        },
      },
      required: ["pattern"],
    };
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
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
      head_limit?: number;
      offset?: number;
      max_matches_per_file?: number;
      fixed_strings?: boolean;
      total_max_matches?: number;
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    const searchPath = normalizeToolPath(params.path || ".");
    const mode = params.output_mode || "files_with_matches";
    const headLimit = params.head_limit ?? params.total_max_matches ?? DEFAULT_HEAD_LIMIT;
    const offset = params.offset ?? 0;

    log.info("TOOL", `▶ 搜索 "${params.pattern}" in ${searchPath}`);

    // 构建 abort signal
    const abortController = new AbortController();
    const abortSignal = signal ?? abortController.signal;
    if (signal) {
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    // 检查 ripgrep 是否可用
    const useRipgrep = await hasRipgrep();

    try {
      if (useRipgrep) {
        const result = await this.executeWithRipgrep(params, searchPath, mode, headLimit, offset, abortSignal);
        log.info("TOOL", `✓ 搜索完成`);
        return result;
      }
      const result = await this.executeFallbackGrep(params, searchPath, mode, headLimit, offset);
      log.info("TOOL", `✓ 搜索完成`);
      return result;
    } catch (err: any) {
      if (err instanceof RipgrepTimeoutError) {
        if (err.partialResults.length > 0) {
          const output = this.formatStructuredOutput(
            mode, err.partialResults, searchPath, headLimit === 0 ? undefined : headLimit, offset,
            `警告: 搜索超时，仅返回部分结果（${err.partialResults.length} 行）。请尝试缩小搜索范围。`,
          );
          return { output };
        }
        return { output: err.message, isError: true };
      }
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }

  /** 使用 ripgrep 执行搜索（通过 ripgrep.ts 执行层） */
  private async executeWithRipgrep(
    params: {
      pattern: string;
      case_insensitive?: boolean;
      glob?: string;
      type?: string;
      context?: number;
      before_context?: number;
      after_context?: number;
      max_matches_per_file?: number;
      fixed_strings?: boolean;
    },
    searchPath: string,
    mode: string,
    headLimit: number,
    offset: number,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    const args: string[] = [];

    // 默认参数增强：始终添加（对标 CC）
    args.push("--hidden");

    // VCS 目录排除
    for (const glob of VCS_EXCLUDE_GLOBS) {
      args.push("--glob", glob);
    }

    // max-columns 限制
    args.push("--max-columns", String(MAX_COLUMNS));

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

    // 字面量搜索
    if (params.fixed_strings) {
      args.push("--fixed-strings");
    }

    // 单文件匹配数限制
    if (params.max_matches_per_file !== undefined) {
      args.push("--max-count", String(params.max_matches_per_file));
    }

    // 文件过滤
    if (params.glob) {
      args.push("--glob", params.glob);
    }
    if (params.type) {
      args.push("--type", params.type);
    }

    // pattern 作为最后一个 arg
    args.push(params.pattern);

    const lines = await ripGrep(args, searchPath, abortSignal);

    if (lines.length === 0) {
      return { output: "未找到匹配的内容" };
    }

    // 按 mtime 排序（files_with_matches / count 模式）
    const sortedLines = this.sortLinesByMtime(lines, searchPath, mode);

    // 应用分页
    const { appliedLimit, pagedLines } = this.applyPagination(sortedLines, mode, headLimit, offset);

    const output = this.formatStructuredOutput(mode, pagedLines, searchPath, appliedLimit, offset);

    return { output };
  }

  /**
   * 从 rg 输出行中提取文件路径
   * 处理三种输出格式：
   * - files_with_matches: "path/to/file"（整行）
   * - count: "path/to/file:42"（最后一个 : 之前）
   * - content: "path/to/file:10:matched" 或 "path/to/file-15-context"（rg 用 :数字: 或 -数字- 分隔）
   */
  private extractFilePath(line: string, mode: string): string {
    if (mode === "files_with_matches") {
      return line;
    }

    if (mode === "count") {
      const lastColon = line.lastIndexOf(":");
      if (lastColon > 0) {
        return line.substring(0, lastColon);
      }
      return line;
    }

    // content 模式：匹配 rg 的 "filepath:数字:..." 或 "filepath-数字-" 格式
    const match = line.match(/^(.+?)([-:])\d+\2/);
    if (match) {
      return match[1];
    }

    // fallback：第一个 : 之前
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      return line.substring(0, colonIdx);
    }

    return line;
  }

  /** 按文件 mtime 降序排列结果行 */
  private sortLinesByMtime(lines: string[], searchPath: string, mode: string): string[] {
    const fileLines = new Map<string, string[]>();

    for (const line of lines) {
      const filePath = this.extractFilePath(line, mode);

      if (!fileLines.has(filePath)) {
        fileLines.set(filePath, []);
      }
      fileLines.get(filePath)!.push(line);
    }

    // 获取每个文件的 mtime
    const fileMtimes = new Map<string, number>();
    for (const filePath of fileLines.keys()) {
      try {
        const fullPath = resolve(searchPath, filePath);
        fileMtimes.set(filePath, statSync(fullPath).mtimeMs);
      } catch {
        fileMtimes.set(filePath, 0); // 无法获取 mtime 的排在最后
      }
    }

    // 按 mtime 降序排列文件，然后拼接每行的结果
    const sortedFiles = [...fileLines.keys()].sort((a, b) => {
      return (fileMtimes.get(b) ?? 0) - (fileMtimes.get(a) ?? 0);
    });

    return sortedFiles.flatMap((file) => fileLines.get(file) ?? []);
  }

  /** 应用分页截断 */
  private applyPagination(
    lines: string[],
    mode: string,
    headLimit: number,
    offset: number,
  ): { appliedLimit?: number; pagedLines: string[] } {
    // headLimit === 0 表示无限制
    if (headLimit === 0) {
      return { appliedLimit: undefined, pagedLines: lines };
    }

    const start = offset;
    const end = offset + headLimit;
    const pagedLines = lines.slice(start, end);

    return { appliedLimit: headLimit, pagedLines };
  }

  /** 格式化结构化 JSON 输出 */
  private formatStructuredOutput(
    mode: string,
    lines: string[],
    searchPath: string,
    appliedLimit: number | undefined,
    offset: number,
    warning?: string,
  ): string {
    // 提取唯一文件名
    const filenames = new Set<string>();
    const relativeFilenames = new Set<string>();

    for (const line of lines) {
      const filePath = this.extractFilePath(line, mode);

      try {
        const resolvedPath = resolve(searchPath, filePath);
        const relPath = relative(normalize(searchPath), normalize(resolvedPath));
        relativeFilenames.add(relPath || filePath);
      } catch {
        relativeFilenames.add(filePath);
      }
      filenames.add(filePath);
    }

    // 计算匹配数（非上下文行的数量，content 模式才区分）
    let numMatches = lines.length;
    if (mode === "content") {
      numMatches = lines.filter((l) => !l.match(/^.+-(\d+)-/)).length;
    } else if (mode === "files_with_matches") {
      numMatches = lines.length;
    }

    // 构建结构化输出
    const structured: StructuredOutput = {
      mode: mode as StructuredOutput["mode"],
      numFiles: relativeFilenames.size,
      filenames: [...relativeFilenames], // 保持 mtime 排序顺序（不重新字母排序）
      content: lines.join("\n"),
      numLines: lines.length,
      numMatches,
      appliedLimit,
      appliedOffset: offset,
    };

    // 序列化为 JSON（紧凑格式节省 token）
    let json = JSON.stringify(structured);

    // 如果超长，截断 content 字段
    if (json.length > MAX_OUTPUT_LENGTH) {
      const truncated = lines.slice(0, Math.floor(lines.length * 0.8));
      structured.content = truncated.join("\n") + "\n... [输出已截断]";
      structured.numLines = truncated.length;
      json = JSON.stringify(structured);
    }

    if (warning) {
      json = json.slice(0, -1) + `,"warning":"${warning}"}`;
    }

    return json;
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
      fixed_strings?: boolean;
    },
    searchPath: string,
    mode: string,
    headLimit: number,
    offset: number,
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

    if (params.fixed_strings) {
      args.push("-F");
    }

    if (params.glob) {
      args.push("--include", params.glob);
    }

    args.push(params.pattern, searchPath);

    try {
      const { spawn } = await import("bun");
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

      const lines = (stdout || "").trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        return { output: "未找到匹配的内容" };
      }

      // 按 mtime 排序
      const sortedLines = this.sortLinesByMtime(lines, searchPath, mode);

      // 应用分页
      const { appliedLimit, pagedLines } = this.applyPagination(sortedLines, mode, headLimit, offset);

      const output = this.formatStructuredOutput(mode, pagedLines, searchPath, appliedLimit, offset);

      return { output };
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }
}
