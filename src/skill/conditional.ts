/**
 * Skill 条件激活（Task 4）
 *
 * 三层 Skill 状态模型：
 *   启动时加载
 *       ├─ 无 paths → unconditional（立即可用）
 *       └─ 有 paths → conditional（等待激活）
 *                         │ 文件操作匹配 paths 模式
 *                         ▼
 *                     dynamic（运行时激活，只进不退）
 *
 * 用 Bun.Glob 做 gitignore 风格的路径匹配（无需额外依赖）。
 */

import { isAbsolute, relative } from "node:path";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";

export class ConditionalSkillStore {
  /** 有 paths 字段、尚未激活的 Skill */
  private conditional = new Map<string, SkillDefinition>();
  /** 已激活的条件 Skill（运行时激活，只进不退） */
  private dynamic = new Map<string, SkillDefinition>();

  /**
   * 启动时分离条件 Skill
   * @returns 无条件 Skill（立即可用）；有 paths 的存入 conditional
   */
  separate(skills: SkillDefinition[]): SkillDefinition[] {
    const unconditional: SkillDefinition[] = [];
    for (const skill of skills) {
      if (skill.paths && skill.paths.length > 0) {
        this.conditional.set(skill.name, skill);
      } else {
        unconditional.push(skill);
      }
    }
    return unconditional;
  }

  /**
   * 文件操作时检查是否匹配条件 Skill 的路径模式
   * 匹配则激活（从 conditional 移到 dynamic）
   * @returns 本次新激活的 Skill 名称列表
   */
  activateForPaths(filePaths: string[], cwd: string): string[] {
    if (this.conditional.size === 0) return [];
    const log = getLogger();
    const activated: string[] = [];

    for (const [name, skill] of [...this.conditional]) {
      if (!skill.paths || skill.paths.length === 0) continue;

      if (this.anyPathMatches(filePaths, skill.paths, cwd)) {
        this.dynamic.set(name, skill);
        this.conditional.delete(name);
        activated.push(name);
        log.info("SKILL", `条件 Skill 已激活: ${name}`);
      }
    }

    return activated;
  }

  /** 检查一组文件路径中是否有任何一个匹配 glob 模式 */
  private anyPathMatches(
    filePaths: string[],
    patterns: string[],
    cwd: string,
  ): boolean {
    for (const filePath of filePaths) {
      const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
      // 跳过 cwd 外的路径
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      const normalized = rel.split("\\").join("/");

      for (const pattern of patterns) {
        if (matchGlob(normalized, pattern)) return true;
      }
    }
    return false;
  }

  /** 已激活的动态 Skill */
  getDynamicSkills(): SkillDefinition[] {
    return [...this.dynamic.values()];
  }

  /** 尚未激活的条件 Skill 名称 */
  getConditionalNames(): string[] {
    return [...this.conditional.keys()];
  }

  /** 是否已激活 */
  isActivated(name: string): boolean {
    return this.dynamic.has(name);
  }

  /** 重置（测试用） */
  reset(): void {
    this.conditional.clear();
    this.dynamic.clear();
  }
}

/**
 * glob 匹配：优先用 Bun.Glob，回退到简单正则实现
 * 支持 ** / * / ? ，路径用 / 分隔
 */
export function matchGlob(path: string, pattern: string): boolean {
  // Bun.Glob 可用时直接用（更完整的 glob 语义）
  const BunGlobal = (globalThis as any).Bun;
  if (BunGlobal?.Glob) {
    try {
      return new BunGlobal.Glob(pattern).match(path);
    } catch {
      // 落到正则回退
    }
  }
  return globToRegExp(pattern).test(path);
}

/** 将 glob 模式编译为正则（回退实现） */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** → 匹配任意层级（含 /）
        re += ".*";
        i++;
        // 吞掉 **/ 的斜杠
        if (pattern[i + 1] === "/") i++;
      } else {
        // * → 匹配除 / 外任意字符
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
