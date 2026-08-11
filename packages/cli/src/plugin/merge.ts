/**
 * 插件组件合并逻辑
 *
 * 将插件加载的组件合并到现有运行时系统。各 mergeXxx 是薄封装，
 * 把"从插件加载"与"注册到现有系统"两步串起来，供 cli.ts / refresh.ts 调用。
 */

import { getLogger } from "../debug/logger.ts";
import type { Registry as CommandRegistry } from "../command/registry.ts";
import type { Command } from "../command/types.ts";
import { getPluginCommands } from "./loadPluginCommands.ts";

/** 内置命令名集合（插件命令带前缀，理论上不会冲突，这里仅作双保险） */
function isBuiltinCollision(name: string, builtinNames: ReadonlySet<string>): boolean {
  return builtinNames.has(name);
}

/**
 * 将插件命令合并到 CommandRegistry（原子替换 source=plugin）。
 * @returns 合并的命令数量
 */
export async function mergePluginCommands(registry: CommandRegistry): Promise<number> {
  const pluginCommands = await getPluginCommands();

  // 双保险：过滤掉与内置命令同名的（正常情况下插件命令带前缀不会命中）
  const builtinNames = new Set(registry.all().map((c) => c.name()));
  const safe: Command[] = [];
  for (const cmd of pluginCommands) {
    if (isBuiltinCollision(cmd.name(), builtinNames)) {
      getLogger().warn("PLUGIN", `插件命令 "${cmd.name()}" 与现有命令冲突，已跳过`);
      continue;
    }
    safe.push(cmd);
  }

  registry.replacePluginCommands(safe);
  return safe.length;
}
