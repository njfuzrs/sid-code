/**
 * Skill 动态发现（Task 4）
 *
 * 启动时只扫描根级 skills 目录。当模型对某个文件执行操作（read/write/edit/glob/grep）时，
 * 检查该文件所在目录链上是否有 .sid-code/skills/ 子目录，若有则动态加载其中的 Skill。
 *
 * 这让深层子目录的 Skill 无需启动时全量扫描即可被发现，
 * 兼顾"零配置可见"与"启动开销可控"。
 */

import { existsSync } from "node:fs";
import { dirname, join, isAbsolute, resolve, relative } from "node:path";
import { getLogger } from "../debug/logger.ts";

/** 从工具调用块中提取受影响的文件路径 */
export function extractAffectedPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const paths: string[] = [];

  const candidates = [obj.file_path, obj.path, obj.filePath, obj.notebook_path];
  for (const c of candidates) {
    if (typeof c === "string" && c) paths.push(c);
  }

  return paths;
}

/**
 * 为受影响的文件路径发现 skills 目录
 * 沿目录链向上查找 .sid-code/skills/，限制在 cwd 范围内
 * @returns 新发现的 skills 目录绝对路径列表
 */
export function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
  alreadyDiscovered: Set<string>,
): string[] {
  const found = new Set<string>();

  for (const filePath of filePaths) {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

    // 限制在 cwd 范围内
    const rel = relative(cwd, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;

    // 沿目录链向上查找，直到 cwd
    let dir = dirname(abs);
    const cwdResolved = resolve(cwd);
    // 防御性上限，避免极端情况下的长循环
    let guard = 0;
    while (guard++ < 100) {
      const skillsDir = join(dir, ".sid-code", "skills");
      if (existsSync(skillsDir) && !alreadyDiscovered.has(skillsDir) && !found.has(skillsDir)) {
        found.add(skillsDir);
      }

      if (resolve(dir) === cwdResolved) break;
      const parent = dirname(dir);
      if (parent === dir) break; // 到达文件系统根
      dir = parent;
    }
  }

  if (found.size > 0) {
    getLogger().debug("SKILL", `动态发现 ${found.size} 个 skills 目录`, { dirs: [...found] });
  }

  return [...found];
}

/**
 * 动态发现协调器：跟踪已发现目录，避免重复加载
 */
export class DynamicSkillDiscovery {
  private discoveredDirs = new Set<string>();

  constructor(private cwd: string) {}

  /**
   * 处理一次工具调用，返回需要新加载的 skills 目录
   */
  onToolUse(toolName: string, input: unknown): string[] {
    const triggerTools = ["read", "write", "edit", "glob", "grep", "multi_edit"];
    if (!triggerTools.includes(toolName.toLowerCase())) return [];

    const paths = extractAffectedPaths(input);
    if (paths.length === 0) return [];

    const newDirs = discoverSkillDirsForPaths(paths, this.cwd, this.discoveredDirs);
    for (const d of newDirs) this.discoveredDirs.add(d);
    return newDirs;
  }

  /** 已发现的目录集合 */
  getDiscoveredDirs(): string[] {
    return [...this.discoveredDirs];
  }

  reset(): void {
    this.discoveredDirs.clear();
  }
}
