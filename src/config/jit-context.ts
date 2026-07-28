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
   * §9.5：已加载的 JIT 上下文正文（path → 格式化后的块）。
   * JIT 上下文被追加到系统提示词；压缩后系统提示词重建会丢失这些追加内容。
   * 保留正文，供压缩后重新注入仍在作用域内的规则（类似 Skill 保留逻辑）。
   */
  private loadedContexts = new Map<string, string>();

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

    // 如果已经扫描过这个目录，跳过。
    //
    // 例外（配合下面的 paths 作用域判定）：本目录链上存在**因作用域未命中而跳过**的
    // CLAUDE.md 时，不能把该目录记为「已扫描」——否则同目录下换一个命中作用域的文件
    // （如先读 src/ui/README.md 未命中、再读 src/ui/Footer.tsx 命中）将永远拿不到规则。
    // 这类目录留待下次触达重新判定；只有「链上全部候选都已处理完」才登记为已扫描。
    if (this.scannedDirs.has(normalizedDir)) {
      return null;
    }
    /** 本次扫描是否遇到「因作用域未命中而跳过」的规则文件 */
    let hasScopeDeferred = false;

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
            const rawContent = await Bun.file(candidatePath).text();

            // frontmatter `paths:` 作用域判定（与主加载路径 loadAllCLAUDEmd 同语义）。
            //
            // 这是 paths 机制真正生效的地方：主加载路径在启动时没有「当前活动文件」，
            // 带 paths 的规则一律不注入；JIT 拿到的 accessedPath 才是确切的活动文件，
            // 用它判定作用域——命中才注入。这样 `paths: ["src/ui/**"]` 的 TUI 规范
            // 只在真正读写 src/ui 下文件时进入上下文，在 website/ 里做文档任务时不会出现。
            //
            // 注意 body：注入的是剥离 frontmatter 后的正文，避免把 `paths:` 元数据喂给模型。
            const { parseRulesFrontmatter, rulesPathsMatch } = await import("./rules.ts");
            const { paths, body } = parseRulesFrontmatter(rawContent);
            if (paths && paths.length > 0) {
              // activeFiles 用相对项目根的路径（与 CLAUDE.md 里 glob 的书写基准一致）
              const activeFile = relative(projectRoot, accessedPath);
              if (!rulesPathsMatch(paths, [activeFile])) {
                log.debug(
                  "JIT",
                  `作用域不匹配，跳过: ${candidatePath} (paths=${JSON.stringify(paths)}, file=${activeFile})`,
                );
                // 不加入 loadedFiles：换个文件再触达时需要重新判定作用域。
                // 同时标记本目录不可登记为「已扫描」，否则同目录下后续命中的文件拿不到规则。
                hasScopeDeferred = true;
                break;
              }
            }
            const content = body;
            this.loadedFiles.add(normalizedPath);

            // 处理 @import 指令
            const { processImports } = await import("./import-processor.ts");
            // M4：JIT 子目录 CLAUDE.md 的 allowedDirectories 仅限项目根，外部导入天然不可达；
            // 仍显式传 projectRoot + 批准位以对齐主加载路径的语义。
            let externalApproved = false;
            try {
              const { getClaudeMdExternalImportsApproved } = await import("./app-config.ts");
              externalApproved = getClaudeMdExternalImportsApproved(projectRoot) === true;
            } catch { /* 保守按未批准 */ }
            const { recordSkippedExternalImport } = await import("./rules.ts");
            const processedContent = await processImports(content, candidatePath, {
              allowedDirectories: [projectRoot],
              projectRoot,
              externalApproved,
              onExternalSkipped: (p) => recordSkippedExternalImport(p),
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

    // 目录级扫描缓存登记：仅当本次没有「因作用域未命中而跳过」的规则时才登记。
    // 有跳过项则保持未登记，让同目录下后续访问的文件有机会重新判定作用域并拿到规则。
    if (!hasScopeDeferred) {
      this.scannedDirs.add(normalizedDir);
    }

    // 如果没有发现新上下文，返回 null
    if (foundContexts.length === 0) {
      return null;
    }

    // 格式化上下文内容
    const formattedContexts = foundContexts.map(({ path, content }) => {
      const relativePath = relative(projectRoot, path);
      const formatted = `--- 新发现的项目上下文 (${relativePath}) ---\n${content}\n--- 上下文结束 ---`;
      // §9.5：保留正文，供压缩后重新注入
      this.loadedContexts.set(path.toLowerCase(), formatted);
      return formatted;
    });

    return formattedContexts.join("\n\n");
  }

  /**
   * §9.5：返回所有已加载 JIT 上下文的合并正文（压缩后重新注入用）。
   * 无已加载上下文返回 null。
   */
  getLoadedContexts(): string | null {
    if (this.loadedContexts.size === 0) return null;
    return Array.from(this.loadedContexts.values()).join("\n\n");
  }

  /** 重置缓存（会话重启时调用） */
  reset(): void {
    this.loadedFiles.clear();
    this.scannedDirs.clear();
    this.loadedContexts.clear();
  }

  /**
   * 预填充已加载的 CLAUDE.md 路径（避免 JIT 重复发现首轮已注入的文件）。
   * app 初始化时调用：把 loadAllCLAUDEmd 已加载的文件路径标记为"已处理"，
   * 后续 discoverContext 向上查找时遇到这些文件会跳过。
   */
  markLoaded(filePaths: string[]): void {
    for (const p of filePaths) {
      this.loadedFiles.add(p.toLowerCase());
    }
  }

  /** 获取已加载的文件数量（用于调试） */
  getLoadedCount(): number {
    return this.loadedFiles.size;
  }
}
