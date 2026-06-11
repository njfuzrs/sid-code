/**
 * Skill 管理器
 * 统一管理 Skill 生命周期：发现、加载、激活、禁用
 */

import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";
import { SkillLoader } from "./loader.ts";
import type { ScanOptions } from "../extension/types.ts";
import { ensureBuiltinSkillsReleased } from "./ensure-builtin.ts";

export class SkillManager {
  private skills: SkillDefinition[] = [];
  private activeSkillNames = new Set<string>();
  private loader: SkillLoader;

  constructor(loader?: SkillLoader) {
    this.loader = loader ?? new SkillLoader();
  }

  /**
   * 发现并加载所有 Skill
   * 加载优先级：builtin（最低）→ user → project（最高）
   */
  async discover(projectDir?: string, scanOptions?: ScanOptions): Promise<void> {
    this.clearSkills();
    const log = getLogger();

    // 1. 加载内置 Skill（最低优先级）
    await this.discoverBuiltin();

    // 2. 加载用户和项目 Skill
    const skills = await this.loader.loadAll(projectDir, scanOptions);
    this.addSkillsWithPrecedence(skills);

    const enabledCount = this.getSkills().length;
    const totalCount = this.skills.length;
    if (totalCount > 0) {
      log.info("SKILL", `发现 ${totalCount} 个 Skill（${enabledCount} 个已启用）`);
    }
  }

  /**
   * 发现内置 Skill
   *
   * 实现思路（2026-06 重构）：编译二进制运行时 import.meta.url=/$bunfs/root，
   * 无法用相对路径定位 src/skill/builtin/。改为：先把编译期嵌入的 builtin Skill
   * 释放到磁盘 ~/.sid-code/builtin-skills/（ensureBuiltinSkillsReleased），再以该目录作为
   * builtinDir 走与 user/project 完全一致的磁盘扫描链。这样三类 skill 同源同链，
   * 且二进制自包含、可拷贝到任意机器运行，不依赖 repo 路径。
   *
   * 历史（ADR-025）：旧实现把 builtinDir 当 projectDir 传给 loader.loadAll，
   * 导致扫错目录、builtin skill 全部不被加载——已通过 scanOptions.builtinDir 修正。
   */
  private async discoverBuiltin(): Promise<void> {
    try {
      // 把嵌入的 builtin Skill 释放到磁盘，拿到释放目录
      const builtinDir = await ensureBuiltinSkillsReleased();

      // 通过 builtinDir 选项让 ExtensionLoader 直接扫 builtinDir/<name>/SKILL.md（builtin 来源分支）
      const builtinSkills = await this.loader.loadAll(undefined, { builtinDir });

      for (const skill of builtinSkills) {
        skill.isBuiltin = true;
      }

      this.addSkillsWithPrecedence(builtinSkills);
    } catch (error) {
      // 释放/加载失败不阻断启动：降级为"无 builtin skill"
      getLogger().debug(
        "SKILL",
        `加载内置 Skill 失败（降级）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 添加 Skill，处理同名覆盖
   */
  private addSkillsWithPrecedence(newSkills: SkillDefinition[]): void {
    const log = getLogger();
    const skillMap = new Map<string, SkillDefinition>(
      this.skills.map(s => [s.name.toLowerCase(), s]),
    );

    for (const newSkill of newSkills) {
      const key = newSkill.name.toLowerCase();
      const existingSkill = skillMap.get(key);

      if (existingSkill && existingSkill.filePath !== newSkill.filePath) {
        if (existingSkill.isBuiltin) {
          log.warn("SKILL", `Skill "${newSkill.name}" (${newSkill.source}) 覆盖了内置 Skill`);
        } else {
          log.warn("SKILL", `Skill "${newSkill.name}" (${newSkill.source}) 覆盖了来自 ${existingSkill.source} 的同名 Skill`);
        }
      }

      skillMap.set(key, newSkill);
    }

    this.skills = Array.from(skillMap.values());
  }

  /**
   * 获取所有已启用的 Skill
   */
  getSkills(): SkillDefinition[] {
    return this.skills.filter(s => !s.disabled);
  }

  /**
   * 获取所有 Skill（包括禁用的）
   */
  getAllSkills(): SkillDefinition[] {
    return this.skills;
  }

  /**
   * 按名称获取 Skill（不区分大小写）
   */
  getSkill(name: string): SkillDefinition | null {
    const lowercaseName = name.toLowerCase();
    return this.skills.find(s => s.name.toLowerCase() === lowercaseName) ?? null;
  }

  /**
   * 激活 Skill（追踪状态）
   */
  activateSkill(name: string): void {
    this.activeSkillNames.add(name);
  }

  /**
   * 检查 Skill 是否已激活
   */
  isSkillActive(name: string): boolean {
    return this.activeSkillNames.has(name);
  }

  /**
   * 设置禁用列表
   */
  setDisabledSkills(names: string[]): void {
    const lowercaseDisabledNames = names.map(n => n.toLowerCase());
    for (const skill of this.skills) {
      skill.disabled = lowercaseDisabledNames.includes(skill.name.toLowerCase());
    }
  }

  /**
   * 清除所有 Skill
   */
  clearSkills(): void {
    this.skills = [];
    this.activeSkillNames.clear();
  }
}
