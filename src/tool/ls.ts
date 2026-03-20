/**
 * Ls 工具 - 列举目录内容
 * 列举指定目录的直接子项（非递归），目录优先，显示文件大小
 */

import type { Tool, ToolResult } from "./types.ts";
import { readdirSync, statSync } from "fs";
import { join, isAbsolute } from "path";
import { getLogger } from "../debug/logger.ts";

/** 默认忽略的文件/目录名 */
const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", ".DS_Store"]);

/** 将字节数格式化为人类可读的大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 检查文件名是否匹配 ignore 模式（支持简单 glob：* 通配符） */
function matchesIgnorePattern(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      if (new RegExp(`^${regexStr}$`).test(name)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

export class LsTool implements Tool {
  readOnly(): boolean {
    return true;
  }

  name(): string {
    return "ls";
  }

  description(): string {
    return "列举目录的直接子项（非递归）。目录优先，同类按字母升序，显示文件大小。";
  }

  usageGuide(): string {
    return `- 使用 ls 而不是 bash ls/find 来查看目录内容
- 只列举直接子项，不递归；递归查找请用 glob 工具
- 默认忽略 node_modules、.git、dist、.DS_Store
- dir_path 必须是绝对路径`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        dir_path: {
          type: "string",
          description: "要列举的目录的绝对路径",
        },
        ignore: {
          type: "array",
          items: { type: "string" },
          description: "额外忽略的文件名模式（支持 * 通配符，如 ['*.log', 'tmp']）",
        },
      },
      required: ["dir_path"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { dir_path: string; ignore?: string[] };

    if (!params.dir_path) {
      return { output: "错误: 缺少 dir_path 参数", isError: true };
    }

    if (!isAbsolute(params.dir_path)) {
      return { output: "错误: dir_path 必须是绝对路径", isError: true };
    }

    log.info("TOOL", `▶ 列举目录 ${params.dir_path}`);

    try {
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(params.dir_path);
      } catch {
        return { output: `错误: 路径不存在: ${params.dir_path}`, isError: true };
      }

      if (!stat.isDirectory()) {
        return { output: `错误: 路径不是目录: ${params.dir_path}`, isError: true };
      }

      const entries = readdirSync(params.dir_path);
      const extraIgnore = params.ignore ?? [];

      const items: Array<{ name: string; isDir: boolean; size: number }> = [];

      for (const name of entries) {
        // 默认忽略
        if (DEFAULT_IGNORE.has(name)) continue;
        // 用户自定义忽略
        if (extraIgnore.length > 0 && matchesIgnorePattern(name, extraIgnore)) continue;

        const fullPath = join(params.dir_path, name);
        try {
          const s = statSync(fullPath);
          items.push({ name, isDir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size });
        } catch {
          // 无法 stat 的条目跳过
        }
      }

      if (items.length === 0) {
        return { output: `目录为空: ${params.dir_path}` };
      }

      // 目录优先，同类按字母升序
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const lines: string[] = [`目录列表：${params.dir_path}`, ""];
      let dirCount = 0;
      let fileCount = 0;

      for (const item of items) {
        if (item.isDir) {
          lines.push(`[目录] ${item.name}/`);
          dirCount++;
        } else {
          lines.push(`${item.name} (${formatSize(item.size)})`);
          fileCount++;
        }
      }

      lines.push("");
      const summary = `共 ${items.length} 项（${dirCount} 个目录，${fileCount} 个文件）`;
      lines.push(summary);

      log.info("TOOL", `✓ 列举完成 ${dirCount}目录 ${fileCount}文件`);

      return { output: lines.join("\n") };
    } catch (err: any) {
      return { output: `列举目录失败: ${err.message}`, isError: true };
    }
  }
}
