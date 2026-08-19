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
import { sidPaths, getClaudeHome } from "../config/paths.ts";
import { isRestrictedToPluginOnly } from "../config/plugin-only-policy.ts";
import { isPolicyAllowed } from "../config/policy-limits.ts";
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
  async scan(
    type: string,
    projectDir?: string,
    options?: ScanOptions,
  ): Promise<ParsedExtensionFile[]> {
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
  async scanWithResult(
    type: string,
    projectDir?: string,
    options?: ScanOptions,
  ): Promise<ScanResult> {
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

    // 合并一批扫描结果进 fileMap（后合并覆盖先合并，记录 override）
    const mergeFiles = (files: ParsedExtensionFile[]) => {
      for (const f of files) {
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
    };

    // 企业策略：该定制化面是否被锁定为「仅管理员可信来源」
    //（strictPluginOnlyCustomization）。锁定时跳过 user/project/additional 三层，
    // 只保留 builtin 与 managed —— 防止未审计的项目级 skill/agent 被自动加载执行。
    // type 与面名同形（skills/commands/agents/hooks），直接透传。
    //
    // P1（policyLimits 接线）：`policyLimits` 此前**只被写入、从不被读取** ——
    // `setPolicyLimits()` 有调用点，三个判定函数全仓 0 个。企业配了开关却毫无效果，
    // 而 `website/team/policy.md` 还写着"注入生效"。这里把它接到已有的
    // surfaceLocked 上，复用同一条跳过逻辑，不新增控制流。
    //
    // 两个开关的分工：`strictPluginOnlyCustomization` 限制**来源**（只信管理员的），
    // `policyLimits` 是**总开关**（这个面整个不要）。取或即可，语义不冲突。
    // commands 面刻意排除在 `extensions` 之外——它由 `custom_commands` 单独管，
    // 否则管理员只禁了 extensions 却连斜杠命令一起没了，是个意外行为。
    const surfaceLocked =
      isRestrictedToPluginOnly(
        type as import("../config/plugin-only-policy.ts").CustomizationSurface,
      ) ||
      (type !== "commands" && !isPolicyAllowed("extensions"));
    if (surfaceLocked) {
      getLogger().debug(
        "EXTENSION",
        `${type} 已被企业策略锁定为仅管理员来源，跳过 user/project/additional 层`,
      );
    }

    // 1. 扫描用户级目录（P1-6：先 ~/.claude 兜底，再 ~/.sid-code 覆盖）
    //    CC 迁移用户把命令放在 ~/.claude/{type}/，我们兼容读取；同名以 .sid-code 为准。
    if (!surfaceLocked) {
      const userClaudeDir = join(getClaudeHome(), type);
      const { files: userClaudeFiles, errors: userClaudeErrors } = await this.scanDir(
        userClaudeDir,
        "user",
      );
      mergeFiles(userClaudeFiles);
      errors.push(...userClaudeErrors);

      const userDir = sidPaths.extensionDir(type);
      const { files: userFiles, errors: userErrors } = await this.scanDir(userDir, "user");
      mergeFiles(userFiles);
      errors.push(...userErrors);
    }

    // 2. 扫描项目级目录（P1-6：先 {proj}/.claude 兜底，再 {proj}/.sid-code 覆盖）
    //    两个项目目录都走信任检查（项目级扩展默认不可信）。
    if (projectDir && !surfaceLocked) {
      // 对一批项目级文件做信任过滤，返回可信文件
      const filterTrusted = async (
        files: ParsedExtensionFile[],
      ): Promise<ParsedExtensionFile[]> => {
        if (options?.trustProjectExtensions || !options?.trustManager || files.length === 0) {
          return files;
        }
        const untrustedFiles: ParsedExtensionFile[] = [];
        const trustedFilesTemp: ParsedExtensionFile[] = [];
        for (const file of files) {
          const isTrusted = await options.trustManager.isTrusted(
            file.filePath,
            file.rawContent,
            projectDir,
          );
          if (isTrusted) trustedFilesTemp.push(file);
          else untrustedFiles.push(file);
        }
        // 未信任文件通过回调让用户确认
        if (untrustedFiles.length > 0 && options.onUntrusted) {
          const confirmedFiles = await options.onUntrusted(untrustedFiles);
          if (confirmedFiles.length > 0) {
            await options.trustManager.trustBatch(
              confirmedFiles.map((f) => ({ filePath: f.filePath, content: f.rawContent })),
              projectDir,
            );
            trustedFilesTemp.push(...confirmedFiles);
          }
        }
        return trustedFilesTemp;
      };

      const projClaudeDir = join(projectDir, ".claude", type);
      const { files: projClaudeFiles, errors: projClaudeErrors } = await this.scanDir(
        projClaudeDir,
        "project",
      );
      mergeFiles(await filterTrusted(projClaudeFiles));
      errors.push(...projClaudeErrors);

      const projDir = join(projectDir, ".sid-code", type);
      const { files: projFiles, errors: projErrors } = await this.scanDir(projDir, "project");
      mergeFiles(await filterTrusted(projFiles));
      errors.push(...projErrors);
    }

    // 2.5 additional 层（--add-dir 授权目录，对齐 CC loadSkillsDir 的 additionalDirs）。
    //     语义：用户显式用 --add-dir 授权的目录，其 .sid-code/{type}/ 与 .claude/{type}/
    //     同样参与加载。优先级高于项目级（更晚合并 = 覆盖），低于 managed。
    //     信任：显式命令行授权已表达用户意图，与项目级自动发现不同，故不再走信任确认；
    //     但受 strictPluginOnlyCustomization 锁定约束（--add-dir 不是策略绕过口）。
    if (options?.additionalDirs && options.additionalDirs.length > 0 && !surfaceLocked) {
      for (const baseDir of options.additionalDirs) {
        for (const sub of [".claude", ".sid-code"]) {
          const dir = join(baseDir, sub, type);
          const { files: addFiles, errors: addErrors } = await this.scanDir(dir, "project");
          mergeFiles(addFiles);
          errors.push(...addErrors);
        }
      }
    }

    // 3. P2-1：企业 managed 层（最高优先级，最后扫描）。managed 扩展覆盖同名 user/project，
    //    且不受项目信任检查约束（企业下发本就是可信源）。SID_CODE_DISABLE_POLICY_SKILLS=1 时跳过。
    const policyDisabled = process.env.SID_CODE_DISABLE_POLICY_SKILLS === "1";
    if (options?.managedDirs && options.managedDirs.length > 0 && !policyDisabled) {
      for (const managedDir of options.managedDirs) {
        const { files: managedFiles, errors: managedErrors } = await this.scanDir(
          managedDir,
          "managed",
        );
        mergeFiles(managedFiles);
        errors.push(...managedErrors);
      }
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

  /**
   * P0-4：扫描任意单个目录（供插件 skills 加载复用与 user/project 完全一致的扫描逻辑：
   * 扁平 .md + 子目录 SKILL.md/AGENT.md/index.md）。source 标记来源（插件传 "project" 语义占位，
   * 真实 loadedFrom 由调用方覆盖）。
   */
  async scanSingleDir(
    dir: string,
    source: ExtensionSource = "project",
  ): Promise<ParsedExtensionFile[]> {
    const { files } = await this.scanDir(dir, source);
    return files;
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
            const { frontmatter, body, error: fmError } = parseFrontmatter(rawContent);

            // 审计第 4 条：frontmatter 畸形时 fail-closed 跳过该文件，不再静默降级。
            // 旧行为把原始 YAML 当正文返回，导致 allowed-tools/model/tools 白名单
            // 随解析失败一起消失（降级方向更宽松），且 YAML 原文被当指令喂给模型。
            if (fmError) {
              const errorMsg = `扩展文件 frontmatter 格式错误，已跳过: ${filePath} - ${fmError}`;
              errors.push({ filePath, message: errorMsg });
              log.warn("EXTENSION", errorMsg);
              continue;
            }

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
                const { frontmatter, body, error: fmError } = parseFrontmatter(rawContent);

                // 审计第 4 条：同扁平文件分支，畸形 frontmatter fail-closed 跳过。
                if (fmError) {
                  const errorMsg = `扩展文件 frontmatter 格式错误，已跳过: ${candidatePath} - ${fmError}`;
                  errors.push({ filePath: candidatePath, message: errorMsg });
                  log.warn("EXTENSION", errorMsg);
                  break;
                }

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
