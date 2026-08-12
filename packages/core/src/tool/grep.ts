/**
 * Grep 工具 - 搜索文件内容
 * 对标 Claude Code：基于 ripgrep 构建，支持 output_mode、分页、mtime 排序
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { ripGrep, hasRipgrep, RipgrepTimeoutError } from "./ripgrep.ts";
import { resolveGrepType } from "./grep-type-alias.ts";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { pickPaths } from "./jit-affected-paths.ts";
import { statSync, existsSync } from "node:fs";
import { relative, resolve, normalize } from "node:path";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 输出截断阈值 */
const MAX_OUTPUT_LENGTH = 30000;

/** Grep 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const grepSchema = lazySchema(() =>
  z.object({
    pattern: z.string().describe("要搜索的正则表达式模式"),
    // ⚠️ 描述必须明确"单个路径"：同 schema 里 glob 的描述写着"多个模式用空格分隔"，
    // 实测模型会把这个语感带到 path 上，用空格拼 3 个绝对路径塞进来（2026-08-01 会话），
    // 得到"路径不存在 '<拼接串>'"。要搜多处应发多次调用，或指向共同父目录 + glob 收窄。
    path: z
      .string()
      .optional()
      .describe(
        "要搜索的**单个**文件或目录路径，默认为当前目录。不支持传多个路径（不要用空格/逗号拼接）——" +
          "要搜多个位置请分多次调用，或传它们的共同父目录并用 glob/type 收窄范围。",
      ),
    output_mode: z
      .enum(["files_with_matches", "content", "count"])
      .optional()
      .describe(
        "输出模式：files_with_matches（默认，只返回文件路径）、content（显示匹配行）、count（显示匹配数）",
      ),
    case_insensitive: z.boolean().optional().describe("是否忽略大小写，默认 false"),
    glob: z
      .string()
      .optional()
      .describe("文件名过滤模式（如 '*.ts'、'*.{ts,tsx}'），多个模式用空格分隔"),
    // 描述里点名 tsx/jsx 的坑：ripgrep 没有 tsx/jsx 类型（ts 已含 *.tsx，js 已含 *.jsx）。
    // 写错也不会失败（工具层会归一或降级），但直接写对能省掉一次提示往返。
    type: z
      .string()
      .optional()
      .describe(
        "按 ripgrep 文件类型过滤（如 'ts'、'js'、'py'、'go'、'rust'），比 glob 更高效。" +
          "注意：ripgrep 无 'tsx'/'jsx' 类型——'ts' 已包含 *.tsx，'js' 已包含 *.jsx；" +
          "要精确只搜 .tsx 请用 glob='*.tsx'",
      ),
    context: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("显示匹配行前后的上下文行数（-C 参数），仅 output_mode=content 时有效"),
    before_context: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("显示匹配行之前的行数（-B 参数），仅 output_mode=content 时有效"),
    after_context: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("显示匹配行之后的行数（-A 参数），仅 output_mode=content 时有效"),
    head_limit: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("输出结果数上限，默认 250；显式传 0 表示无限制。替代旧的 total_max_matches"),
    offset: z.coerce.number().int().min(0).optional().describe("分页偏移量（从 0 开始），默认 0"),
    max_matches_per_file: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("单文件结果数上限，用于限制单个文件的匹配数量"),
    fixed_strings: z
      .boolean()
      .optional()
      .describe("按字面量搜索而非正则表达式，用于搜索包含特殊字符的字符串"),
    multiline: z
      .boolean()
      .optional()
      .describe("启用多行匹配模式（rg --multiline），允许 pattern 跨行匹配"),
    // 向后兼容：total_max_matches 作为 head_limit 别名
    total_max_matches: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("已废弃，请使用 head_limit 代替"),
  }),
);

/** 默认 head_limit（与 CC 一致） */
const DEFAULT_HEAD_LIMIT = 250;

