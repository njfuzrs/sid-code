/**
 * Glob 工具 - 文件名模式匹配
 * 基于 ripgrep 构建（--files --glob），按修改时间**降序**排列，最近编辑的在前面。
 *
 * ⚠️ 排序方向刻意偏离 CC：CC 用 `--sort=modified`（oldest-first），本工具用 `--sortr=modified`
 * （newest-first）。对 agent 而言"最近改过的文件优先"更实用（通常正是当前任务相关文件），
 * 故有意保留此差异，非 bug。参见 P2-6 审计结论。
 *
 * 架构说明（2026-07 重写 + 复审补全）：
 * 旧实现用纯 JS `glob` 库，存在多个缺口，现全部修复：
 *   1. execute(input) 丢弃 executor 传入的 abortSignal → 大目录/网络盘可 hang 死主循环
 *   2. 无结果上限 → `**\/*` 一次性回灌数千文件撑爆 context
 *   3. 路径不存在与真无匹配返回相同反馈 → 模型猜错目录后无法自纠（轨迹实证 32% 软失败率）
 *   4. 默认漏隐藏文件（glob 库 dot:false）
 *   5. 用户 ignore 覆盖默认保护
 *   6. 绝对路径 pattern（如 /abs/**\/*.ts）rg 路径静默返回"未找到"（rg --glob 锚定 cwd 非绝对）
 *   7. fallback（glob 库）不接 signal → 无 rg 时仍可 hang
 *   8. gitignore 行为：rg 默认尊重 .gitignore（吞 build/*.log），与 CC 默认 --no-ignore 相悖，
 *      且与 fallback（glob 库不读 gitignore）行为不一致
 * 现改用与 grep 工具同源的 ripGrep() 封装（超时 20s + 两级终止 + EAGAIN 重试 + abort + 20MB 缓冲），
 * 系统无 ripgrep 时回退到 glob 库（行为对齐：同样接 signal、同样不读 gitignore）。
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { glob } from "glob";
import { statSync } from "fs";
import { join, isAbsolute, sep } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { searchToolPaths } from "./jit-affected-paths.ts";
import { ripGrep, hasRipgrep, RipgrepTimeoutError } from "./ripgrep.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 结果上限（对标 CC globLimits.maxResults ?? 100）——超过则截断并提示 */
const DEFAULT_RESULT_LIMIT = 100;

/** 默认忽略模式（无论用户是否传 ignore 都始终生效，防止误删保护） */
const DEFAULT_IGNORES = ["node_modules/**", ".git/**", "dist/**"];

/** 环境变量布尔解析（默认 true；"false"/"0" 关闭） */
function envBool(name: string, dflt = true): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const v = raw.toLowerCase();
  return v !== "false" && v !== "0";
}

/** 是否包含隐藏文件（默认 true，对标 CC CLAUDE_CODE_GLOB_HIDDEN；SID_GLOB_HIDDEN=false 关闭） */
function includeHidden(): boolean {
  return envBool("SID_GLOB_HIDDEN", true);
}

/**
 * 是否忽略 .gitignore（默认 true，对标 CC CLAUDE_CODE_GLOB_NO_IGNORE=true）。
 * 默认 true → glob 能找到被 gitignore 的文件（如 dist/build/*.log），与用户直觉一致；
 * SID_GLOB_NO_IGNORE=false 时尊重 .gitignore。
 */
function noIgnore(): boolean {
  return envBool("SID_GLOB_NO_IGNORE", true);
}

