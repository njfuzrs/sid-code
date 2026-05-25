/**
 * JIT (Just-In-Time) 上下文管理器
 * 当工具访问文件时，自动发现并加载该路径上的 CLAUDE.md 上下文
 */

import { dirname, join, relative } from "path";
import { existsSync } from "fs";
import { getLogger } from "../debug/logger.ts";

/** CLAUDE.md 文件名候选列表 */
const CLAUDE_MD_FILES = [
  "CLAUDE.md",
  ".claude.md",
  "claude.md",
  ".claude/CLAUDE.md",
  ".claude/instructions.md",
] as const;

/**
 * JIT 上下文管理器
 *
 * 当工具（read/write/edit/grep/glob）访问文件时，
 * 检查该文件所在目录及其祖先目录是否有未加载的 CLAUDE.md。
 * 如果有，加载并追加到系统提示词中。
 *
 * 缓存已扫描的目录路径，避免重复扫描。
 */
export class JitContextManager {
  /** 已加载的 CLAUDE.md 文件路径集合 */
  private loadedFiles = new Set<string>();
  /** 已扫描的目录路径集合 */
  private scannedDirs = new Set<string>();

  /**
   * 根据工具访问的路径，发现新的上下文。
   * 返回新发现的上下文内容（如果有），否则返回 null。
   */
  async discoverContext(accessedPath: string, projectRoot: string): Promise<string | null> {
    const log = getLogger();

    // 评测隔离：SID_CODE_DISABLE_PROJECT_RULES=1 时禁用 JIT CLAUDE.md 发现
    // 否则 agent grep src/ 时仍可能触发同目录 CLAUDE.md 加载，泄露 case 锚点
    if (process.env.SID_CODE_DISABLE_PROJECT_RULES === "1") {
      return null;
    }

    // 获取文件所在目录
    let targetDir: string;
    try {
      const stat = await Bun.file(accessedPath).stat();
      targetDir = stat.isDirectory() ? accessedPath : dirname(accessedPath);
    } catch {
      // 文件不存在或无法访问，尝试作为目录处理
      targetDir = dirname(accessedPath);
    }

    // 规范化路径
    const normalizedDir = targetDir.toLowerCase();

    // 如果已经扫描过这个目录，跳过
    if (this.scannedDirs.has(normalizedDir)) {
      return null;
    }
    this.scannedDirs.add(normalizedDir);

    // 向上查找 CLAUDE.md，直到项目根目录
    const foundContexts: Array<{ path: string; content: string }> = [];
    let currentDir = targetDir;

    while (currentDir.startsWith(projectRoot)) {
      // 检查当前目录是否有 CLAUDE.md
      for (const filename of CLAUDE_MD_FILES) {
        const candidatePath = join(currentDir, filename);
        const normalizedPath = candidatePath.toLowerCase();

        if (existsSync(candidatePath) && !this.loadedFiles.has(normalizedPath)) {
          try {
            const content = await Bun.file(candidatePath).text();
            this.loadedFiles.add(normalizedPath);

            // 处理 @import 指令
            const { processImports } = await import("./import-processor.ts");
            const processedContent = await processImports(content, candidatePath, {
              allowedDirectories: [projectRoot],
            });

            foundContexts.push({
              path: candidatePath,
              content: processedContent,
            });

            log.info("JIT", `发现新上下文: ${candidatePath}`);
            break; // 找到一个就跳出内层循环
          } catch (err) {
            log.warn("JIT", `读取 CLAUDE.md 失败: ${candidatePath}`, err);
          }
        }
      }

      // 向上一级目录
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break; // 到达根目录
      currentDir = parentDir;
    }

    // 如果没有发现新上下文，返回 null
    if (foundContexts.length === 0) {
      return null;
    }

    // 格式化上下文内容
    const formattedContexts = foundContexts.map(({ path, content }) => {
      const relativePath = relative(projectRoot, path);
      return `--- 新发现的项目上下文 (${relativePath}) ---\n${content}\n--- 上下文结束 ---`;
    });

    return formattedContexts.join("\n\n");
  }

  /** 重置缓存（会话重启时调用） */
  reset(): void {
    this.loadedFiles.clear();
    this.scannedDirs.clear();
  }

  /** 获取已加载的文件数量（用于调试） */
  getLoadedCount(): number {
    return this.loadedFiles.size;
  }
}
