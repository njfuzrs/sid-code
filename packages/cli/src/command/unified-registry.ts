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
  loadPluginCommands,
} from "./loaders.ts";
import type { ScanOptions } from "@sid-code/core/extension/types.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

export interface UnifiedRegistryLoadOptions {
  scanOptions?: ScanOptions;
  disabledSkills?: string[];
  /**
   * 共享 SkillManager（强烈建议注入）。
   *
   * 不注入时 loadSkillCommands 会自建一个 SkillManager 重扫磁盘，导致：
   *   - 插件 skills / MCP skills（运行时 addPluginSkills 追加的）在斜杠命令里不可见；
   *   - 条件激活 gate 态、/skills disable 态、热重载结果与主 manager 分叉；
   *   - 同一份 SKILL.md 被解析两遍（启动期多余 IO）。
   * 由 cli.ts 注入启动时创建的那一个 manager，使模型路径（SkillMetaTool）与
   * 用户斜杠路径（UnifiedCommandRegistry）共用同一份 skill 真源。
   */
  skillManager?: import("@sid-code/core/skill/manager.ts").SkillManager;
}

export class UnifiedCommandRegistry {
  private cache = new Map<string, UnifiedCommand[]>();
  private loadOptions: UnifiedRegistryLoadOptions;
  /**
   * 插件命令（动态来源，独立于 cwd 缓存）。
   *
   * 为什么不进 cwd 缓存：插件命令可通过 /reload-plugins 在运行时刷新，
   * 与 cwd 无关。这里维护一份独立快照，loadPlugins/reloadPlugins 时更新，
   * getCommands 时合并。优先级低于内置命令（pluginName: 前缀天然隔离，不会冲突）。
   */
  private pluginCommands: UnifiedCommand[] = [];

  /** 命令集合变更订阅者（P1-2，见 onCommandsChanged） */
  private changeListeners: Array<() => void> = [];

  constructor(loadOptions: UnifiedRegistryLoadOptions = {}) {
    this.loadOptions = loadOptions;
  }

