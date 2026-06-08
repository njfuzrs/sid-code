/**
 * Grep 工具 - 搜索文件内容
 * 对标 Claude Code：基于 ripgrep 构建，支持 output_mode、上下文行数、文件类型过滤
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { spawn } from "bun";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";

/** 输出截断阈值 */
const MAX_OUTPUT_LENGTH = 30000;

/** 默认总匹配数上限 */
const DEFAULT_TOTAL_MAX_MATCHES = 100;

/** 匹配结果结构 */
interface GrepMatch {
  filePath: string;
  absolutePath: string;
  lineNumber: number;
  line: string;
  isContext?: boolean;
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
- 当匹配数 1-3 个时，自动添加周围代码上下文（1个匹配50行，2-3个匹配15行），省去再次 read
- 用 glob 参数过滤文件类型（如 '*.ts'），用 type 参数按语言过滤（如 'ts'）
- 用 exclude_pattern 过滤掉不想要的匹配行
- 用 total_max_matches 限制总结果数（默认100），防止结果过多
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
        exclude_pattern: {
          type: "string",
          description: "正则表达式，用于过滤掉匹配的行（后置过滤）",
        },
        total_max_matches: {
          type: "number",
          description: "总结果数上限，默认 100，防止结果过多",
        },
        max_matches_per_file: {
          type: "number",
          description: "单文件结果数上限，用于限制单个文件的匹配数",
        },
        fixed_strings: {
          type: "boolean",
          description: "按字面量搜索（不作为正则表达式），默认 false",
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
      exclude_pattern?: string;
      total_max_matches?: number;
      max_matches_per_file?: number;
      fixed_strings?: boolean;
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    // 验证 exclude_pattern 正则
    if (params.exclude_pattern && !params.fixed_strings) {
      try {
        new RegExp(params.exclude_pattern);
      } catch {
        return { output: `错误: exclude_pattern 不是有效的正则表达式: ${params.exclude_pattern}`, isError: true };
      }
    }

    const searchPath = normalizeToolPath(params.path || ".");
    const mode = params.output_mode || "files_with_matches";
    const totalMaxMatches = params.total_max_matches ?? DEFAULT_TOTAL_MAX_MATCHES;

    log.info("TOOL", `▶ 搜索 "${params.pattern}" in ${searchPath}`);

    // 优先尝试 ripgrep，降级到系统 grep
    const useRipgrep = await this.hasRipgrep();

    if (useRipgrep) {
      const result = await this.executeRipgrep(params, searchPath, mode, totalMaxMatches);
      log.info("TOOL", `✓ 搜索完成`);
      return result;
    }
    const result = await this.executeFallbackGrep(params, searchPath, mode, totalMaxMatches);
    log.info("TOOL", `✓ 搜索完成`);
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
      exclude_pattern?: string;
      max_matches_per_file?: number;
      fixed_strings?: boolean;
    },
    searchPath: string,
    mode: string,
    totalMaxMatches: number,
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

      // 解析匹配结果
      const matches = this.parseRipgrepOutput(output, mode, searchPath);

      // 应用 exclude_pattern 过滤（只过滤匹配行，保留上下文行）
      let filteredMatches = matches;
      if (params.exclude_pattern && mode === "content") {
        const excludeRegex = new RegExp(params.exclude_pattern, params.case_insensitive ? "i" : "");
        filteredMatches = matches.filter(m => m.isContext || !excludeRegex.test(m.line));
      }

      // 应用 total_max_matches 限制
      const actualMatches = filteredMatches.filter(m => !m.isContext);
      const wasTruncated = actualMatches.length > totalMaxMatches;
      if (wasTruncated) {
        filteredMatches = filteredMatches.slice(0, totalMaxMatches);
      }

      // 自动上下文丰富（仅当匹配数 1-3 且未指定上下文参数时）
      if (mode === "content" && actualMatches.length >= 1 && actualMatches.length <= 3 &&
          params.context === undefined && params.before_context === undefined && params.after_context === undefined) {
        filteredMatches = await this.enrichWithAutoContext(filteredMatches, actualMatches.length, searchPath);
      }

      // 格式化输出
      output = this.formatGrepResults(filteredMatches, mode, params.pattern, wasTruncated, totalMaxMatches);