/** VCS 排除 glob 模式（覆盖 git、svn、hg、bzr、jj、sl 等） */
const VCS_EXCLUDE_GLOBS = ["!.git", "!.svn", "!.hg", "!.bzr", "!.jj", "!.sl"];

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
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = grepSchema();

  /**
   * P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths）。
   *
   * 只用 `path`（搜索根），**不解析 `pattern`** —— grep 的 pattern 是正则而非 glob，
   * 把 `src/\w+\.ts` 这类正则送进 glob 前缀提取会得到伪目录。
   * `glob` 字段（文件名过滤）同理不含目录信息，也不报。
   */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "path");
  }

  readOnly(): boolean {
    return true;
  }

  /** 并发安全：grep 是纯只读操作 */
  isConcurrencySafe(): boolean {
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
- 多个 glob 模式用空格分隔（如 '*.ts *.tsx'），花括号内的逗号不拆分（如 '*.{ts,tsx}'）
- head_limit 控制输出上限（默认 250），传 0 表示不限制
- offset 支持分页：如果首页没有想要的结果，用 offset 翻页
- 以 - 或 -- 开头的搜索模式（如 CSS 变量 --node-entity-bg）无需特殊处理，工具会自动正确搜索
- 使用 multiline=true 可以跨行匹配`;
  }

  inputSchema(): Record<string, unknown> {
    const schema = (this.zodSchema as any)._def?.schema;
    if (schema) {
      return z.toJSONSchema(schema) as Record<string, unknown>;
    }
    return z.toJSONSchema(this.zodSchema) as Record<string, unknown>;
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
      multiline?: boolean;
      total_max_matches?: number;
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    const searchPath = normalizeToolPath(params.path || ".");
    const mode = params.output_mode || "files_with_matches";
    const headLimit = params.head_limit ?? params.total_max_matches ?? DEFAULT_HEAD_LIMIT;
    const offset = params.offset ?? 0;

    // 路径存在性校验（对标 CC validateInput）
    if (!existsSync(searchPath)) {
      return {
        output: `错误: 路径不存在 "${searchPath}"。请确认路径正确，或使用默认当前目录（不传 path 参数）。`,
        isError: true,
      };
    }

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
        const result = await this.executeWithRipgrep(
          params,
          searchPath,
          mode,
          headLimit,
          offset,
          abortSignal,
        );
        log.info("TOOL", `✓ 搜索完成`);
        return result;
      }
      const result = await this.executeFallbackGrep(params, searchPath, mode, headLimit, offset);
      log.info("TOOL", `✓ 搜索完成`);
      return result;
    } catch (err: any) {
      if (err instanceof RipgrepTimeoutError) {
        if (err.partialResults.length > 0) {
          const { appliedLimit, pagedLines } = this.applyPagination(
            err.partialResults,
            mode,
            headLimit,
            offset,
          );
          const output = this.formatStructuredOutput(
            mode,
            pagedLines,
            searchPath,
            appliedLimit,
            offset,
            "搜索超时，以下为部分结果",
          );
          return { output };
        }
        return { output: err.message, isError: true };
      }
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }

  /** 使用 ripgrep 执行搜索 */
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
      multiline?: boolean;
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
        // 上下文行优先级（对齐 CC GrepTool）：context(-C) 优先于 -B/-A，三者互斥不叠加，
        // 避免同时下发 -C 与 -A/-B 给 ripgrep 造成行为未定义。
        if (params.context !== undefined) {
          args.push("-C", String(params.context));
        } else {
          if (params.before_context !== undefined) {
            args.push("-B", String(params.before_context));
          }
          if (params.after_context !== undefined) {
            args.push("-A", String(params.after_context));
          }
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

    // 多行模式：加 --multiline-dotall 让 `.` 跨行匹配（对齐 CC GrepTool 的 -U --multiline-dotall），
    // 否则含 `.` 的跨行 pattern（如 `foo.*bar` 跨行）在 --multiline 下仍匹配不到换行。
    if (params.multiline) {
      args.push("--multiline", "--multiline-dotall");
    }

    // 单文件匹配数限制
    if (params.max_matches_per_file !== undefined) {
      args.push("--max-count", String(params.max_matches_per_file));
    }

    // 文件过滤：glob 智能拆分（保留花括号内逗号，空格分隔多个模式）
    if (params.glob) {
      const globPatterns = this.splitGlobPatterns(params.glob);
      for (const globPattern of globPatterns) {
        args.push("--glob", globPattern);
      }
    }

    // 文件类型过滤：先归一别名、非法值降级为 glob，绝不把 unrecognized file type
    // 变成整次搜索失败（事故 20260801：type="tsx" → rg 退出码 2，搜索全废）。
    // 详见 grep-type-alias.ts 的立场说明。
    const resolvedType = resolveGrepType(params.type);
    if (resolvedType.rgType) {
      args.push("--type", resolvedType.rgType);
    }
    if (resolvedType.fallbackGlob) {
      args.push("--glob", resolvedType.fallbackGlob);
    }

    // Pattern 处理：以 - 开头的 pattern 用 -e 指定（对标 CC 做法，比 "--" 更精确）
    // -e 明确告诉 rg "下一个参数是 pattern"，无歧义
    if (params.pattern.startsWith("-")) {
      args.push("-e", params.pattern);
    } else {
      args.push("--", params.pattern);
    }

    const lines = await ripGrep(args, searchPath, abortSignal);

    // type 归一/降级的提示前置到输出里：模型必须知道"实际搜的范围与它写的不同"，
    // 否则会把降级后的宽结果当成精确结果，或把 0 命中误判成"确实不存在"。
    const typeNotice = resolvedType.notice ? `（提示）${resolvedType.notice}\n\n` : "";

    if (lines.length === 0) {
      return { output: `${typeNotice}未找到匹配的内容` };
    }

    // 按 mtime 排序（files_with_matches / count 模式）
    const sortedLines = this.sortLinesByMtime(lines, searchPath, mode);

    // 应用分页
    const { appliedLimit, pagedLines } = this.applyPagination(sortedLines, mode, headLimit, offset);

    const output = this.formatStructuredOutput(mode, pagedLines, searchPath, appliedLimit, offset);

    return { output: `${typeNotice}${output}` };
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

    // content 模式：匹配 rg 的 "file:line:content" 或 "file-line-context" 格式
    const match = line.match(/^(.+?)[:\-](\d+)[:\-]/);
    if (match) {
      return match[1];
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

    // 获取每个文件的 mtime（用 try/catch 防竞态：文件可能在 rg 扫描后被删除）
    const fileMtimes = new Map<string, number>();
    for (const filePath of fileLines.keys()) {
      try {
        const fullPath = resolve(searchPath, filePath);
        fileMtimes.set(filePath, statSync(fullPath).mtimeMs);
      } catch {
        fileMtimes.set(filePath, 0); // 无法获取 mtime 的排在最后
      }
    }

    // 按 mtime 降序排列文件，同 mtime 则按文件名字母序（保证结果稳定）
    const sortedFiles = [...fileLines.keys()].sort((a, b) => {
      const timeDiff = (fileMtimes.get(b) ?? 0) - (fileMtimes.get(a) ?? 0);
      if (timeDiff !== 0) return timeDiff;
      return a.localeCompare(b);
    });

    return sortedFiles.flatMap((file) => fileLines.get(file) ?? []);
  }

  /** 应用分页截断 */
  private applyPagination(
    lines: string[],
    _mode: string,
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

    // 只有真正截断了才报告 appliedLimit（对标 CC：避免无意义的 limit 信息）
    const wasTruncated = end < lines.length;
    return {
      appliedLimit: wasTruncated ? headLimit : undefined,
      pagedLines,
    };
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
    // 提取唯一文件名（转为相对路径）
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
    }

    // 计算匹配数
    let numMatches = lines.length;
    if (mode === "content") {
      // content 模式下：非上下文行（:行号: 格式）才算匹配
      numMatches = lines.filter((l) => !l.match(/^.+-\d+-/)).length;
    } else if (mode === "count") {
      // count 模式下：解析各文件的匹配数总和
      numMatches = 0;
      for (const line of lines) {
        const lastColon = line.lastIndexOf(":");
        if (lastColon > 0) {
          const count = parseInt(line.substring(lastColon + 1), 10);
          if (!isNaN(count)) numMatches += count;
        }
      }
    }

    // 构建结构化输出
    const structured: StructuredOutput = {
      mode: mode as StructuredOutput["mode"],
      numFiles: relativeFilenames.size,
      filenames: [...relativeFilenames],
      content: lines.join("\n"),
      numLines: lines.length,
      numMatches,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
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

  /**
   * 智能拆分 glob 模式（对标 CC）
   * - 空格分隔多个模式
   * - 花括号内的逗号不拆分（如 '*.{ts,tsx}' 是一个整体）
   */
  private splitGlobPatterns(glob: string): string[] {
    const patterns: string[] = [];
    const rawPatterns = glob.split(/\s+/);

    for (const rawPattern of rawPatterns) {
      if (!rawPattern) continue;
      // 包含花括号的模式不再按逗号拆分
      if (rawPattern.includes("{") && rawPattern.includes("}")) {
        patterns.push(rawPattern);
      } else {
        // 无花括号的模式按逗号拆分
        patterns.push(...rawPattern.split(",").filter(Boolean));
      }
    }

    return patterns;
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
      const patterns = this.splitGlobPatterns(params.glob);
      for (const p of patterns) {
        args.push("--include", p);
      }
    }

    // pattern 前加 "--" 防止以 - 开头的 pattern 被当作 flag
    args.push("--", params.pattern, searchPath);

    try {
      const { spawn } = await import("bun");
      const proc = spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });

      // 必须先 await proc.exited 再读 exitCode。Bun 的 proc.exitCode 是同步属性，
      // 进程未退出时返回 null——stdout/stderr 为空时 Response.text() 可能先于进程退出 resolve，
      // 导致 exitCode 读到 null 报出「退出码 null」假错误。
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode === 1 || stdout.trim() === "") {
        return { output: "未找到匹配的内容" };
      }

      if (exitCode !== 0 && exitCode !== 1) {
        return { output: `搜索失败: grep 退出码 ${exitCode}: ${stderr.trim()}`, isError: true };
      }

      const lines = stdout.trim().split("\n").filter(Boolean);

      const { appliedLimit, pagedLines } = this.applyPagination(lines, mode, headLimit, offset);
      const output = this.formatStructuredOutput(
        mode,
        pagedLines,
        searchPath,
        appliedLimit,
        offset,
      );
      return { output };
    } catch (err: any) {
      return { output: `搜索失败: ${err.message}`, isError: true };
    }
  }
}
