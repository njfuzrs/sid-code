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
  /** G10：工具输入，供 `if` 条件（权限规则语法）做 tool_input 级过滤 */
  toolInput?: Record<string, unknown>;
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

    // entries 与 hookConfigs 下标一一对应：执行后据此回标 once hook 已执行（否则 once 永不失效）
    return { eventName, hookConfigs, sequential, entries: deduped };
  }

  /** 检查 hook 是否匹配上下文（matcher 工具名 + G10 的 if tool_input 条件） */
  private matchesContext(entry: HookRegistryEntry, context?: HookEventContext): boolean {
    // 先做工具名/trigger 层的 matcher 过滤
    if (!this.matchesMatcher(entry, context)) return false;
    // 再做 G10 的 if 条件（tool_input 细粒度）过滤
    if (!this.matchesIfCondition(entry, context)) return false;
    return true;
  }

  /** matcher 层：工具名（工具事件）/ trigger（生命周期事件）匹配 */
  private matchesMatcher(entry: HookRegistryEntry, context?: HookEventContext): boolean {
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

  /**
   * G10：if 条件过滤（对齐 CC）——在 matcher 之上用权限规则语法对 tool_input 细粒度匹配。
   * 仅工具事件（有 toolName + toolInput）适用；无 if 或非工具事件直接放行。
   * 复用 permission/rules.ts 的 matchRule（与用户 allow/deny 规则同一套语法与实现）。
   */
  private matchesIfCondition(entry: HookRegistryEntry, context?: HookEventContext): boolean {
    const ifCond = entry.if?.trim();
    if (!ifCond) return true; // 无 if 条件 → 放行
    // if 依赖 tool_input：非工具事件（无 toolName）无法匹配，视为不命中（跳过该 hook）
    if (!context?.toolName) return false;

    try {
      // 同步 require 避免把 planner 变 async（matchRule 是纯同步函数）
      const { matchRule } = require("../permission/rules.ts");
      return matchRule(ifCond, {
        toolName: context.toolName,
        input: context.toolInput ?? {},
      });
    } catch (e) {
      // 规则语法非法/加载失败：记日志并放行（不因 if 解析失败静默吞掉 hook）
      getLogger().warn("HOOK", `if 条件 "${ifCond}" 匹配失败（放行该 hook）: ${e}`);
      return true;
    }
  }

  /**
   * 匹配工具名（对齐 CC utils/hooks.ts matchesPattern 三档语义）
   *
   * 历史 bug：旧实现对任意 matcher 都走 `new RegExp(matcher).test(toolName)` 且不锚定，
   * 导致 `matcher:"Edit"` 会误命中 `NotebookEdit`/`MultiEdit`（正则子串匹配）。用户写 "Edit"
   * 意图只 hook Edit 工具，结果格式化/拦截/审计 hook 在意料外的工具上触发——静默行为错误。
   *
   * CC 三档（精确匹配优先，正则是兜底）：
   *   1. `''` / `'*'` → 全部匹配（此分支已在 matchesContext 上游拦截，这里冗余兜底）。
   *   2. 纯 `[a-zA-Z0-9_|]` → 精确匹配：含 `|` 按管道拆成精确列表逐个 `===`；否则单值 `===`。
   *   3. 含其他字符（`.` `*` `(` `[` 等）→ 才当正则，**大小写敏感**（无 i flag），非法正则记日志返回 false。
   */
  private matchesToolName(matcher: string, toolName: string): boolean {
    // 兼容旧格式 /pattern/ 包裹 → 强制正则（保留我们既有的显式正则语法）
    if (matcher.startsWith("/") && matcher.endsWith("/") && matcher.length > 2) {
      const pattern = matcher.slice(1, -1);
      try {
        return new RegExp(pattern).test(toolName);
      } catch (e) {
        getLogger().warn("HOOK", `非法 matcher 正则 "${matcher}": ${e}`);
        return false;
      }
    }

    // 第 1 档：空 / 通配符 → 全部匹配（上游已处理，这里兜底）
    if (matcher === "" || matcher === "*") return true;

    // 第 2 档：纯 [a-zA-Z0-9_|] → 精确匹配（含 | 走管道分隔精确列表）
    if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
      if (matcher.includes("|")) {
        return matcher.split("|").some((name) => name === toolName);
      }
      return matcher === toolName;
    }

    // 第 3 档：含正则元字符 → 当正则（大小写敏感），非法正则记日志返回 false
    try {
      return new RegExp(matcher).test(toolName);
    } catch (e) {
      getLogger().warn("HOOK", `非法 matcher 正则 "${matcher}": ${e}`);
      return false;
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
