/**
 * Hook 注册表
 * 多源加载（runtime/project/user/global）、验证、优先级排序、启用/禁用管理
 */

import { HookEventName, ConfigSource, type HookConfig } from "./types.ts";
import type { HooksConfig as LegacyHooksConfig } from "../config/config.ts";
import {
  normalizeHooksConfig,
  formatHookDiagnostic,
  type HookDiagnostic,
  type NormalizeContext,
} from "./config-normalize.ts";
import { getLogger } from "../debug/logger.ts";
import { ALL_HOOK_HANDLER_TYPES } from "./handler-types.ts";
import { isInternalRuntimeHook } from "./enterprise-policy.ts";

/**
 * H18：声明「可 block」的事件（与 types.ts 枚举注释一致，aggregator 对它们走一票否决）。
 * async hook 挂在这些事件上会静默失去阻塞能力，配置期要告警。
 */
const BLOCKING_EVENTS: ReadonlySet<HookEventName> = new Set([
  HookEventName.PreToolUse,
  HookEventName.UserPromptSubmit,
  HookEventName.BeforeModel,
  HookEventName.AfterModel,
  HookEventName.PreCompact,
  HookEventName.Stop,
  HookEventName.PermissionRequest,
  HookEventName.TeammateIdle,
]);

/** H21：有 tool_input 的事件——`if` 条件只在这些事件上能被判定（与 HookDefinition.if 文档一致） */
const TOOL_INPUT_EVENTS: ReadonlySet<HookEventName> = new Set([
  HookEventName.PreToolUse,
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
  HookEventName.PermissionRequest,
]);

/** 注册表条目 */
export interface HookRegistryEntry {
  config: HookConfig;
  source: ConfigSource;
  eventName: HookEventName;
  matcher?: string;
  /** G10：tool_input 细粒度条件（权限规则语法，仅工具事件生效） */
  if?: string;
  sequential?: boolean;
  enabled: boolean;
  /** 来源 Skill 名称（Skill 声明的会话级 hook） */
  skillName?: string;
  /**
   * P1-6：注册作用域 id（同一次 skill 调用注册的一批 hook 共用一个）。
   * 模型路径 / fork 路径「调用完就卸」必须按它精确删，否则会连带删掉 inline 路径
   * 注册、设计上要活到会话结束的同名 hooks。未设置 = 会话作用域。
   */
  hookScope?: string;
  /** 一次性 hook：被取用一次后自动失效 */
  once?: boolean;
  /** once hook 是否已被取用 */
  executed?: boolean;
}

export class HookRegistry {
  private entries: HookRegistryEntry[] = [];
  private eventIndex = new Map<HookEventName, number>();
  /** G13：企业策略门控（app 层注入 managed-settings 策略后设置）。未设置时不做任何过滤。 */
  private policyGate?: import("./enterprise-policy.ts").EnterprisePolicyGate;

  /** G13：注入企业策略门控（disableAllHooks / allowManagedHooksOnly 等）。 */
  setPolicyGate(gate: import("./enterprise-policy.ts").EnterprisePolicyGate | undefined): void {
    this.policyGate = gate;
  }

  /**
   * 从一份 hooks 配置初始化（settings 链、测试用）。保留已注册的 runtime / plugin hook。
   *
   * 形状解析全部委托给 config-normalize.ts（HC3：唯一转换器）。原先这里有自己的
   * convertLegacyHook，只认平铺形状，CC 嵌套形状整条跳过。
   * @returns 归一化诊断（调用方负责把它们送到启动横幅）
   */
  initializeFromLegacy(
    legacyHooks: LegacyHooksConfig,
    source: ConfigSource = ConfigSource.User,
  ): HookDiagnostic[] {
    return this.initializeFromSources([{ hooks: legacyHooks, source }]);
  }

