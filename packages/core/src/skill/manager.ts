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
  /**
   * P0-4：插件/动态发现追加进来的 skill（命名空间前缀隔离）。
   * 单独留存的原因：discover() 会 clearSkills() 重扫 builtin/user/project，
   * 若不缓存，reload（P2-3 热重载）后插件/动态 skill 会丢失。reload 末尾据此重放。
   */
  private appendedSkills: SkillDefinition[] = [];
  /** P2-3：记住上次 discover 的入参，供热重载沿用同一套扫描配置（trustManager 等）。 */
  private lastProjectDir?: string;
  private lastScanOptions?: ScanOptions;

  constructor(loader?: SkillLoader) {
    this.loader = loader ?? new SkillLoader();
  }

  /**
   * 发现并加载所有 Skill
   * 加载优先级：builtin（最低）→ user → project（最高）
   */
  async discover(projectDir?: string, scanOptions?: ScanOptions): Promise<void> {
    this.clearSkills();
    this.lastProjectDir = projectDir;
    this.lastScanOptions = scanOptions;
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
      this.skills.map((s) => [s.name.toLowerCase(), s]),
    );

    for (const newSkill of newSkills) {
      const key = newSkill.name.toLowerCase();
      const existingSkill = skillMap.get(key);

      if (existingSkill && existingSkill.filePath !== newSkill.filePath) {
        if (existingSkill.isBuiltin) {
          log.warn("SKILL", `Skill "${newSkill.name}" (${newSkill.source}) 覆盖了内置 Skill`);
        } else {
          log.warn(
            "SKILL",
            `Skill "${newSkill.name}" (${newSkill.source}) 覆盖了来自 ${existingSkill.source} 的同名 Skill`,
          );
        }
      }

      skillMap.set(key, newSkill);
    }

    this.skills = Array.from(skillMap.values());
  }

  /**
   * P0-4：追加插件 skills（命名空间前缀 pluginName:skillName 天然避免与内置/用户冲突）。
   * 在 discover 之后调用。同名走标准 precedence（后者覆盖），但前缀隔离下几乎不会同名。
   */
  addPluginSkills(pluginSkills: SkillDefinition[]): void {
    if (pluginSkills.length === 0) return;
    this.addSkillsWithPrecedence(pluginSkills);
    // P2-3：登记以便热重载后重放（clearSkills 只清 builtin/user/project 重扫结果）。
    // 同 filePath 去重，避免同一 skill 多次 add 后 reload 重复堆叠。
    const known = new Set(this.appendedSkills.map((s) => s.filePath));
    for (const s of pluginSkills) {
      if (!known.has(s.filePath)) {
        this.appendedSkills.push(s);
        known.add(s.filePath);
      }
    }
    getLogger().info("SKILL", `追加 ${pluginSkills.length} 个插件 Skill`);
    // 斜杠命令快照失效：新 skill 需立即可 /name 调用（否则报「未知命令」）
    this.notifySkillsChanged();
  }

  /**
   * 原子替换所有插件来源的 skills（/reload-plugins 用）。
   *
   * 为什么不能复用 addPluginSkills：那是纯追加语义——插件被卸载/禁用后它带的 skill
   * 会永久残留在 skills 与 appendedSkills 里（还会被热重载一次次重放）。这里先剔除
   * 全部 loadedFrom="plugin" 的旧条目，再并入新集合，整个过程在同一同步调用内完成。
   *
   * 只动 plugin 来源：MCP skills（loadedFrom="mcp"）与动态发现的 skill 不受影响。
   *
   * @returns 替换后的插件 skill 数量
   */
  replacePluginSkills(pluginSkills: SkillDefinition[]): number {
    const isPlugin = (s: SkillDefinition) => s.loadedFrom === "plugin";
    const before = this.skills.filter(isPlugin).length;

    // 剔除旧插件 skill（skills 与热重载重放清单两处都要清，否则 reload 会把旧的带回来）
    this.skills = this.skills.filter((s) => !isPlugin(s));
    this.appendedSkills = this.appendedSkills.filter((s) => !isPlugin(s));

    if (pluginSkills.length > 0) {
      this.addSkillsWithPrecedence(pluginSkills);
      const known = new Set(this.appendedSkills.map((s) => s.filePath));
      for (const s of pluginSkills) {
        if (!known.has(s.filePath)) {
          this.appendedSkills.push(s);
          known.add(s.filePath);
        }
      }
    }

    getLogger().info("SKILL", `插件 Skill 已替换: ${before} → ${pluginSkills.length}`);
    this.notifySkillsChanged();
    return pluginSkills.length;
  }

  /**
   * P2-3：热重载。重扫 builtin/user/project（先清 loader 缓存，避免命中 5min TTL 旧结果），
   * 再重放插件/动态发现的 appendedSkills（命名空间前缀天然不与重扫结果冲突）。
   *
   * 注意：discover() 会 clearSkills() + 重置 gated/active 态。gated 态由调用方
   *（SkillActivationCoordinator.reinit）在 reload 后重新分离条件 skill 建立，
   * 已激活的动态 skill 由 coordinator 侧保留（只进不退）。
   */
  async reload(): Promise<void> {
    const log = getLogger();
    // 清 ExtensionLoader 缓存，否则 5min TTL 内重扫命中旧结果，改动不生效。
    try {
      this.loader.getExtensionLoader().clearCache();
    } catch {
      /* 缓存清理失败不阻断重载 */
    }

    // 快照 reload 前的禁用集（discover 重建 skill 定义会丢失 disabled 态，需重放）。
    const disabledNames = this.skills.filter((s) => s.disabled).map((s) => s.name);

    const preserved = [...this.appendedSkills];
    await this.discover(this.lastProjectDir, this.lastScanOptions);
    if (preserved.length > 0) {
      // 重放插件/动态 skill（appendedSkills 已被 discover 后仍留存，此处只是重新并入 skills 数组）
      this.addSkillsWithPrecedence(preserved);
    }
    // 重放禁用态（/skills disable 的选择应跨热重载保留）
    if (disabledNames.length > 0) this.setDisabledSkills(disabledNames);
    log.info(
      "SKILL",
      `Skill 热重载完成：${this.skills.length} 个（含 ${preserved.length} 个插件/动态）`,
    );
    // 热重载改变了整个 skill 集合（新增/删除/内容变更），斜杠命令快照必须失效
    this.notifySkillsChanged();
  }

  // ===== skill 集合变更通知（斜杠命令快照失效用）=====

  /** skill 集合变更监听器（斜杠命令注册表据此清缓存，重新投影 skill → 命令） */
  private changeListeners: Array<() => void> = [];

  /**
   * 订阅 skill 集合变更。
   *
   * 动机：用户斜杠命令走 UnifiedCommandRegistry，其结果按 cwd 缓存。运行时追加的 skill
   *（插件 / MCP 发现 / 动态发现 / 热重载 / gate 解除）不会自动出现在快照里，
   * 用户敲 `/plugin:skill` 会得到「未知命令」。让 manager 主动广播，订阅方清缓存即可。
   *
   * @returns 取消订阅函数
   */
  onSkillsChanged(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  /** 广播 skill 集合变更（监听器异常不影响其他监听器与主流程） */
  private notifySkillsChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        getLogger().debug(
          "SKILL",
          `skill 变更监听器异常（忽略）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ===== P1-2/P2-2：条件激活门控（gated skill 从模型 listing 隐藏，直到被激活）=====

  /** gated skill 名（小写）：已加载但尚未在模型 listing 中暴露（条件激活/动态发现前） */
  private gatedSkillNames = new Set<string>();

  /** 设置 gated 集合（覆盖式）。条件激活 skill 初始化时全部 gate。 */
  setGatedSkills(names: string[]): void {
    this.gatedSkillNames = new Set(names.map((n) => n.toLowerCase()));
    this.notifySkillsChanged();
  }

  /** 解除某个 skill 的 gate（激活后从 listing 隐藏 → 暴露）。 */
  ungateSkill(name: string): void {
    if (!this.gatedSkillNames.delete(name.toLowerCase())) return;
    // gate 解除意味着该 skill 从「不可调用」变为「可调用」，斜杠命令快照需刷新
    this.notifySkillsChanged();
  }

  /** 该 skill 是否被 gate（隐藏于模型 listing）。 */
  isGated(name: string): boolean {
    return this.gatedSkillNames.has(name.toLowerCase());
  }

  /**
   * 获取应进入模型 listing 的 skill（P1-2/P3-2）：
   * 已启用 + 未禁模型调用 + 未被 gate（条件激活未触发的 skill 不进初始 listing）。
   */
  getListableSkills(): SkillDefinition[] {
    return this.skills.filter(
      (s) => !s.disabled && !s.disableModelInvocation && !this.isGated(s.name),
    );
  }

  /**
   * 获取所有已启用的 Skill
   */
  getSkills(): SkillDefinition[] {
    return this.skills.filter((s) => !s.disabled);
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
    return this.skills.find((s) => s.name.toLowerCase() === lowercaseName) ?? null;
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
    const lowercaseDisabledNames = names.map((n) => n.toLowerCase());
    for (const skill of this.skills) {
      skill.disabled = lowercaseDisabledNames.includes(skill.name.toLowerCase());
    }
    // 启用/禁用改变了可调用集合，斜杠命令快照需刷新
    this.notifySkillsChanged();
  }

  /**
   * 清除所有 Skill
   */
  clearSkills(): void {
    this.skills = [];
    this.activeSkillNames.clear();
  }
}
