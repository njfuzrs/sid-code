/**
 * 命令注册表
 * 管理所有已注册的斜杠命令，支持通过名称或别名查找
 */

import type { Command } from "./types.ts";

export class Registry {
  private commands = new Map<string, Command>();
  private aliasMap = new Map<string, Command>();

  /** 注册一个命令及其所有别名 */
  register(cmd: Command): void {
    this.commands.set(cmd.name(), cmd);
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