  /**
   * HC1：按来源分层初始化。各层**按事件追加**、不互相替换（与 CC 一致），每条带真实 source。
   * 只清掉配置文件来源的旧条目：runtime（内部 / skill）与 plugin（replacePluginHooks 管）不动。
   */
  initializeFromSources(
    layers: Array<{ hooks: unknown; source: ConfigSource; ctx?: NormalizeContext }>,
  ): HookDiagnostic[] {
    this.entries = this.entries.filter(
      (e) => e.source === ConfigSource.Runtime || e.source === ConfigSource.Plugin,
    );
    this.rebuildEventIndex();
    const diagnostics: HookDiagnostic[] = [];
    for (const layer of layers) {
      diagnostics.push(...this.addNormalized(layer.hooks, layer.source, layer.ctx));
    }
    for (const d of diagnostics) {
      getLogger()[d.level === "error" ? "warn" : "debug"]("HOOK", formatHookDiagnostic(d));
    }
    getLogger().debug("HOOK", `注册表初始化完成，共 ${this.entries.length} 个 hook`);
    return diagnostics;
  }

  /**
   * 归一化一份 hooks 配置并注册到指定来源（插件 / skill / agent / settings 共用）。
   * @returns 归一化诊断
   */
  addNormalized(
    raw: unknown,
    source: ConfigSource,
    ctx?: NormalizeContext,
    meta?: { skillName?: string; hookScope?: string },
  ): HookDiagnostic[] {
    const { entries, diagnostics } = normalizeHooksConfig(raw, source, ctx);
    for (const n of entries) {
      if (!this.validateHookConfig(n.config, n.eventName)) continue;
      this.warnOnUnusableIf(n.eventName, n.if);
      this.entries.push({
        config: n.config,
        source,
        eventName: n.eventName,
        matcher: n.matcher,
        if: n.if,
        // H23：sequential 透传（原先硬编码 false）
        sequential: n.sequential === true,
        enabled: true,
        ...(meta?.skillName ? { skillName: meta.skillName } : {}),
        ...(meta?.hookScope ? { hookScope: meta.hookScope } : {}),
        ...(n.once ? { once: true, executed: false } : {}),
      });
      this.incrementEventIndex(n.eventName);
    }
    return diagnostics;
  }

  /**
   * H21：`if` 依赖 tool_input，配在非工具事件上永远不命中（planner 判不命中是对的，不该在无法判定时放行）。
   * 告警放在注册期而不是触发期：触发期打会每轮刷屏。语法错在触发期已有 warn，「用错事件」原先没有任何提示。
   */
  private warnOnUnusableIf(eventName: HookEventName, ifCond?: string): void {
    if (ifCond?.trim() && !TOOL_INPUT_EVENTS.has(eventName)) {
      getLogger().warn(
        "HOOK",
        `${eventName} 上的 hook 配了 if 条件 "${ifCond}"，但该事件没有 tool_input，if 永远不命中——` +
          `本条 hook 不会触发。if 只在 ${[...TOOL_INPUT_EVENTS].join(" / ")} 上生效`,
      );
    }
  }