/**
 * 从绝对路径 glob 提取静态基目录与相对模式（对标 CC extractGlobBaseDirectory）。
 * rg 的 --glob 锚定进程 cwd 而非绝对 pattern，故绝对 pattern 必须拆成
 * { baseDir(当搜索根), relativePattern(当 glob) }。
 *
 * 例：/a/b/src/**\/*.ts → { baseDir: '/a/b/src', relativePattern: '**\/*.ts' }
 *     /a/b/file.ts（无通配）→ { baseDir: '/a/b', relativePattern: 'file.ts' }
 *
 * 导出原因（P2-9 / §8.9-2）：JIT 上下文发现需要同一套「pattern 的静态前缀是哪个目录」
 * 判定 —— `glob("src/ui/**\/*.tsx")` 不带 `path` 参数时，若不提取前缀就只能退化成
 * 项目根，`src/ui` 的规范拿不到。复用此函数而非重写，避免两套算法漂移。
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string;
  relativePattern: string;
} {
  const globChars = /[*?[{]/;
  const match = pattern.match(globChars);

  if (!match || match.index === undefined) {
    // 无通配符 = 字面路径：拆成 dir + basename
    const lastSep = pattern.lastIndexOf("/");
    if (lastSep === -1) return { baseDir: "", relativePattern: pattern };
    const baseDir = lastSep === 0 ? "/" : pattern.slice(0, lastSep);
    return { baseDir, relativePattern: pattern.slice(lastSep + 1) };
  }

  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(staticPrefix.lastIndexOf("/"), staticPrefix.lastIndexOf(sep));
  if (lastSepIndex === -1) {
    // 通配符前无分隔符 → pattern 相对 cwd
    return { baseDir: "", relativePattern: pattern };
  }
  const baseDir = lastSepIndex === 0 ? "/" : pattern.slice(0, lastSepIndex);
  return { baseDir, relativePattern: pattern.slice(lastSepIndex + 1) };
}

/** Glob 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const globSchema = lazySchema(() =>
  z.object({
    pattern: z.string().describe("Glob 模式（如 '**/*.ts', 'src/**/*.js'）"),
    path: z
      .string()
      .optional()
      .describe("搜索的基础路径，默认为当前目录。省略即用默认目录，不要传 'undefined'/'null'"),
    ignore: z
      .array(z.string())
      .optional()
      .describe("额外忽略的模式列表（会与默认的 node_modules/.git/dist 叠加，不会覆盖）"),
  }),
);

