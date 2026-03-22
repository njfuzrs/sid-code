/**
 * 扩展文件加载器
 * 扫描 ~/.sid-code/{type}/ 和 {projectDir}/.sid-code/{type}/ 下的 .md 文件
 * 5 分钟 TTL 缓存，project 覆盖 user
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { parseFrontmatter } from "./frontmatter.ts";
import { getLogger } from "../debug/logger.ts";
import type { ExtensionSource, ParsedExtensionFile } from "./types.ts";

/** 缓存条目 */
interface CacheEntry {
  files: ParsedExtensionFile[];
  errors: string[];
  timestamp: number;
}

/** 缓存 TTL（5 分钟） */
const CACHE_TTL = 5 * 60 * 1000;

export class ExtensionLoader {
  private cache = new Map<string, CacheEntry>();

  /**
   * 扫描指定类型的扩展文件
   * @param type 扩展类型目录名（commands/skills/agents）
   * @param projectDir 项目目录（可选）
   * @returns 解析后的文件列表和错误列表
   */
  async scan(type: string, projectDir?: string): Promise<ParsedExtensionFile[]> {
    const cacheKey = `${type}:${projectDir ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.files;
    }

    const fileMap = new Map<string, ParsedExtensionFile>();
    const errors: string[] = [];

    // 1. 扫描用户目录 ~/.sid-code/{type}/
    const userDir = join(homedir(), ".sid-code", type);
    const { files: userFiles, errors: userErrors } = await this.scanDir(userDir, "user");
    for (const f of userFiles) {
      fileMap.set(f.name, f);
    }
    errors.push(...userErrors);

    // 2. 扫描项目目录 {projectDir}/.sid-code/{type}/（后扫描覆盖先扫描）
    if (projectDir) {
      const projDir = join(projectDir, ".sid-code", type);
      const { files: projFiles, errors: projErrors } = await this.scanDir(projDir, "project");
      for (const f of projFiles) {
        fileMap.set(f.name, f);
      }
      errors.push(...projErrors);
    }

    const files = Array.from(fileMap.values());

    // 更新缓存
    this.cache.set(cacheKey, { files, errors, timestamp: Date.now() });

    // 如果有错误，记录日志
    if (errors.length > 0) {
      const log = getLogger();
      log.warn("EXTENSION", `加载 ${type} 时发现 ${errors.length} 个错误`);
      for (const error of errors) {
        log.debug("EXTENSION", error);
      }
    }

    return files;
  }

  /**
   * 获取最近一次扫描的错误列表
   */
  getErrors(type: string, projectDir?: string): string[] {
    const cacheKey = `${type}:${projectDir ?? ""}`;
    const cached = this.cache.get(cacheKey);
    return cached?.errors ?? [];
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 扫描单个目录下的 .md 文件和子目录中的 SKILL.md */
  private async scanDir(dir: string, source: ExtensionSource): Promise<{ files: ParsedExtensionFile[]; errors: string[] }> {
    const log = getLogger();
    const results: ParsedExtensionFile[] = [];
    const errors: string[] = [];

    if (!existsSync(dir)) {
      return { files: results, errors };
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // 忽略 _ 开头的文件/目录（草稿）
        if (entry.name.startsWith("_")) continue;

        if (entry.isFile() && entry.name.endsWith(".md")) {
          // 扁平文件模式：xxx.md
          const filePath = join(dir, entry.name);
          const name = basename(entry.name, ".md");

          try {
            const rawContent = await readFile(filePath, "utf-8");
            const { frontmatter, body } = parseFrontmatter(rawContent);

            results.push({
              name,
              filePath,
              source,
              rawContent,
              frontmatter,
              body,
            });
          } catch (err: any) {
            const errorMsg = `读取扩展文件失败: ${filePath} - ${err.message}`;
            errors.push(errorMsg);
            log.warn("EXTENSION", errorMsg);
          }
        } else if (entry.isDirectory()) {
          // 子目录模式：xxx/SKILL.md（仅支持 skills 类型）
          const skillMdPath = join(dir, entry.name, "SKILL.md");
          if (existsSync(skillMdPath)) {
            const name = entry.name;

            try {
              const rawContent = await readFile(skillMdPath, "utf-8");
              const { frontmatter, body } = parseFrontmatter(rawContent);

              results.push({
                name,
                filePath: skillMdPath,
                source,
                rawContent,
                frontmatter,
                body,
              });
            } catch (err: any) {
              const errorMsg = `读取扩展文件失败: ${skillMdPath} - ${err.message}`;
              errors.push(errorMsg);
              log.warn("EXTENSION", errorMsg);
            }
          }
        }
      }
    } catch (err: any) {
      const errorMsg = `扫描目录失败: ${dir} - ${err.message}`;
      errors.push(errorMsg);
      log.warn("EXTENSION", errorMsg);
    }

    return { files: results, errors };
  }
}