  /** 编程式注册 hook */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; if?: string; sequential?: boolean; source?: ConfigSource },
  ): void {
    const source = options?.source ?? ConfigSource.Runtime;

    if (!this.validateHookConfig(config, eventName)) {
      throw new Error(`无效的 hook 配置: ${eventName} from ${source}`);
    }
    this.warnOnUnusableIf(eventName, options?.if);

    this.entries.push({
      config,
      source,
      eventName,
      matcher: options?.matcher,
      if: options?.if,
      sequential: options?.sequential,
      enabled: true,
    });
    this.incrementEventIndex(eventName);
  }

  /** O(1) 快速检查：该事件是否有任何已注册的 hook */
  hasHookForEvent(eventName: HookEventName): boolean {
    return (this.eventIndex.get(eventName) ?? 0) > 0;
  }

  /** 获取指定事件的所有 hook（已过滤禁用项和已执行的 once hook，按优先级排序） */
  getHooksForEvent(eventName: HookEventName): HookRegistryEntry[] {
    if (!this.hasHookForEvent(eventName)) return [];
    let entries = this.entries.filter(
      (e) => e.eventName === eventName && e.enabled && !(e.once && e.executed),
    );

    // G5：用户级 settings.json 的 disableAllHooks。与企业策略的同名字段是两个来源，
    // 任一为 true 即全禁用。放在企业门控之前：用户显式关了就不必再逐条问企业策略。
    // H28：「全部」只指用户可配置的 hook（command/url/prompt/agent）。type=runtime 只能由内部代码
    // 注册（settings / 插件都配不出来），承载的是轨迹采集、遥测探针、会话指标——原先一起被关，
    // 越是管得严的企业越拿不到自己的度量数据，而「采集停了」与「没人用」在数据上不可区分。
    if (userDisabledAllHooks()) {
      const kept = entries.filter(isInternalRuntimeHook);
      this.reportDisableAllHooks("用户 settings.json", entries.length - kept.length, kept.length);
      entries = kept;
    } else if (this.policyGate?.isDisabled) {
      const kept = entries.filter(isInternalRuntimeHook).length;
      this.reportDisableAllHooks("企业策略", entries.length - kept, kept);
    }

    // G13：企业策略门控——disableAllHooks / allowManagedHooksOnly / blockedCommands 等。
    // 门控读取 config.source，故过滤前把 entry.source 回填到 config.source（entry 与 config 分别存 source）。
    if (this.policyGate) {
      const gate = this.policyGate;
      entries = entries.filter((e) =>
        gate.isHookAllowed({ ...e.config, source: e.config.source ?? e.source }),
      );
    }

    return entries.sort(
      (a, b) => this.getSourcePriority(a.source) - this.getSourcePriority(b.source),
    );
  }

  /**
   * 注册 Skill 声明的会话级 hook（Task 7）
   * source 固定为 Runtime，附带 skillName / once 元数据。
   *
   * H11：会话隔离靠**实例边界**，不靠 sessionId——每个 App 构造一个 HookSystem（cli/app.ts），
   * 声明了 hooks 的子代理用 buildAgentHookSystem 另起一个实例。所以 entry 里刻意不存 sessionId。
   * 曾有一个按 sessionId 分桶的 SessionHookManager 承担同一职责，零调用，已删除；
   * 若将来同一个 HookSystem 要同时服务多个会话，要把 sessionId 补到这里，而不是再写一个管理器。
   */
  registerSessionHook(
    config: HookConfig,
    eventName: HookEventName,
    options: { matcher?: string; skillName: string; once?: boolean; scope?: string },
  ): void {
    if (!this.validateHookConfig(config, eventName)) {
      throw new Error(`无效的 Skill hook 配置: ${eventName} from skill:${options.skillName}`);
    }
    this.entries.push({
      config,
      source: ConfigSource.Runtime,
      eventName,
      matcher: options.matcher,
      enabled: true,
      skillName: options.skillName,
      hookScope: options.scope,
      once: options.once ?? false,
      executed: false,
    });
    this.incrementEventIndex(eventName);
  }

  /** 标记一个 once hook 为已执行（取用后调用） */
  markOnceExecuted(entry: HookRegistryEntry): void {
    if (!entry.once) return;
    const target = this.entries.find((e) => e === entry);
    if (target) target.executed = true;
  }

  /**
   * 移除指定 Skill 注册的会话级 hook
   *
   * @param scope 给定时只删该次调用注册的那一批（P1-6）；省略时删该 skill 的全部 hook
   *              （skill 卸载 / 会话级清理语义）。调用作用域的卸载**必须**传 scope。
   * @returns 移除的数量
   */
  removeSkillHooks(skillName: string, scope?: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.skillName !== skillName || (scope !== undefined && e.hookScope !== scope),
    );
    const removed = before - this.entries.length;
    if (removed > 0) this.rebuildEventIndex();
    return removed;
  }

  /** 获取所有 hook */
  getAllHooks(): HookRegistryEntry[] {
    return [...this.entries];
  }

  /** 启用/禁用 hook */
  setHookEnabled(hookName: string, enabled: boolean): void {
    const log = getLogger();
    let count = 0;
    for (const entry of this.entries) {
      if (this.getHookName(entry) === hookName) {
        entry.enabled = enabled;
        count++;
      }
    }
    if (count > 0) {
      log.info("HOOK", `${enabled ? "启用" : "禁用"} ${count} 个 hook: "${hookName}"`);
    } else {
      log.warn("HOOK", `未找到 hook: "${hookName}"`);
    }
  }

  /** 启用/禁用所有 hook */
  setAllEnabled(enabled: boolean): void {
    for (const entry of this.entries) {
      entry.enabled = enabled;
    }
  }

  /**
   * 移除指定来源的所有 hook（用于插件 hooks 原子交换）
   * @returns 移除的数量
   */
  removeBySource(source: ConfigSource): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.source !== source);
    const removed = before - this.entries.length;
    if (removed > 0) {
      this.rebuildEventIndex();
    }
    return removed;
  }

  /** H28：disableAllHooks 生效时说清影响范围（每个来源只报一次，避免每次派发刷屏） */
  private disableAllReported = new Set<string>();
  private reportDisableAllHooks(origin: string, disabled: number, keptInternal: number): void {
    if (this.disableAllReported.has(origin)) return;
    this.disableAllReported.add(origin);
    getLogger().info(
      "HOOK",
      `disableAllHooks 已生效（来源：${origin}）：本事件屏蔽 ${disabled} 个用户可配置 hook，` +
        `保留 ${keptInternal} 个内部 runtime hook（轨迹 / 遥测 / 会话指标，不受此开关影响）`,
    );
  }

  /** 获取 hook 名称 */
  getHookName(entry: HookRegistryEntry): string {
    const cfg = entry.config;
    if (cfg.name) return cfg.name;
    if (cfg.type === "command") return cfg.command;
    if (cfg.type === "url") return cfg.url;
    return "unknown-hook";
  }

  // ---- 私有方法 ----

  /** 验证 hook 配置 */
  private validateHookConfig(config: HookConfig, eventName: HookEventName): boolean {
    const log = getLogger();
    if (!config.type || !(ALL_HOOK_HANDLER_TYPES as readonly string[]).includes(config.type)) {
      log.warn("HOOK", `无效的 hook 类型: ${config.type} (事件: ${eventName})`);
      return false;
    }
    if (config.type === "command" && !config.command) {
      log.warn("HOOK", `command hook 缺少 command 字段 (事件: ${eventName})`);
      return false;
    }
    if (config.type === "url" && !config.url) {
      log.warn("HOOK", `url hook 缺少 url 字段 (事件: ${eventName})`);
      return false;
    }
    if (config.type === "runtime" && !config.name) {
      log.warn("HOOK", `runtime hook 缺少 name 字段 (事件: ${eventName})`);
      return false;
    }
    if (config.type === "prompt" && !config.prompt) {
      log.warn("HOOK", `prompt hook 缺少 prompt 字段 (事件: ${eventName})`);
      return false;
    }
    if (config.type === "agent" && !config.prompt) {
      log.warn("HOOK", `agent hook 缺少 prompt 字段 (事件: ${eventName})`);
      return false;
    }
    // H18：async 的定义就是不等结果，所以它的 exit 2 / deny 永远赶不上本轮决策。这是设计，
    // 但用户的心智是「async 只是不占时间」，实际语义是「放弃这个 hook 的一切决策权」——要说出来。
    // 只告警不拒绝：后台跑审计 / 通知是 async 的正当用法。
    if (config.type === "command" && config.async === true && BLOCKING_EVENTS.has(eventName)) {
      log.warn(
        "HOOK",
        `${eventName} 上的 async hook（${config.name ?? config.command.slice(0, 40)}）不能阻塞：` +
          `后台执行的结果赶不上本轮决策，exit 2 / deny 都不会生效。要拦截请去掉 async`,
      );
    }
    return true;
  }

  /** 配置源优先级（数字越小优先级越高） */
  private getSourcePriority(source: ConfigSource): number {
    switch (source) {
      case ConfigSource.Runtime:
        return 0;
      case ConfigSource.Managed:
        return 0;
      case ConfigSource.Local:
        return 1;
      case ConfigSource.Project:
        return 1;
      case ConfigSource.User:
        return 2;
      case ConfigSource.Plugin:
        return 3;
      case ConfigSource.Global:
        return 4;
      default:
        return 999;
    }
  }

  private incrementEventIndex(eventName: HookEventName): void {
    this.eventIndex.set(eventName, (this.eventIndex.get(eventName) ?? 0) + 1);
  }

  private rebuildEventIndex(): void {
    this.eventIndex.clear();
    for (const entry of this.entries) {
      this.incrementEventIndex(entry.eventName);
    }
  }
}

/**
 * G5：settings.json 的 disableAllHooks。读不到（配置系统未初始化或出错）时返回 false，
 * 不因配置故障把所有 hook 静默关掉。
 */
function userDisabledAllHooks(): boolean {
  try {
    const { getSettings } = require("../config/settings/settings.ts");
    return getSettings().settings.disableAllHooks === true;
  } catch {
    return false;
  }
}