      return { output };
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }

  /** 解析 ripgrep 输出为结构化匹配结果 */
  private parseRipgrepOutput(output: string, mode: string, searchPath: string): GrepMatch[] {
    if (mode !== "content") {
      return []; // files_with_matches 和 count 模式不需要解析
    }

    const matches: GrepMatch[] = [];
    const lines = output.split("\n");
    let currentFile = "";

    for (const line of lines) {
      if (!line) continue;

      // 解析格式：path:lineNumber:content 或 path-lineNumber-content（上下文行）
      const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
      const contextLine = line.match(/^(.+?)-(\d+)-(.*)$/);

      if (matchLine) {
        const [, filePath, lineNum, content] = matchLine;
        currentFile = filePath;
        matches.push({
          filePath,
          absolutePath: `${searchPath}/${filePath}`,
          lineNumber: parseInt(lineNum, 10),
          line: content,
          isContext: false,
        });
      } else if (contextLine) {
        const [, filePath, lineNum, content] = contextLine;
        matches.push({
          filePath: filePath || currentFile,
          absolutePath: `${searchPath}/${filePath || currentFile}`,
          lineNumber: parseInt(lineNum, 10),
          line: content,
          isContext: true,
        });
      }
    }

    return matches;
  }

  /** 自动上下文丰富：当匹配数少时自动添加周围代码 */
  private async enrichWithAutoContext(
    matches: GrepMatch[],
    matchCount: number,
    searchPath: string,
  ): Promise<GrepMatch[]> {
    const contextLines = matchCount === 1 ? 50 : 15;
    const matchesByFile = new Map<string, GrepMatch[]>();

    // 按文件分组
    for (const match of matches) {
      if (!matchesByFile.has(match.filePath)) {
        matchesByFile.set(match.filePath, []);
      }
      matchesByFile.get(match.filePath)!.push(match);
    }

    const enrichedMatches: GrepMatch[] = [];

    // 为每个文件读取并添加上下文
    for (const [filePath, fileMatches] of matchesByFile) {
      try {
        const absolutePath = fileMatches[0].absolutePath;
        const file = Bun.file(absolutePath);
        const content = await file.text();
        const fileLines = content.split("\n");

        const seenLines = new Set<number>();
        const newMatches: GrepMatch[] = [];

        // 按行号排序
        fileMatches.sort((a, b) => a.lineNumber - b.lineNumber);

        for (const match of fileMatches) {
          const startLine = Math.max(1, match.lineNumber - contextLines);
          const endLine = Math.min(fileLines.length, match.lineNumber + contextLines);

          for (let i = startLine; i <= endLine; i++) {
            if (!seenLines.has(i)) {
              newMatches.push({
                filePath,
                absolutePath,
                lineNumber: i,
                line: fileLines[i - 1] || "",
                isContext: i !== match.lineNumber,
              });
              seenLines.add(i);
            } else if (i === match.lineNumber) {
              // 确保匹配行标记为非上下文
              const existing = newMatches.find(m => m.lineNumber === i);
              if (existing) existing.isContext = false;
            }
          }
        }

        enrichedMatches.push(...newMatches.sort((a, b) => a.lineNumber - b.lineNumber));
      } catch {
        // 读取失败时保留原始匹配
        enrichedMatches.push(...fileMatches);
      }
    }

    return enrichedMatches;
  }

  /** 格式化 grep 结果为可读输出 */
  private formatGrepResults(
    matches: GrepMatch[],
    mode: string,
    pattern: string,
    wasTruncated: boolean,
    totalMaxMatches: number,
  ): string {
    if (mode !== "content" || matches.length === 0) {
      return "未找到匹配的内容";
    }

    const actualMatches = matches.filter(m => !m.isContext);
    const matchCount = actualMatches.length;
    const matchTerm = matchCount === 1 ? "个匹配" : "个匹配";

    let output = `找到 ${matchCount} ${matchTerm}，模式 "${pattern}"`;
    if (wasTruncated) {
      output += ` (结果已限制为 ${totalMaxMatches} 条匹配)`;
    }
    output += ":\n---\n";

    // 按文件分组
    const matchesByFile = new Map<string, GrepMatch[]>();
    for (const match of matches) {
      if (!matchesByFile.has(match.filePath)) {
        matchesByFile.set(match.filePath, []);
      }
      matchesByFile.get(match.filePath)!.push(match);
    }

    // 输出每个文件的匹配
    for (const [filePath, fileMatches] of matchesByFile) {
      output += `File: ${filePath}\n`;
      for (const match of fileMatches) {
        const separator = match.isContext ? "-" : ":";
        const lineContent = match.line.trimEnd();
        output += `L${match.lineNumber}${separator} ${lineContent}\n`;
      }
      output += "---\n";
    }

    // 截断超长输出
    if (output.length > MAX_OUTPUT_LENGTH) {
      const truncated = output.slice(0, MAX_OUTPUT_LENGTH);
      return `${truncated}\n\n... [输出已截断: 共 ${output.length} 字符，仅显示前 ${MAX_OUTPUT_LENGTH} 字符]`;
    }

    return output.trim();
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
      exclude_pattern?: string;
      fixed_strings?: boolean;
    },
    searchPath: string,
    mode: string,
    totalMaxMatches: number,
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

      // 简单处理：系统 grep 不做复杂的结构化解析和自动上下文
      // 只应用 exclude_pattern 和截断
      if (params.exclude_pattern && mode === "content") {
        const excludeRegex = new RegExp(params.exclude_pattern, params.case_insensitive ? "i" : "");
        const lines = output.split("\n");
        const filtered = lines.filter(line => {
          const match = line.match(/^.+?:\d+:(.*)$/);
          return !match || !excludeRegex.test(match[1]);
        });
        output = filtered.join("\n");
      }

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
