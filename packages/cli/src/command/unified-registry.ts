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
 * 4. 插件 / MCP 命令（动态来源，getCommands 时与上面三类一起再过一次 dedupe）
 *
 * 保护命令名（D7）：非 builtin 来源占用保护名（名字或别名）一律在 dedupe 里拦下并 warn，
 * 所有来源共用这一个检查点。
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
import { isProtectedCommandName } from "@sid-code/core/command-contract/protected-names.ts";

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
   * getCommands 时合并。优先级低于内置命令；pluginName: 前缀只是约定不是结构，
   * 碰撞统一交给 dedupe（D9）。
   */
  private pluginCommands: UnifiedCommand[] = [];

  /**
   * 已发出过的碰撞告警（D9）。getCommands 在补全热路径上每次都会对动态来源再跑一次
   * dedupe，同一个碰撞不去重就会刷屏；按消息文本只报一次。
   */
  private warnedCollisions = new Set<string>();

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

    // D9：插件 / MCP 与静态来源走**同一个 dedupe**。
    //
    // 修复前这里另起一套合并，`existingNames` 只装 c.name 不装别名 —— 于是一个名叫 `q`
    // 的插件 / MCP 命令能进列表，而 findCommand「精确 name 优先于别名」会让 `/q` 落到它
    // 身上（exit 的别名被静默劫持，UI 层只前置拦截字面 exit/quit）。两套合并对同一个问题
    // 给出两种答案；共用 dedupe 后六个来源一套碰撞规则，并自动获得别名碰撞 warn 与保护名检查。
    // 成本：命令量级几十到上百，dedupe 是 O(n·别名数) 的一次 Map 扫描。
    const dynamic = [...this.pluginCommands, ...(mcpCommands ?? [])];
    if (dynamic.length === 0) return filtered;
    const merged = this.dedupe([...filtered, ...dynamic]);
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
   *
   * W1：必须同步共享 SkillManager。磁盘 skill 的 disabled 态长在 manager 上，
   * 而 loadSkillCommands 只在「没传 manager」的分支里调 setDisabledSkills ——
   * 生产环境总传共享 manager，那个分支永不进，旧实现只更新快照 = 磁盘 skill 禁用是空操作
   * （面板显示已禁用，/<skill> 与模型经 Skill 工具仍可调用）。
   */
  setDisabledSkills(names: string[]): void {
    this.loadOptions.disabledSkills = names;
    this.loadOptions.skillManager?.setDisabledSkills(names);
    this.cache.clear();
    this.notifyCommandsChanged();
  }

  /**
   * 按数组顺序去重（保留首次出现的，名称 + 别名都参与去重）。
   *
   * 所有来源（自定义 / Skill / 内置 / 插件 / MCP）的唯一汇聚点，因此三条规则都放在这里，
   * 而不是写进各个 loader（写 N 遍，第 N+1 个来源出现时必漏）：
   *
   *   0. D7 保护名：非 builtin 来源的**命令名**命中保护名单 → 整条丢弃 + warn；
   *      非 builtin 来源的**别名**命中保护名单 → 丢该别名 + warn。必须 warn 不能静默，
   *      否则用户看到的症状是「我的 skill 怎么不生效」。
   *   1. 命令名 dedupe（同名命令，后者被优先级更高的前者覆盖）—— 正常，debug 级。
   *      D9：命令名撞上**已被占用的别名**同样丢弃 + warn（否则 findCommand 的
   *      「精确 name 优先」会让后来者劫持那个别名）。
   *   2. 别名碰撞（某命令的别名已被别的命令名/别名占用）—— warn 级 +
   *      **确定性保留先注册者**（丢弃后写别名，不再 last-write-wins）。
   */
  private dedupe(commands: UnifiedCommand[]): UnifiedCommand[] {
    const log = {
      warn: (category: string, message: string) => {
        if (this.warnedCollisions.has(message)) return;
        this.warnedCollisions.add(message);
        getLogger().warn(category, message);
      },
    };
    // token → 首个占用它的命令名（用于告警时指认"被谁占用"）
    const owner = new Map<string, string>();
    // 被别名（而非命令名）占用的 token，用于区分「同名覆盖」与「名字劫持别名」
    const aliasTokens = new Set<string>();
    const result: UnifiedCommand[] = [];
    for (const cmd of commands) {
      const isBuiltin = cmd.source === "builtin";
      if (!isBuiltin && isProtectedCommandName(cmd.name)) {
        log.warn(
          "COMMAND",
          `保护命令名被忽略: ${cmd.source ?? "unknown"} 来源的 "${cmd.name}" 不能占用 /${cmd.name}（内置逃生通道）`,
        );
        continue;
      }
      if (owner.has(cmd.name)) {
        if (aliasTokens.has(cmd.name)) {
          log.warn(
            "COMMAND",
            `命令名冲突: /${cmd.name} 已是 "${owner.get(cmd.name)}" 的别名，${cmd.source ?? "unknown"} 来源的 "${cmd.name}" 被忽略`,
          );
        }
        continue; // 同名命令：优先级更高的已在，丢弃本条
      }
      owner.set(cmd.name, cmd.name);
      let aliases = cmd.aliases;
      for (const alias of cmd.aliases ?? []) {
        let drop = false;
        if (!isBuiltin && isProtectedCommandName(alias)) {
          log.warn(
            "COMMAND",
            `保护命令名被忽略: "${cmd.name}"（${cmd.source ?? "unknown"}）的别名 /${alias} 是内置逃生通道`,
          );
          drop = true;
        } else {
          const existing = owner.get(alias);
          if (existing && existing !== cmd.name) {
            log.warn(
              "COMMAND",
              `别名冲突: /${alias} 已被 "${existing}" 占用，"${cmd.name}" 的该别名被忽略`,
            );
            drop = true;
          } else if (!existing) {
            owner.set(alias, cmd.name);
            aliasTokens.add(alias);
          }
        }
        if (drop) aliases = (aliases ?? []).filter((a) => a !== alias);
      }
      // 别名被丢弃时同步从命令对象上摘掉，否则 findCommand 的别名回退仍会命中它。
      result.push(aliases === cmd.aliases ? cmd : { ...cmd, aliases });
    }
    return result;
  }
}
