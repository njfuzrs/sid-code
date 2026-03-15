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
   */
  async scan(type: string, projectDir?: string): Promise<ParsedExtensionFile[]> {
    const cacheKey = `${type}:${projectDir ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.files;
    }

    const fileMap = new Map<string, ParsedExtensionFile>();

    // 1. 扫描用户目录 ~/.sid-code/{type}/
    const userDir = join(homedir(), ".sid-code", type);
    const userFiles = await this.scanDir(userDir, "user");
    for (const f of userFiles) {
      fileMap.set(f.name, f);
    }

    // 2. 扫描项目目录 {projectDir}/.sid-code/{type}/（后扫描覆盖先扫描）
    if (projectDir) {
      const projDir = join(projectDir, ".sid-code", type);
      const projFiles = await this.scanDir(projDir, "project");
      for (const f of projFiles) {
        fileMap.set(f.name, f);
      }
    }

    const files = Array.from(fileMap.values());

    // 更新缓存
    this.cache.set(cacheKey, { files, timestamp: Date.now() });

    return files;
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 扫描单个目录下的 .md 文件 */
  private async scanDir(dir: string, source: ExtensionSource): Promise<ParsedExtensionFile[]> {
    const log = getLogger();

    if (!existsSync(dir)) {
      return [];
    }

    const results: ParsedExtensionFile[] = [];

    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const filePath = join(dir, entry);
        const name = basename(entry, ".md");

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
          log.warn("EXTENSION", `读取扩展文件失败: ${filePath}`, { error: err.message });
        }
      }
    } catch (err: any) {
      log.warn("EXTENSION", `扫描目录失败: ${dir}`, { error: err.message });
    }

    return results;
  }
}
