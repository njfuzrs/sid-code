/**
 * 命令来源加载器
 *
 * 每种来源有独立的加载逻辑，统一返回 UnifiedCommand[]：
 * - loadCustomCommands: .sid-code/commands/*.md（适配为 LocalCommand→submit_prompt）
 * - loadSkillCommands:  Skill 系统（适配为 PromptCommand）
 * - loadBuiltinCommands: 内置命令（已迁移的直接用，未迁移的通过 legacy 适配器）
 * - loadPluginCommands: 插件命令（带 pluginName: 前缀，适配为 LocalCommand）
 */

import type { UnifiedCommand, CommandSource } from "./types.ts";
import { adaptLegacyCommand } from "./adapter.ts";
import { skillToCommand } from "../skill/command-adapter.ts";
import type { ScanOptions } from "../extension/types.ts";
import { getLogger } from "../debug/logger.ts";

/** 加载自定义命令（.sid-code/commands/），适配为 UnifiedCommand */
export async function loadCustomCommands(
  cwd: string,
  scanOptions?: ScanOptions,
): Promise<UnifiedCommand[]> {
  const { CustomCommandLoader } = await import("./custom.ts");
  const loader = new CustomCommandLoader();
  const customCmds = await loader.loadAll(cwd, scanOptions);
  return customCmds.map(({ cmd, source }) =>
    adaptLegacyCommand(cmd, source as CommandSource),
  );
}

/** 加载 Skills，适配为 PromptCommand */
export async function loadSkillCommands(
  cwd: string,
  scanOptions?: ScanOptions,
  disabledSkills?: string[],
): Promise<UnifiedCommand[]> {
  const { SkillManager } = await import("../skill/manager.ts");
  const manager = new SkillManager();
  await manager.discover(cwd, scanOptions);
  if (disabledSkills && disabledSkills.length > 0) {
    manager.setDisabledSkills(disabledSkills);
  }
  const diskSkills = manager.getSkills().map((skill) => skillToCommand(skill));

  // 合并 Bundled Skill（编译时内置，优先级高于磁盘同名 Skill）
  let bundled: UnifiedCommand[] = [];
  try {
    const { loadBundledSkills } = await import("../skill/bundled/index.ts");
    bundled = loadBundledSkills();
    // 与磁盘 Skill 同口径：bundled 也要 honor disabledSkills，否则禁用
    // /simplify /verify /commit /pr* 等 bundled skill 是空操作（面板/命令仍在）。
    if (disabledSkills && disabledSkills.length > 0) {
      const disabledSet = new Set(disabledSkills.map((n) => n.toLowerCase()));
      bundled = bundled.filter((cmd) => !disabledSet.has(cmd.name.toLowerCase()));
    }
  } catch (err: any) {
    getLogger().debug("COMMAND", `加载 Bundled Skill 失败: ${err?.message}`);
  }

  // Bundled 在前（优先），磁盘 Skill 在后；上层 dedupe 保留首次出现
  return [...bundled, ...diskSkills];
}

/**
 * 加载内置命令
 *
 * 渐进式迁移：已迁移到 commands/ 目录的命令直接以 UnifiedCommand 返回，
 * 未迁移的命令通过临时 Registry + adaptLegacyCommand 桥接。
 */
export async function loadBuiltinCommands(): Promise<UnifiedCommand[]> {
  const log = getLogger();

  // 1. 已迁移的命令（延迟加载，定义在 commands/ 目录）
  let migrated: UnifiedCommand[] = [];
  try {
    const { BUILTIN_COMMANDS } = await import("./commands/index.ts");
    migrated = BUILTIN_COMMANDS;
  } catch (err: any) {
    log.debug("COMMAND", `commands/ 目录尚未就绪: ${err?.message}`);
  }
  const migratedNames = new Set(migrated.map((c) => c.name));

  // 2. 未迁移的命令通过 legacy Registry 桥接
  const { Registry } = await import("./registry.ts");
  const { registerBuiltins } = await import("./builtins.ts");
  const legacyRegistry = new Registry();
  await registerBuiltins(legacyRegistry);

  const legacyAdapted = legacyRegistry
    .all()
    // 已迁移的不再用 legacy 版本（避免重复，且新版本优先）
    .filter((cmd) => !migratedNames.has(cmd.name()))
    .map((cmd) => adaptLegacyCommand(cmd, "builtin"));

  return [...migrated, ...legacyAdapted];
}

/**
 * 加载插件命令，适配为 UnifiedCommand
 *
 * 插件命令是动态来源（可通过 /reload-plugins 刷新），其底层加载（getPluginCommands）
 * 自带 memoize 缓存，清缓存由 clearAllPluginCaches 负责。因此本函数本身不缓存，
 * 由调用方（UnifiedCommandRegistry）决定何时重新调用以拿到最新插件命令。
 *
 * 插件命令名自带 pluginName: 前缀，天然与内置/自定义命令隔离。
 */
export async function loadPluginCommands(): Promise<UnifiedCommand[]> {
  try {
    const { getPluginCommands } = await import("../plugin/loadPluginCommands.ts");
    const pluginCmds = await getPluginCommands();
    return pluginCmds.map((cmd) => adaptLegacyCommand(cmd, "plugin"));
  } catch (err: any) {
    getLogger().debug("COMMAND", `加载插件命令失败: ${err?.message}`);
    return [];
  }
}
