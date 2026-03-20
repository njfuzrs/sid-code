/**
 * 命令注册表
 * 管理所有已注册的斜杠命令，支持通过名称或别名查找
 * 内置命令不可被覆盖；自定义命令与内置命令同名时加前缀（user./project.）
 */

import type { Command } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

export type CommandSource = "builtin" | "user" | "project";

export class Registry {
  private commands = new Map<string, Command>();
  private aliasMap = new Map<string, Command>();
  private commandSources = new Map<string, CommandSource>();

  /** 注册一个命令及其所有别名 */
  register(cmd: Command, source: CommandSource = "builtin"): void {
    const log = getLogger();

    if (source === "builtin") {
      this.commands.set(cmd.name(), cmd);
      this.commandSources.set(cmd.name(), "builtin");
      for (const alias of cmd.aliases()) {
        this.aliasMap.set(alias, cmd);
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
      this.aliasMap.set(alias, cmd);
    }
  }

  /** 根据名称或别名查找命令 */
  get(name: string): Command | undefined {
    return this.commands.get(name) ?? this.aliasMap.get(name);
  }

  /** 返回所有已注册的命令（不含别名重复） */
  all(): Command[] {
    return Array.from(this.commands.values());
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
