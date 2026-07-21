/**
 * 命令注册表
 * 管理所有已注册的斜杠命令，支持通过名称或别名查找
 * 内置命令不可被覆盖；自定义命令与内置命令同名时加前缀（user./project.）
 */

import type { Command } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

export type CommandSource = "builtin" | "user" | "project" | "plugin";

export class Registry {
  private commands = new Map<string, Command>();
  private aliasMap = new Map<string, Command>();
  private commandSources = new Map<string, CommandSource>();

  /**
   * 注册别名，冲突时保留先注册者（确定性），拒绝 last-write-wins 静默覆盖。
   * P0-3：aliasMap.has(alias) 且指向不同命令 → warn 并跳过，不覆盖。
   */
  private registerAlias(alias: string, cmd: Command): void {
    const existing = this.aliasMap.get(alias);
    if (existing && existing !== cmd) {
      getLogger().warn(
        "COMMAND",
        `别名冲突: /${alias} 已被 "${existing.name()}" 占用，"${cmd.name()}" 的该别名被忽略`,
      );
      return;
    }
    this.aliasMap.set(alias, cmd);
  }

  /** 注册一个命令及其所有别名 */
  register(cmd: Command, source: CommandSource = "builtin"): void {
    const log = getLogger();

    if (source === "builtin") {
      this.commands.set(cmd.name(), cmd);
      this.commandSources.set(cmd.name(), "builtin");
      for (const alias of cmd.aliases()) {
        this.registerAlias(alias, cmd);
      }
      return;
    }

    // 检查是否与内置命令冲突
    const existingSource = this.commandSources.get(cmd.name());
    if (existingSource === "builtin") {
      // 加前缀避免覆盖内置命令
      const prefixedName = `${source}.${cmd.name()}`;
      // 创建带前缀名称的包装命令
      const prefixed = wrapWithName(cmd, prefixedName);
      this.commands.set(prefixedName, prefixed);
      this.commandSources.set(prefixedName, source);
      log.warn("COMMAND", `自定义命令 "/${cmd.name()}" 与内置命令冲突，已重命名为 "/${prefixedName}"`);
      return;
    }

    // 项目级覆盖用户级（同名时直接覆盖，无需前缀）
    this.commands.set(cmd.name(), cmd);
    this.commandSources.set(cmd.name(), source);
    for (const alias of cmd.aliases()) {
      this.registerAlias(alias, cmd);
    }
  }

  /** 根据名称或别名查找命令，支持子命令路径（如 "mcp list"） */
  get(name: string): Command | undefined {
    const parts = name.trim().split(/\s+/);

    // 查找顶级命令
    let current: Command | undefined = this.commands.get(parts[0]) ?? this.aliasMap.get(parts[0]);
    if (!current) return undefined;

    // 如果只有一个部分，直接返回
    if (parts.length === 1) return current;

    // 查找子命令
    for (let i = 1; i < parts.length; i++) {
      const subs: Command[] = current.subCommands?.() ?? [];
      const found: Command | undefined = subs.find((c: Command) =>
        c.name() === parts[i] || c.aliases().includes(parts[i])
      );

      if (!found) {
        // 子命令不存在，返回父命令（让父命令处理参数）
        return current;
      }

      current = found;
    }

    return current;
  }

  /** 返回所有已注册的命令（不含别名重复） */
  all(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * 原子替换所有插件命令（source=plugin）。
   *
   * 插件命令名自带 pluginName: 前缀，天然与内置/用户命令隔离，因此直接按 source
   * 清除旧的再注册新的。内置命令永远不会被插件命令覆盖（前缀不同）。
   */
  replacePluginCommands(commands: Command[]): void {
    // 1. 清除所有 source=plugin 的旧命令
    for (const [name, src] of this.commandSources) {
      if (src === "plugin") {
        const cmd = this.commands.get(name);
        this.commands.delete(name);
        this.commandSources.delete(name);
        // 清理别名
        if (cmd) {
          for (const alias of cmd.aliases()) {
            if (this.aliasMap.get(alias) === cmd) this.aliasMap.delete(alias);
          }
        }
      }
    }

    // 2. 注册新插件命令（前缀保证不与内置冲突）
    for (const cmd of commands) {
      this.commands.set(cmd.name(), cmd);
      this.commandSources.set(cmd.name(), "plugin");
      for (const alias of cmd.aliases()) {
        this.aliasMap.set(alias, cmd);
      }
    }
  }
}

/** 创建一个名称被覆盖的命令包装器 */
function wrapWithName(cmd: Command, newName: string): Command {
  return {
    name: () => newName,
    aliases: () => [],
    description: cmd.description.bind(cmd),
    execute: cmd.execute.bind(cmd),
  };
}
