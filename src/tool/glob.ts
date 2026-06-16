/**
 * Glob 工具 - 文件名模式匹配
 * 对标 Claude Code：按修改时间降序排列，最近编辑的在前面
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { glob } from "glob";
import { statSync } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** Glob 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const globSchema = lazySchema(() =>
  z.object({
    pattern: z.string().describe("Glob 模式（如 '**/*.ts', 'src/**/*.js'）"),
    path: z.string().optional().describe("搜索的基础路径，默认为当前目录"),
    ignore: z.array(z.string()).optional().describe("要忽略的模式列表（如 ['node_modules/**', '.git/**']）"),
  }),
);

export class GlobTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = globSchema();

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
- 默认忽略 node_modules、.git、dist 目录
- 结果按修改时间排序，最近编辑的文件排在前面
- 搜索文件内容请用 grep 工具，glob 只按文件名匹配`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(globSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      pattern: string;
      path?: string;
      ignore?: string[];
    };

    if (!params.pattern) {
      return { output: "错误: 缺少 pattern 参数", isError: true };
    }

    log.info("TOOL", `▶ 匹配 "${params.pattern}" in ${params.path || "."}`);

    try {
      // 默认基于全局 cwd（"." 交给 normalizeToolPath 用 getCwd() 解析），跟随 bash 的 cd
      const cwd = normalizeToolPath(params.path || ".");
      const ignore = params.ignore || ["node_modules/**", ".git/**", "dist/**"];

      const files = await glob(params.pattern, {
        cwd,
        ignore,
        nodir: true,
      });

      if (files.length === 0) {
        return { output: "未找到匹配的文件" };
      }

      // 按修改时间降序排列（最近编辑的在前）
      const filesWithMtime = files.map(f => {
        const fullPath = join(cwd, f);
        try {
          const stat = statSync(fullPath);
          return { file: f, mtime: stat.mtimeMs };
        } catch {
          return { file: f, mtime: 0 };
        }
      });

      filesWithMtime.sort((a, b) => b.mtime - a.mtime);

      log.info("TOOL", `✓ 匹配完成 ${filesWithMtime.length}个文件`);

      return { output: filesWithMtime.map(f => f.file).join("\n") };
    } catch (err: any) {
      return { output: `文件匹配失败: ${err.message}`, isError: true };
    }
  }
}
