/**
 * 插件 Skills 加载（P0-4：补齐缺失的 loadPluginSkills）
 *
 * 背景（缺口）：manifest.ts 把插件 skills/ 目录解析进了 LoadedPlugin.skillsPaths，
 * command/plugin.ts 也显示"Skill(N 目录)"，但**没有任何 loader 从 skillsPaths 加载 skill**。
 * 插件系统有 loadPluginCommands / loadPluginAgents / loadPluginHooks / loadPluginMcp，
 * 唯独缺 loadPluginSkills——§18.10 插件带的 skills 加载不进来。
 *
 * 命名规则（对齐 CC {pluginName}:{skillName} + 现有 command 命名空间）：
 *   skills/code-review/SKILL.md  → my-plugin:code-review
 *
 * 命名空间隔离：前缀在 SkillLoader.sanitizeName **之后**施加（buildNamespacedSkill），
 * 绕开 sanitizeName 会把 `:` 替成 `-`、validateName 会拒 `:` 的问题。
 */

import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import { SkillLoader } from "@sid-code/core/skill/loader.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

/** 加载单个插件的所有 skills（施加 pluginName: 命名空间前缀） */
export async function loadSkillsForPlugin(plugin: LoadedPlugin): Promise<SkillDefinition[]> {
  const log = getLogger();
  const extLoader = new ExtensionLoader();
  const skillLoader = new SkillLoader(extLoader);
  const out: SkillDefinition[] = [];

  for (const dir of plugin.skillsPaths) {
    let files;
    try {
      files = await extLoader.scanSingleDir(dir, "project");
    } catch (err: any) {
      log.warn("PLUGIN", `扫描插件 skills 目录失败 ${dir}: ${err?.message ?? String(err)}`);
      continue;
    }

    for (const file of files) {
      const skill = skillLoader.buildNamespacedSkill(file, plugin.name, "plugin");
      if (skill) {
        skill.source = "project";
        out.push(skill);
      }
    }
  }

  return out;
}

/**
 * 加载所有已启用插件的 skills（memoized）。
 */
export const getPluginSkills = memoize(async (): Promise<SkillDefinition[]> => {
  const { enabled } = await loadAllPluginsCacheOnly();
  const all: SkillDefinition[] = [];
  for (const plugin of enabled) {
    if (!plugin.skillsPaths || plugin.skillsPaths.length === 0) continue;
    const skills = await loadSkillsForPlugin(plugin);
    all.push(...skills);
  }
  if (all.length > 0) {
    getLogger().info("PLUGIN", `加载了 ${all.length} 个插件 Skill`, {
      names: all.map((s) => s.name),
    });
  }
  return all;
});

registerPluginCache(getPluginSkills.clear);
