/**
 * 扩展文件加载器
 * 扫描 ~/.sid-code/{type}/ 和 {projectDir}/.sid-code/{type}/ 下的 .md 文件
 * 5 分钟 TTL 缓存，project 覆盖 user
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { parseFrontmatter } from "./frontmatter.ts";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import type {
  ExtensionSource,
  ParsedExtensionFile,
  ScanOptions,
  ScanResult,
  ExtensionLoadError,
  ExtensionOverride,
} from "./types.ts";

/** 缓存条目 */
interface CacheEntry {
  result: ScanResult;
  timestamp: number;
}

/** 缓存 TTL（5 分钟） */
const CACHE_TTL = 5 * 60 * 1000;

export class ExtensionLoader {
  private cache = new Map<string, CacheEntry>();

  /**
   * 扫描指定类型的扩展文件（向后兼容方法）
   * @param type 扩展类型目录名（commands/skills/agents）
   * @param projectDir 项目目录（可选）
   * @param options 扫描选项（可选）
   * @returns 解析后的文件列表
   */
  async scan(type: string, projectDir?: string, options?: ScanOptions): Promise<ParsedExtensionFile[]> {
    const result = await this.scanWithResult(type, projectDir, options);
    return result.files;
  }

  /**
   * 扫描指定类型的扩展文件（增强版，返回完整结果）
   * @param type 扩展类型目录名（commands/skills/agents）
   * @param projectDir 项目目录（可选）
   * @param options 扫描选项
   * @returns 扫描结果（含文件、错误、覆盖信息）
   */
  async scanWithResult(type: string, projectDir?: string, options?: ScanOptions): Promise<ScanResult> {
    const cacheKey = `${type}:${projectDir ?? ""}:${JSON.stringify(options ?? {})}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.result;
    }

    const fileMap = new Map<string, ParsedExtensionFile>();
    const errors: ExtensionLoadError[] = [];
    const overrides: ExtensionOverride[] = [];

    // 0. 扫描 builtin 目录（最低优先级）
    if (options?.builtinDir) {
      const { files: builtinFiles, errors: builtinErrors } = await this.scanDir(
        options.builtinDir,
        "builtin",
      );
      for (const f of builtinFiles) {
        fileMap.set(f.name, f);
      }
      errors.push(...builtinErrors);
    }

    // 1. 扫描用户目录 ~/.sid-code/{type}/
    const userDir = sidPaths.extensionDir(type);
    const { files: userFiles, errors: userErrors } = await this.scanDir(userDir, "user");
    for (const f of userFiles) {
      const existing = fileMap.get(f.name);
      if (existing) {
        overrides.push({
          name: f.name,
          overriddenPath: existing.filePath,
          overriddenSource: existing.source,
          overridingPath: f.filePath,
          overridingSource: f.source,
        });
      }
      fileMap.set(f.name, f);
    }
    errors.push(...userErrors);

    // 2. 扫描项目目录 {projectDir}/.sid-code/{type}/（后扫描覆盖先扫描）
    if (projectDir) {
      const projDir = join(projectDir, ".sid-code", type);
      const { files: projFiles, errors: projErrors } = await this.scanDir(projDir, "project");

      // 项目级文件需要信任检查
      let trustedProjFiles = projFiles;
      if (
        !options?.trustProjectExtensions &&
        options?.trustManager &&
        projFiles.length > 0
      ) {
        const untrustedFiles: ParsedExtensionFile[] = [];
        const trustedFilesTemp: ParsedExtensionFile[] = [];

        for (const file of projFiles) {
          const isTrusted = await options.trustManager.isTrusted(
            file.filePath,
            file.rawContent,
            projectDir,
          );
          if (isTrusted) {
            trustedFilesTemp.push(file);
          } else {
            untrustedFiles.push(file);
          }
        }

        // 如果有未信任的文件，通过回调让用户确认
        if (untrustedFiles.length > 0 && options.onUntrusted) {
          const confirmedFiles = await options.onUntrusted(untrustedFiles);
          // 记录用户确认的文件
          if (confirmedFiles.length > 0) {
            await options.trustManager.trustBatch(
              confirmedFiles.map((f) => ({ filePath: f.filePath, content: f.rawContent })),
              projectDir,
            );
            trustedFilesTemp.push(...confirmedFiles);
          }
        }

        trustedProjFiles = trustedFilesTemp;
      }

      for (const f of trustedProjFiles) {
        const existing = fileMap.get(f.name);
        if (existing) {
          overrides.push({
            name: f.name,
            overriddenPath: existing.filePath,
            overriddenSource: existing.source,
            overridingPath: f.filePath,
            overridingSource: f.source,
          });
        }
        fileMap.set(f.name, f);
      }
      errors.push(...projErrors);
    }

    const files = Array.from(fileMap.values());
    const result: ScanResult = { files, errors, overrides };

    // 更新缓存
    this.cache.set(cacheKey, { result, timestamp: Date.now() });

    // 如果有错误，记录日志
    if (errors.length > 0) {
      const log = getLogger();
      log.warn("EXTENSION", `加载 ${type} 时发现 ${errors.length} 个错误`);
      for (const error of errors) {
        log.debug("EXTENSION", error.message);
      }
    }

    // 如果有覆盖，记录 debug 日志
    if (overrides.length > 0) {
      const log = getLogger();
      for (const override of overrides) {
        log.debug(
          "EXTENSION",
          `${override.name}: ${override.overridingSource} 覆盖 ${override.overriddenSource}`,
        );
      }
    }

    return result;
  }

  /**
   * 获取最近一次扫描的错误列表（向后兼容）
   */
  getErrors(type: string, projectDir?: string): string[] {
    // 尝试找到最近的缓存条目
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(`${type}:${projectDir ?? ""}:`)) {
        return entry.result.errors.map((e) => e.message);
      }
    }
    return [];
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 扫描单个目录下的 .md 文件和子目录中的 SKILL.md / AGENT.md / index.md */
  private async scanDir(
    dir: string,
    source: ExtensionSource,
  ): Promise<{ files: ParsedExtensionFile[]; errors: ExtensionLoadError[] }> {
    const log = getLogger();
    const results: ParsedExtensionFile[] = [];
    const errors: ExtensionLoadError[] = [];

    if (!existsSync(dir)) {
      return { files: results, errors };
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // 忽略规则
        if (this.shouldIgnore(entry.name)) continue;

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
            errors.push({ filePath, message: errorMsg });
            log.warn("EXTENSION", errorMsg);
          }
        } else if (entry.isDirectory()) {
          // 子目录模式：xxx/SKILL.md 或 xxx/AGENT.md 或 xxx/index.md
          const candidates = ["SKILL.md", "AGENT.md", "index.md"];

          for (const candidate of candidates) {
            const candidatePath = join(dir, entry.name, candidate);
            if (existsSync(candidatePath)) {
              const name = entry.name;

              try {
                const rawContent = await readFile(candidatePath, "utf-8");
                const { frontmatter, body } = parseFrontmatter(rawContent);

                results.push({
                  name,
                  filePath: candidatePath,
                  source,
                  rawContent,
                  frontmatter,
                  body,
                });
                break; // 找到第一个就停止
              } catch (err: any) {
                const errorMsg = `读取扩展文件失败: ${candidatePath} - ${err.message}`;
                errors.push({ filePath: candidatePath, message: errorMsg });
                log.warn("EXTENSION", errorMsg);
                break;
              }
            }
          }

          // 如果子目录没有找到任何候选文件，不报错（可能是其他用途的目录）
        }
      }
    } catch (err: any) {
      const errorMsg = `扫描目录失败: ${dir} - ${err.message}`;
      errors.push({ filePath: dir, message: errorMsg });
      log.warn("EXTENSION", errorMsg);
    }

    return { files: results, errors };
  }

  /**
   * 是否应该忽略该文件/目录
   */
  private shouldIgnore(name: string): boolean {
    // 1. _ 前缀（草稿/禁用）
    if (name.startsWith("_")) return true;
    // 2. . 前缀（隐藏文件）
    if (name.startsWith(".")) return true;
    // 3. 特殊目录
    if (name === "node_modules" || name === ".git") return true;
    return false;
  }
}
