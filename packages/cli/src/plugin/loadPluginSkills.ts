/**
 * 插件 Skills 加载（P0-4：补齐缺失的 loadPluginSkills）
 *
 * 背景（缺口）：manifest.ts 把插件 skills/ 目录解析进了 LoadedPlugin.skillsPaths，
 * command/commands/plugin/plugin.ts 也显示"Skill(N 目录)"，但**没有任何 loader 从 skillsPaths 加载 skill**。
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
import { recordComponentLoadError } from "./component-errors.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

/** 加载单个插件的所有 skills（施加 pluginName: 命名空间前缀） */
export async function loadSkillsForPlugin(plugin: LoadedPlugin): Promise<SkillDefinition[]> {
  const log = getLogger();
  const extLoader = new ExtensionLoader();
  const skillLoader = new SkillLoader(extLoader);
  const out: SkillDefinition[] = [];

  for (const dir of plugin.skillsPaths) {
    let scan: Awaited<ReturnType<ExtensionLoader["scanSingleDir"]>>;
    try {
      // 来源标 "plugin"（缺陷 41）：插件 skill 不是项目自带内容。
      // 此前传 "project" 并在下面把 source 覆盖成 project，后果有三处：
      //   1. /skills 面板把插件 skill 列进「项目级」，用户去 .sid-code/skills/ 找不到；
      //   2. 企业策略按来源过滤时（strictPluginOnlyCustomization），插件 skill 会被
      //      当成不受信的项目来源拦掉 —— 而插件在白名单里（ADMIN_TRUSTED_SOURCES）。
      //      scanSingleDir 现在返回 errors（缺陷 42），这条路径也要把它交出去。
      scan = await extLoader.scanSingleDir(dir, "plugin");
    } catch (err: any) {
      log.warn("PLUGIN", `扫描插件 skills 目录失败 ${dir}: ${err?.message ?? String(err)}`);
      // 该目录下的 skill 全部缺失，只留 warn 的话用户只会觉得"skill 少了几个"
      recordComponentLoadError({
        type: "component-load-failed",
        source: plugin.source,
        component: "skills",
        error: `扫描目录 ${dir} 失败: ${err?.message ?? String(err)}`,
      });
      continue;
    }

    // 缺陷 42：扫描层 fail-closed 跳过的文件（畸形 frontmatter / 读失败）必须传出去。
    // scanDir 产生了 ExtensionLoadError[]，旧 scanSingleDir 把它们整块丢掉 ——
    // 用户体感是「装了 5 个 skill 只出现 4 个，没有任何提示」。
    // 这里转成 component-load-failed，让 /plugin 面板与 /reload-plugins 能看到
    // （缺陷 22 里这个错误类型产生点为 0，本路径就是它该被产生的地方之一）。
    for (const scanError of scan.errors) {
      recordComponentLoadError({
        type: "component-load-failed",
        source: plugin.source,
        component: "skills",
        error: scanError.message,
      });
    }

    for (const file of scan.files) {
      const skill = skillLoader.buildNamespacedSkill(file, plugin.name, "plugin");
      if (skill) out.push(skill);
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
