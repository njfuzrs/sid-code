/**
 * 统一命令注册表
 *
 * 设计要点：
 * 1. loadAllCommands() 并行加载所有来源，结果按 cwd 缓存
 * 2. getCommands() 每次调用都重新过滤（isEnabled 可能变化、MCP 命令动态变化）
 * 3. 数组顺序即优先级：前面的来源可覆盖后面的同名命令
 *
 * 加载顺序（即优先级，前面覆盖后面）：
 * 1. 自定义命令（项目 > 用户，由 loader 内部排序）
 * 2. Skills（项目 > 用户 > 内置，由 SkillManager 内部排序）
 * 3. 内置命令（最低优先级）
 * 4. MCP 命令（动态合并，去重）
 */

import type { UnifiedCommand } from "./types.ts";
import {
  loadCustomCommands,
  loadSkillCommands,
  loadBuiltinCommands,
} from "./loaders.ts";
import type { ScanOptions } from "../extension/types.ts";
import { getLogger } from "../debug/logger.ts";

export interface UnifiedRegistryLoadOptions {
  scanOptions?: ScanOptions;
  disabledSkills?: string[];
}

export class UnifiedCommandRegistry {
  private cache = new Map<string, UnifiedCommand[]>();
  private loadOptions: UnifiedRegistryLoadOptions;

  constructor(loadOptions: UnifiedRegistryLoadOptions = {}) {
    this.loadOptions = loadOptions;
  }

  /**
   * 并行加载所有来源的命令（结果按 cwd 缓存）
   * 同名命令按数组顺序去重：前面的来源优先，后面的同名命令被丢弃
   */
  async loadAllCommands(cwd: string): Promise<UnifiedCommand[]> {
    const cached = this.cache.get(cwd);
    if (cached) return cached;

    const log = getLogger();
    const { scanOptions, disabledSkills } = this.loadOptions;

    const [customCommands, skills, builtinCommands] = await Promise.all([
      loadCustomCommands(cwd, scanOptions).catch((e) => {
        log.warn("COMMAND", `加载自定义命令失败: ${e?.message}`);
        return [] as UnifiedCommand[];
      }),
      loadSkillCommands(cwd, scanOptions, disabledSkills).catch((e) => {
        log.warn("COMMAND", `加载 Skill 命令失败: ${e?.message}`);
        return [] as UnifiedCommand[];
      }),
      loadBuiltinCommands().catch((e) => {
        log.warn("COMMAND", `加载内置命令失败: ${e?.message}`);
        return [] as UnifiedCommand[];
      }),
    ]);

    // 顺序即优先级：自定义 > Skills > 内置
    const merged = this.dedupe([
      ...customCommands,
      ...skills,
      ...builtinCommands,
    ]);

    this.cache.set(cwd, merged);
    log.info("COMMAND", `统一注册表加载完成: ${merged.length} 个命令`, {
      custom: customCommands.length,
      skill: skills.length,
      builtin: builtinCommands.length,
    });
    return merged;
  }

  /**
   * 获取当前可用的命令（每次调用都重新过滤）
   *
   * 为什么不缓存过滤结果？因为：
   * - isEnabled() 可能依赖运行时状态（如 feature flag）
   * - MCP 命令是动态的（服务器可能连接/断开）
   */
  async getCommands(
    cwd: string,
    mcpCommands?: UnifiedCommand[],
  ): Promise<UnifiedCommand[]> {
    const allCommands = await this.loadAllCommands(cwd);

    // 过滤：只保留当前启用的命令
    const filtered = allCommands.filter((cmd) =>
      cmd.isEnabled ? cmd.isEnabled() : true,
    );

    // 合并 MCP 命令（去重，已存在的名称不覆盖）
    if (mcpCommands && mcpCommands.length > 0) {
      const existingNames = new Set(filtered.map((c) => c.name));
      const uniqueMcp = mcpCommands.filter((c) => !existingNames.has(c.name));
      return [...filtered, ...uniqueMcp];
    }

    return filtered;
  }

  /** 按名称或别名查找命令（精确名称优先，其次别名） */
  findCommand(
    name: string,
    commands: UnifiedCommand[],
  ): UnifiedCommand | undefined {
    const exact = commands.find((c) => c.name === name);
    if (exact) return exact;
    return commands.find((c) => c.aliases?.includes(name));
  }

  /** 清除缓存（当命令来源变化时调用，如重新加载扩展） */
  clearCache(): void {
    this.cache.clear();
  }

  /** 按数组顺序去重（保留首次出现的，名称 + 别名都参与去重） */
  private dedupe(commands: UnifiedCommand[]): UnifiedCommand[] {
    const seen = new Set<string>();
    const result: UnifiedCommand[] = [];
    for (const cmd of commands) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      for (const alias of cmd.aliases ?? []) seen.add(alias);
      result.push(cmd);
    }
    return result;
  }
}