export class GlobTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = globSchema();

  /**
   * P2-9 / §8.9-2：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths）。
   *
   * 关键是 pattern 里的静态前缀也要报：`glob("src/ui/**\/*.tsx")` 不带 `path` 时，
   * 只看 `path` 会退化成项目根，`src/ui` 的规范一份拿不到。走
   * `searchToolPaths` → `extractGlobBaseDirectory`（glob 自身用的同一函数）。
   */
  jitAffectedPaths(input: unknown): string[] {
    return searchToolPaths(input, "pattern");
  }

  /**
   * G21：可选的"路径隐藏"判定回调（给定绝对路径 → 是否被权限 deny 规则命中）。
   * 命中的路径从列举结果剔除，对齐 claude-code「deny 文件不出现在 glob 列表」。
   * 未注入时行为完全不变（向后兼容）。
   */
  private isPathHidden?: (absPath: string) => boolean;

  constructor(isPathHidden?: (absPath: string) => boolean) {
    this.isPathHidden = isPathHidden;
  }

  /** G21：运行时注入/更新路径隐藏判定（构造时权限检查器尚未创建，故支持后置注入）。 */
  setPathHiddenFilter(fn: (absPath: string) => boolean): void {
    this.isPathHidden = fn;
  }

  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "glob";
  }

  description(): string {
    return "使用 glob 模式查找文件。结果按修改时间降序排列（最近编辑的在前）。支持通配符如 **/*.ts";
  }

  usageGuide(): string {
    return `- 使用 glob 而不是 bash find/ls 来查找文件
- 支持通配符：* 匹配文件名，** 匹配任意层级目录
- 默认忽略 node_modules、.git、dist 目录（传 ignore 只会追加，不会覆盖这些默认保护）
- 结果按修改时间排序，最近编辑的文件排在前面，最多返回 ${DEFAULT_RESULT_LIMIT} 个（超出会提示收窄）
- 搜索文件内容请用 grep 工具，glob 只按文件名匹配`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(globSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      pattern?: string;
      path?: string;
      ignore?: string[];
    };

    if (!params.pattern || typeof params.pattern !== "string" || params.pattern.trim() === "") {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    log.info("TOOL", `▶ 匹配 "${params.pattern}" in ${params.path || "."}`);

    // 缺口#6：绝对路径 pattern → 拆出 baseDir 当搜索根 + 相对 pattern（对标 CC）。
    // 必须在 path 校验之前完成：绝对 pattern 优先级高于 path（与 CC 一致）。
    let effectivePattern = params.pattern;
    let searchRoot: string;
    if (isAbsolute(params.pattern)) {
      const { baseDir, relativePattern } = extractGlobBaseDirectory(params.pattern);
      searchRoot = baseDir ? normalizeToolPath(baseDir) : normalizeToolPath(params.path || ".");
      effectivePattern = relativePattern;
    } else {
      // 默认基于全局 cwd（"." 交给 normalizeToolPath 用 getCwd() 解析），跟随 bash 的 cd
      searchRoot = normalizeToolPath(params.path || ".");
    }

    // 缺口#3：搜索根目录必须存在，把"路径不存在"和"真无匹配"区分开。
    // 复用 formatPathNotFoundError 给出相似文件建议，帮助模型自纠（避免猜错目录反复重试）。
    // path 显式提供、或绝对 pattern 提取出了 baseDir 时都校验。
    const shouldValidate = !!params.path || isAbsolute(params.pattern);
    if (shouldValidate) {
      try {
        const st = statSync(searchRoot);
        if (!st.isDirectory()) {
          return { output: `错误: 搜索路径不是目录: ${searchRoot}`, isError: true };
        }
      } catch {
        return { output: formatPathNotFoundError(searchRoot), isError: true };
      }
    }

    // 构建 abort signal（缺口#1：接住 executor 传入的 signal，不再丢弃）
    const abortController = new AbortController();
    const abortSignal = signal ?? abortController.signal;
    if (signal) {
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    const extraIgnores = params.ignore ?? [];
    // 缺口#5：默认保护始终生效，用户 ignore 叠加而非覆盖
    const allIgnores = [...DEFAULT_IGNORES, ...extraIgnores];

    try {
      const useRipgrep = await hasRipgrep();
      const { files, truncated } = useRipgrep
        ? await this.matchWithRipgrep(effectivePattern, searchRoot, allIgnores, abortSignal)
        : await this.matchWithGlobLib(effectivePattern, searchRoot, allIgnores, abortSignal);

      if (files.length === 0) {
        return { output: "未找到匹配的文件" };
      }

      log.info("TOOL", `✓ 匹配完成 ${files.length}个文件${truncated ? "（已截断）" : ""}`);

      let output = files.join("\n");
      if (truncated) {
        output += `\n\n（结果已截断至 ${DEFAULT_RESULT_LIMIT} 个。请指定更具体的 path 或 pattern 收窄搜索。）`;
      }
      return { output };
    } catch (err: any) {
      if (err instanceof RipgrepTimeoutError) {
        // 超时且有部分结果 → 返回部分结果 + 提示
        if (err.partialResults.length > 0) {
          const rel = err.partialResults
            .slice(0, DEFAULT_RESULT_LIMIT)
            .map((p) => (p.startsWith("./") ? p.slice(2) : p));
          return {
            output: `${rel.join("\n")}\n\n（搜索超时，以上为部分结果。请收窄 pattern/path。）`,
          };
        }
        return { output: err.message, isError: true };
      }
      // abort（用户 ESC / 超时上游取消）→ 明确文案，不伪装成错误
      if (abortSignal.aborted || err?.name === "AbortError") {
        return { output: "文件匹配已取消" };
      }
      return { output: `文件匹配失败: ${err.message}`, isError: true };
    }
  }

  /**
   * ripgrep 实现：rg --files --glob <pattern> --sortr=modified
   * --files: 只列文件名不搜内容；--sortr=modified: 按修改时间降序（newest first，与旧实现一致）；
   * --hidden: 含隐藏文件（缺口#4）；--no-ignore: 不吞 gitignore 文件（缺口#8，对标 CC）；
   * 每个 ignore 转 --glob !<pat>。
   *
   * 关键：rg 的 --glob 模式锚定到进程 cwd（而非 target 位置参数），因此把搜索目录作为
   * spawn cwd、target 传 "."，才能让相对 glob 正确匹配（否则绝对 target 下 exit=1 无结果）。
   * 输出因此天然是相对路径。
   */
  private async matchWithRipgrep(
    pattern: string,
    cwd: string,
    ignores: string[],
    abortSignal: AbortSignal,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const args = ["--files", "--glob", pattern, "--sortr=modified"];
    if (includeHidden()) args.push("--hidden");
    if (noIgnore()) args.push("--no-ignore");
    // 排除模式统一补 **/ 前缀，保证任意深度匹配（`!node_modules/**` 只排根级，
    // `!**/node_modules/**` 才能全深度排除）。
    for (const ig of ignores) {
      const norm = ig.startsWith("**/") || ig.startsWith("/") ? ig : `**/${ig}`;
      args.push("--glob", `!${norm}`);
    }

    // 搜索目录作 spawn cwd，target 传 "."（见上方注释）
    const lines = await ripGrep(args, ".", abortSignal, cwd);
    // rg 输出形如 "./src/a.ts"，去掉 "./" 前缀
    let rel = lines.map((p) => (p.startsWith("./") ? p.slice(2) : p));
    // G21：deny 规则隐藏——在截断之前过滤，避免被隐藏项占用结果配额
    rel = this.filterHidden(rel, cwd);
    // 截断到上限
    const truncated = rel.length > DEFAULT_RESULT_LIMIT;
    const files = rel.slice(0, DEFAULT_RESULT_LIMIT);
    return { files, truncated };
  }

  /**
   * G21：按注入的 isPathHidden 回调过滤掉被 deny 规则命中的路径。
   * files 为相对 cwd 的路径，join(cwd, f) 还原绝对路径再判定。
   * 未注入回调时原样返回（零开销、行为不变）。
   */
  private filterHidden(files: string[], cwd: string): string[] {
    if (!this.isPathHidden) return files;
    const fn = this.isPathHidden;
    return files.filter((f) => {
      try {
        return !fn(join(cwd, f));
      } catch {
        // 判定异常绝不吞结果：保守保留该项（宁可多显示也不因过滤器 bug 丢文件）
        return true;
      }
    });
  }

  /**
   * glob 库 fallback（系统无 ripgrep 时）：行为与 rg 路径对齐——
   * 含隐藏文件靠 dot 开关；接 signal（缺口#7）；glob 库本就不读 .gitignore，
   * 与 rg 的 --no-ignore 默认行为天然一致（缺口#8）。
   */
  private async matchWithGlobLib(
    pattern: string,
    cwd: string,
    ignores: string[],
    abortSignal: AbortSignal,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const raw = await glob(pattern, {
      cwd,
      ignore: ignores,
      nodir: true,
      dot: includeHidden(),
      signal: abortSignal, // 缺口#7：接 signal，abort 时 glob 库抛 AbortError
    });

    // 按修改时间降序排列（最近编辑的在前）
    const withMtime = raw.map((f) => {
      try {
        return { file: f, mtime: statSync(join(cwd, f)).mtimeMs };
      } catch {
        return { file: f, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    // G21：deny 规则隐藏——在截断之前过滤（同 ripgrep 路径）
    const visible = this.filterHidden(
      withMtime.map((f) => f.file),
      cwd,
    );
    const truncated = visible.length > DEFAULT_RESULT_LIMIT;
    const files = visible.slice(0, DEFAULT_RESULT_LIMIT);
    return { files, truncated };
  }
}
