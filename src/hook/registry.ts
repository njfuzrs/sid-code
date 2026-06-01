/**
 * Hook 注册表
 * 多源加载（runtime/project/user/global）、验证、优先级排序、启用/禁用管理
 */

import {
  HookEventName,
  ConfigSource,
  LEGACY_EVENT_MAP,
  type HookConfig,
  type NewHooksConfig,
} from "./types.ts";
import type { HooksConfig as LegacyHooksConfig, HookConfig as LegacyHookConfig } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";

/** 注册表条目 */
export interface HookRegistryEntry {
  config: HookConfig;
  source: ConfigSource;
  eventName: HookEventName;
  matcher?: string;
  sequential?: boolean;
  enabled: boolean;
}

export class HookRegistry {
  private entries: HookRegistryEntry[] = [];
  private eventIndex = new Map<HookEventName, number>();

  /** 从旧格式配置初始化（向后兼容） */
  initializeFromLegacy(legacyHooks: LegacyHooksConfig): void {
    const log = getLogger();
    // 保留已有的 runtime hook
    const runtimeEntries = this.entries.filter(e => e.source === ConfigSource.Runtime);
    this.entries = [...runtimeEntries];
    this.rebuildEventIndex();

    for (const [eventKey, hookList] of Object.entries(legacyHooks)) {
      if (!hookList || !Array.isArray(hookList) || hookList.length === 0) continue;

      // 解析事件名（支持旧 snake_case 和新 PascalCase）
      const eventName = this.resolveEventName(eventKey);
      if (!eventName) {
        log.warn("HOOK", `无效的事件名: "${eventKey}"，跳过`);
        continue;
      }

      for (const legacyHook of hookList) {
        const config = this.convertLegacyHook(legacyHook);
        if (!config) continue;

        if (!this.validateHookConfig(config, eventName)) continue;

        this.entries.push({
          config,
          source: ConfigSource.User,
          eventName,
          matcher: legacyHook.matcher,
          sequential: false,
          enabled: true,
        });
        this.incrementEventIndex(eventName);
      }
    }

    log.debug("HOOK", `注册表初始化完成，共 ${this.entries.length} 个 hook`);
  }

  /** 从新格式配置初始化 */
  initializeFromNew(newHooks: NewHooksConfig, source: ConfigSource = ConfigSource.User): void {
    const log = getLogger();

    for (const [eventName, definitions] of Object.entries(newHooks)) {
      if (!definitions || !Array.isArray(definitions)) continue;

      const resolvedEvent = this.resolveEventName(eventName);
      if (!resolvedEvent) {
        log.warn("HOOK", `无效的事件名: "${eventName}"，跳过`);
        continue;
      }

      for (const def of definitions) {
        if (!def || typeof def !== "object" || !Array.isArray(def.hooks)) {
          log.warn("HOOK", `无效的 hook 定义: ${JSON.stringify(def)?.slice(0, 100)}`);
          continue;
        }

        for (const hookConfig of def.hooks) {
          if (!this.validateHookConfig(hookConfig, resolvedEvent)) continue;

          hookConfig.source = source;
          this.entries.push({
            config: hookConfig,
            source,
            eventName: resolvedEvent,
            matcher: def.matcher,
            sequential: def.sequential,
            enabled: true,
          });
          this.incrementEventIndex(resolvedEvent);
        }
      }
    }
  }

  /** 编程式注册 hook */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean; source?: ConfigSource },
  ): void {
    const source = options?.source ?? ConfigSource.Runtime;

    if (!this.validateHookConfig(config, eventName)) {
      throw new Error(`无效的 hook 配置: ${eventName} from ${source}`);
    }

    this.entries.push({
      config,
      source,
      eventName,
      matcher: options?.matcher,
      sequential: options?.sequential,
      enabled: true,
    });
    this.incrementEventIndex(eventName);
  }

  /** O(1) 快速检查：该事件是否有任何已注册的 hook */
  hasHookForEvent(eventName: HookEventName): boolean {
    return (this.eventIndex.get(eventName) ?? 0) > 0;
  }

  /** 获取指定事件的所有 hook（已过滤禁用项，按优先级排序） */
  getHooksForEvent(eventName: HookEventName): HookRegistryEntry[] {
    if (!this.hasHookForEvent(eventName)) return [];
    return this.entries
      .filter(e => e.eventName === eventName && e.enabled)
      .sort((a, b) => this.getSourcePriority(a.source) - this.getSourcePriority(b.source));
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

  /** 获取 hook 名称 */
  getHookName(entry: HookRegistryEntry): string {
    const cfg = entry.config;
    if (cfg.name) return cfg.name;
    if (cfg.type === "command") return cfg.command;
    if (cfg.type === "url") return cfg.url;
    return "unknown-hook";
  }

  // ---- 私有方法 ----

  /** 解析事件名（支持旧 snake_case 和新 PascalCase） */
  private resolveEventName(name: string): HookEventName | null {
    // 直接匹配 PascalCase
    const values = Object.values(HookEventName);
    if (values.includes(name as HookEventName)) {
      return name as HookEventName;
    }
    // 旧 snake_case 映射
    if (name in LEGACY_EVENT_MAP) {
      return LEGACY_EVENT_MAP[name];
    }
    return null;
  }

  /** 将旧格式 HookConfig 转换为新格式 */
  private convertLegacyHook(legacy: LegacyHookConfig): HookConfig | null {
    const type = legacy.type || "command";
    if (type === "url") {
      if (!legacy.url) return null;
      return {
        type: "url",
        name: legacy.command ? undefined : undefined,
        url: legacy.url,
        method: legacy.method,
        headers: legacy.headers,
        timeout: legacy.timeout,
      };
    }
    // command
    if (!legacy.command) return null;
    return {
      type: "command",
      command: legacy.command,
      timeout: legacy.timeout,
    };
  }

  /** 验证 hook 配置 */
  private validateHookConfig(config: HookConfig, eventName: HookEventName): boolean {
    const log = getLogger();
    if (!config.type || !["command", "url", "runtime", "prompt", "agent"].includes(config.type)) {
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
    return true;
  }

  /** 配置源优先级（数字越小优先级越高） */
  private getSourcePriority(source: ConfigSource): number {
    switch (source) {
      case ConfigSource.Runtime: return 0;
      case ConfigSource.Project: return 1;
      case ConfigSource.User: return 2;
      case ConfigSource.Global: return 3;
      default: return 999;
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