  /**
   * 订阅命令集合变更（P1-2）。
   *
   * 动机：补全菜单与 /help 读的是 `TUIState.commands`，那份 state 修复前
   * **全仓只被赋值一次**（启动时 await 一次 loadCommandList），此后没有任何路径会更新它。
   * 于是注册表这边的动态来源全部在补全里失效：MCP 中途连上/断开、`/reload-plugins`
   * 热更新、`/skills` 禁用某 skill —— `getCommands` 都会正确反映，**补全菜单看不到**。
   * 执行路径是好的（每次执行都重新 getCommands），所以症状是「盲敲全名能跑，
   * 但补全里找不到」，表现为"这个功能好像不支持"而不是"有个 bug"。
   *
   * 为什么做成广播而不是"在每个变更点各自记得刷一次"：后者靠人记，第五个变更点
   * 出现时会漏，而漏掉不会有任何东西报错（补全少一条命令没人会红）。让**唯一持有
   * 变更事实的一方**主动广播，消费侧订阅即可 —— 与 SkillManager.onSkillsChanged 同构。
   *
   * @returns 取消订阅函数
   */
  onCommandsChanged(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  /**
   * 外部来源发生变更时手动广播（P1-2）。
   *
   * 用于**不进本注册表缓存**的动态来源：MCP prompt 命令由 getCommands 的
   * `mcpCommands` 参数每次现场传入（见 mcp-prompt-commands.ts），所以它变了
   * 不需要清缓存，只需把"变了"这件事转发给订阅方。
   * 由 cli.ts 接到 `MCPManager.onPromptsChanged` 上。
   */
  notifyExternalChange(): void {
    this.notifyCommandsChanged();
  }

  /** 广播命令集合变更（监听器异常不影响其他监听器与主流程） */
  private notifyCommandsChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        getLogger().debug(
          "COMMAND",
          `命令变更监听器异常（忽略）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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
      loadSkillCommands(cwd, scanOptions, disabledSkills, this.loadOptions.skillManager).catch(
        (e) => {
          log.warn("COMMAND", `加载 Skill 命令失败: ${e?.message}`);
          return [] as UnifiedCommand[];
        },
      ),
      loadBuiltinCommands().catch((e) => {
        log.warn("COMMAND", `加载内置命令失败: ${e?.message}`);
        return [] as UnifiedCommand[];
      }),
    ]);

    // 顺序即优先级：自定义 > Skills > 内置
    const merged = this.dedupe([...customCommands, ...skills, ...builtinCommands]);

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
  async getCommands(cwd: string, mcpCommands?: UnifiedCommand[]): Promise<UnifiedCommand[]> {
    const allCommands = await this.loadAllCommands(cwd);

    // 过滤：只保留当前启用的命令
    const filtered = allCommands.filter((cmd) => (cmd.isEnabled ? cmd.isEnabled() : true));

    // 合并插件命令（动态来源，去重；pluginName: 前缀天然不与内置/自定义冲突）
    const existingNames = new Set(filtered.map((c) => c.name));
    const merged: UnifiedCommand[] = [...filtered];
    for (const pc of this.pluginCommands) {
      if (existingNames.has(pc.name)) continue;
      existingNames.add(pc.name);
      merged.push(pc);
    }

    // 合并 MCP 命令（去重，已存在的名称不覆盖）
    if (mcpCommands && mcpCommands.length > 0) {
      for (const mc of mcpCommands) {
        if (existingNames.has(mc.name)) continue;
        existingNames.add(mc.name);
        merged.push(mc);
      }
    }

    return merged;
  }

  /**
   * 加载插件命令到独立快照（首次加载，幂等可重复调用）。
   * 由应用启动时调用一次；运行时刷新走 reloadPlugins。
   */
  async loadPlugins(): Promise<number> {
    this.pluginCommands = await loadPluginCommands();
    getLogger().info("COMMAND", `插件命令加载完成: ${this.pluginCommands.length} 个`);
    // P1-2：启动期也广播 —— 首屏 state 是在 loadPlugins 之后 await 填入的，
    // 这次广播通常没有订阅者，但不能靠"启动顺序恰好如此"来保证正确性。
    this.notifyCommandsChanged();
    return this.pluginCommands.length;
  }

  /**
   * 重新加载插件命令（/reload-plugins 用）。
   *
   * 前置条件：调用方需先执行 clearAllPluginCaches() 清除底层 getPluginCommands
   * 的 memoize 缓存（由 refreshActivePlugins 负责），否则这里拿到的仍是旧快照。
   * 本方法只负责把刷新后的插件命令重新拉取进注册表快照。
   */
  async reloadPlugins(): Promise<number> {
    this.pluginCommands = await loadPluginCommands();
    getLogger().info("COMMAND", `插件命令已重新加载: ${this.pluginCommands.length} 个`);
    // P1-2：广播给补全菜单等消费方，否则 /reload-plugins 装上的新命令在补全里看不见。
    this.notifyCommandsChanged();
    return this.pluginCommands.length;
  }

  /** 按名称或别名查找命令（精确名称优先，其次别名） */
  findCommand(name: string, commands: UnifiedCommand[]): UnifiedCommand | undefined {
    const exact = commands.find((c) => c.name === name);
    if (exact) return exact;
    return commands.find((c) => c.aliases?.includes(name));
  }

  /** 清除缓存（当命令来源变化时调用，如重新加载扩展） */
  clearCache(): void {
    this.cache.clear();
    // P1-2：清缓存本身就意味着"命令集合可能变了"，一并广播。
    this.notifyCommandsChanged();
  }

  /**
   * skill 集合发生运行时变化后刷新斜杠命令（插件 skills 加载、MCP skills 发现、
   * 动态发现、热重载、gate 解除等）。
   *
   * 为什么必须显式调用：loadAllCommands 结果按 cwd 缓存，共享 SkillManager 里
   * 新追加的 skill 不会自动出现在缓存快照里——用户会看到 `/plugin:skill` 提示
   * "未知命令"。这里只清缓存，下次 getCommands 会从共享 manager 重新投影。
   */
  invalidateSkillCommands(): void {
    this.cache.clear();
    this.notifyCommandsChanged();
  }

  /**
   * 运行时更新禁用 Skill 列表（/skills 面板行内启用/禁用用）。
   *
   * 构造时的 disabledSkills 是一份静态快照，运行时改配置不会自动生效。
   * 本方法更新快照并清 cwd 缓存 —— 下次 loadAllCommands 会带新列表重新加载，
   * 磁盘 Skill 的 isEnabled: () => !skill.disabled 与 bundled 过滤同步反映新状态，
   * 命令补全 / skill 工具随之更新，无需重启。
   */
  setDisabledSkills(names: string[]): void {
    this.loadOptions.disabledSkills = names;
    this.cache.clear();
    this.notifyCommandsChanged();
  }

  /**
   * 按数组顺序去重（保留首次出现的，名称 + 别名都参与去重）。
   *
   * P0-3 别名冲突检测：区分两种"占用"——
   *   1. 命令名 dedupe（同名命令，后者被优先级更高的前者覆盖）——正常，debug 级。
   *   2. 别名碰撞（某命令的别名已被别的命令名/别名占用）——静默劫持风险，warn 级 +
   *      **确定性保留先注册者**（丢弃后写别名，get() 落到先注册命令，不再 last-write-wins）。
   * 记录首个占用者，便于告警定位。
   */
  private dedupe(commands: UnifiedCommand[]): UnifiedCommand[] {
    const log = getLogger();
    // token → 首个占用它的命令名（用于告警时指认"被谁占用"）
    const owner = new Map<string, string>();
    const result: UnifiedCommand[] = [];
    for (const cmd of commands) {
      if (owner.has(cmd.name)) continue; // 同名命令：优先级更高的已在，丢弃本条
      owner.set(cmd.name, cmd.name);
      for (const alias of cmd.aliases ?? []) {
        const existing = owner.get(alias);
        if (existing && existing !== cmd.name) {
          // 别名碰撞：该别名已被 existing 占用 → 保留先注册者，告警提示本命令该别名被忽略
          log.warn(
            "COMMAND",
            `别名冲突: /${alias} 已被 "${existing}" 占用，"${cmd.name}" 的该别名被忽略`,
          );
          continue;
        }
        if (!existing) owner.set(alias, cmd.name);
      }
      result.push(cmd);
    }
    return result;
  }
}
