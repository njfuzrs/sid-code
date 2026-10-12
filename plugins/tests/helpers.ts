/**
 * plugins/ 测试共用的定位与加载工具。
 *
 * 为什么不用 SkillManager.discover：迁到插件后这些 skill 不再是 builtin，
 * 只有用户装了对应插件才会出现。这里直接走插件加载链（loadPluginFromDirectory →
 * loadSkillsForPlugin），与用户从市场装上之后客户端实际执行的是同一条路径，
 * 所以断言的命名空间、frontmatter 解析结果就是用户会拿到的那份。
 */

import { join } from "node:path";
import { loadPluginFromDirectory } from "@sid-code/cli/plugin/manifest.ts";
import { loadSkillsForPlugin } from "@sid-code/cli/plugin/loadPluginSkills.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

/** 仓库内 plugins/ 根目录 */
export const PLUGINS_ROOT = join(import.meta.dir, "..");

/** 某个插件内某个 skill 的目录，如 skillDir("ops", "ci-heal") */
export function skillDir(plugin: string, skill: string): string {
  return join(PLUGINS_ROOT, plugin, "skills", skill);
}

/** 按客户端真实路径加载一个插件的全部 skill（带 `插件名:` 命名空间） */
export async function loadPluginSkillsFromRepo(plugin: string): Promise<SkillDefinition[]> {
  const errors: unknown[] = [];
  const loaded = await loadPluginFromDirectory(
    join(PLUGINS_ROOT, plugin),
    "repo",
    true,
    errors as never[],
  );
  if (!loaded) throw new Error(`插件 ${plugin} 加载失败: ${JSON.stringify(errors)}`);
  return loadSkillsForPlugin(loaded);
}
