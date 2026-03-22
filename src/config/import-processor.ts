/**
 * CLAUDE.md @import 处理模块
 * 支持通过 @path/to/file 语法导入其他文件
 */

import { existsSync } from "fs";
import { resolve, dirname, join, relative } from "path";
import { getLogger } from "../debug/logger.ts";

export interface ImportOptions {
  /** 最大导入深度，防止循环，默认 5 */
  maxDepth?: number;
  /** 允许导入的目录范围（安全限制） */
  allowedDirectories?: string[];
}

/**
 * 处理 CLAUDE.md 内容中的 @import 指令。
 *
 * 语法：行首 @path/to/file.md（相对于当前文件所在目录）
 *
 * 安全措施：
 * - 循环导入检测（Set 记录已处理文件）
 * - 深度限制（默认 5 层）
 * - 路径遍历防护（不允许 .. 跳出项目根）
 * - 只允许导入 .md 文件
 */
export async function processImports(
  content: string,
  filePath: string,
  options: ImportOptions = {}
): Promise<string> {
  const log = getLogger();
  const maxDepth = options.maxDepth ?? 5;
  const allowedDirs = options.allowedDirectories || [];
  const visited = new Set<string>();

  async function processRecursive(
    text: string,
    currentFile: string,
    depth: number
  ): Promise<string> {
    // 深度限制
    if (depth > maxDepth) {
      log.warn("IMPORT", `达到最大导入深度 ${maxDepth}，停止处理: ${currentFile}`);
      return text;
    }

    // 循环导入检测
    const normalizedPath = resolve(currentFile);
    if (visited.has(normalizedPath)) {
      log.warn("IMPORT", `检测到循环导入: ${currentFile}`);
      return text;
    }
    visited.add(normalizedPath);

    const lines = text.split("\n");
    const result: string[] = [];

    for (const line of lines) {
      // 匹配 @import 指令（行首）
      const match = line.match(/^@(.+\.md)\s*$/);
      if (!match) {
        result.push(line);
        continue;
      }

      const importPath = match[1].trim();
      const currentDir = dirname(currentFile);
      const absolutePath = resolve(currentDir, importPath);

      // 安全检查：只允许 .md 文件
      if (!absolutePath.endsWith(".md")) {
        log.warn("IMPORT", `只允许导入 .md 文件: ${importPath}`);
        result.push(line); // 保留原行
        continue;
      }

      // 安全检查：路径遍历防护
      if (allowedDirs.length > 0) {
        const isAllowed = allowedDirs.some(dir => {
          const allowedPath = resolve(dir);
          return absolutePath.startsWith(allowedPath);
        });
        if (!isAllowed) {
          log.warn("IMPORT", `导入路径不在允许的目录范围内: ${importPath}`);
          result.push(line);
          continue;
        }
      }

      // 检查文件是否存在
      if (!existsSync(absolutePath)) {
        log.warn("IMPORT", `导入文件不存在: ${absolutePath}`);
        result.push(line);
        continue;
      }

      // 检查循环导入（在读取文件前检查）
      const normalizedImportPath = resolve(absolutePath);
      if (visited.has(normalizedImportPath)) {
        log.warn("IMPORT", `检测到循环导入: ${importPath}`);
        result.push(line); // 保留原行
        continue;
      }

      // 检查深度限制（在读取文件前检查）
      if (depth + 1 > maxDepth) {
        log.warn("IMPORT", `达到最大导入深度 ${maxDepth}，跳过: ${importPath}`);
        result.push(line); // 保留原行
        continue;
      }

      // 读取并递归处理导入的文件
      try {
        const importedContent = await Bun.file(absolutePath).text();
        const processedContent = await processRecursive(
          importedContent,
          absolutePath,
          depth + 1
        );

        // 添加导入标记（方便调试）
        result.push(`<!-- @import ${importPath} -->`);
        result.push(processedContent);
        result.push(`<!-- end @import ${importPath} -->`);

        log.debug("IMPORT", `成功导入: ${importPath} (深度 ${depth})`);
      } catch (err) {
        log.warn("IMPORT", `读取导入文件失败: ${absolutePath}`, err);
        result.push(line);
      }
    }

    return result.join("\n");
  }

  return processRecursive(content, filePath, 0);
}
