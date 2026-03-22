/**
 * Hook 执行计划器
 * 匹配过滤、去重、决定串行/并行策略
 */

import type { HookRegistry, HookRegistryEntry } from "./registry.ts";
import { getHookKey, type HookExecutionPlan, type HookEventName } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 匹配上下文 */
export interface HookEventContext {
  toolName?: string;
  trigger?: string;
}

export class HookPlanner {
  private readonly registry: HookRegistry;

  constructor(registry: HookRegistry) {
    this.registry = registry;
  }

  /** 创建执行计划 */
  createExecutionPlan(eventName: HookEventName, context?: HookEventContext): HookExecutionPlan | null {
    const entries = this.registry.getHooksForEvent(eventName);
    if (entries.length === 0) return null;

    // 按 matcher 过滤
    const matching = entries.filter(e => this.matchesContext(e, context));
    if (matching.length === 0) return null;

    // 去重
    const deduped = this.deduplicateHooks(matching);

    // 提取配置
    const hookConfigs = deduped.map(e => e.config);

    // 任一 definition 标记 sequential=true → 整体串行
    const sequential = deduped.some(e => e.sequential === true);

    const log = getLogger();
    log.debug("HOOK", `执行计划 [${eventName}]: ${hookConfigs.length} 个 hook，${sequential ? "串行" : "并行"}`);

    return { eventName, hookConfigs, sequential };
  }

  /** 检查 hook 是否匹配上下文 */
  private matchesContext(entry: HookRegistryEntry, context?: HookEventContext): boolean {
    if (!entry.matcher || !context) return true;

    const matcher = entry.matcher.trim();
    if (matcher === "" || matcher === "*") return true;

    // 工具事件：匹配工具名
    if (context.toolName) {
      return this.matchesToolName(matcher, context.toolName);
    }

    // 生命周期事件：精确匹配 trigger
    if (context.trigger) {
      return matcher === context.trigger;
    }

    return true;
  }

  /** 匹配工具名（正则或精确） */
  private matchesToolName(matcher: string, toolName: string): boolean {
    // 兼容旧格式 /pattern/ 包裹
    let pattern = matcher;
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      pattern = pattern.slice(1, -1);
    }

    try {
      const regex = new RegExp(pattern);
      return regex.test(toolName);
    } catch {
      // 非法正则，当作精确匹配
      return matcher === toolName;
    }
  }

  /** 去重（相同 key 的 hook 只保留第一个） */
  private deduplicateHooks(entries: HookRegistryEntry[]): HookRegistryEntry[] {
    const seen = new Set<string>();
    const result: HookRegistryEntry[] = [];

    for (const entry of entries) {
      const key = getHookKey(entry.config);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(entry);
      }
    }

    return result;
  }
}
