/**
 * Skill 动态发现（Task 4）
 *
 * 启动时只扫描根级 skills 目录。当模型对某个文件执行操作（read/write/edit/glob/grep）时，
 * 检查该文件所在目录链上是否有 .sid-code/skills/ 子目录，若有则动态加载其中的 Skill。
 *
 * 这让深层子目录的 Skill 无需启动时全量扫描即可被发现，
 * 兼顾"零配置可见"与"启动开销可控"。
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, isAbsolute, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";

/**
 * 工具 input 里承载路径的字段名（P1-5）。
 *
 * ⚠️ 必须 ⊇ `packages/core/src/tool/*.ts` zod schema 里全部路径类字段名——此前漏了
 * `ls` 的 `dir_path`：与 glob/grep 同属目录级探查，后两者的 `path` 收了它却没收，
 * 条件激活触发面静默变窄，且零触发时分不清「没配 paths」与「配了但抓不到」。
 * 反漂移断言在 `tests/skill/p1-skill-defects.test.ts`（扫 tool 目录做集合比对）。
 *
 * `bash` 的 `command` 刻意不收：从任意 shell 命令里抽路径误报率高（git log / npm run）。
 */
export const AFFECTED_PATH_FIELDS = [
  "file_path",
  "path",
  "filePath",
  "notebook_path",
  "dir_path",
  "script_path",
] as const;

/** 从工具调用块中提取受影响的文件路径 */
export function extractAffectedPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const paths: string[] = [];

  const candidates = AFFECTED_PATH_FIELDS.map((f) => obj[f]);
  for (const c of candidates) {
    if (typeof c === "string" && c) paths.push(c);
  }

  return paths;
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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
  // 用户级 skills 目录（含 SID_CONFIG_DIR 重定向）由启动扫描按 user 层加载，绝不能当项目层再进信任门。
  // 家目录本身也不参与：与启动项目层上界 getExtensionScanDirs 同口径（家目录 = 用户层）。
  // 此前 cwd=~ 时读任意文件都会把 ~/.sid-code/skills 动态发现成「项目级」，对话中途弹信任框。
  const userSkillsDir = resolve(sidPaths.extensionDir("skills"));
  const home = resolve(homedir());

  for (const filePath of filePaths) {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

    // 限制在 cwd 范围内
    const rel = relative(cwd, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;

    // 沿目录链向上查找，直到 cwd。
    // 起点：路径本身是目录（ls/glob/grep 的 dir_path/path）时从它自己开始，否则从所在目录开始。
    // 此前一律取 dirname：ls 传 cwd 本身时起点落到 cwd 的父目录，循环再也碰不到 cwd 这个终止条件，
    // 一路走到文件系统根，把 ~/.sid-code/skills（用户级）当成「项目级」扫进来，
    // 对话中途弹出第二个信任框（20261020-141455-03a32aa2 实测）。
    let dir = isExistingDir(abs) ? abs : dirname(abs);
    const cwdResolved = resolve(cwd);
    // 防御性上限，避免极端情况下的长循环
    let guard = 0;
    while (guard++ < 100) {
      // 硬边界：起点或任何一步越出 cwd 就停，不依赖「恰好走到 cwd」这个相等判断
      const relDir = relative(cwdResolved, resolve(dir));
      if (relDir.startsWith("..") || isAbsolute(relDir)) break;
      const skillsDir = join(dir, ".sid-code", "skills");
      const isUserLayer = resolve(dir) === home || resolve(skillsDir) === userSkillsDir;
      if (
        !isUserLayer &&
        existsSync(skillsDir) &&
        !alreadyDiscovered.has(skillsDir) &&
        !found.has(skillsDir)
      ) {
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
