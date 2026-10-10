/**
 * Hook 执行计划器
 * 匹配过滤、去重、决定串行/并行策略
 */

import type { HookRegistry, HookRegistryEntry } from "./registry.ts";
import { toInternalToolName, toCcToolName } from "../tool/tool-name-aliases.ts";
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
  createExecutionPlan(
    eventName: HookEventName,
    context?: HookEventContext,
  ): HookExecutionPlan | null {
    const entries = this.registry.getHooksForEvent(eventName);
    if (entries.length === 0) return null;

    // 按 matcher 过滤
    const matching = entries.filter((e) => this.matchesContext(e, context));
    if (matching.length === 0) return null;

    // 去重
    const deduped = this.deduplicateHooks(matching);

    // 提取配置
    const hookConfigs = deduped.map((e) => e.config);

    // 任一 definition 标记 sequential=true → 整体串行
    const sequential = deduped.some((e) => e.sequential === true);

    const log = getLogger();
    log.debug(
      "HOOK",
      `执行计划 [${eventName}]: ${hookConfigs.length} 个 hook，${sequential ? "串行" : "并行"}`,
    );

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

    // 生命周期事件：与工具事件同一套三档（H20 / HC10），只是不过工具名别名表
    if (context.trigger) {
      return matchesPattern(matcher, [context.trigger]);
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
   * 匹配工具名（对齐 CC matchesPattern 三档语义 + 工具名别名，HC8）
   *
   * 历史 bug：旧实现对任意 matcher 都走不锚定的 `new RegExp(matcher)`，`matcher:"Edit"` 误命中
   * `NotebookEdit`；后来改成三档，但精确档只认 `[a-zA-Z0-9_|]` 且区分大小写，于是 CC 写法
   * `matcher:"Bash"` 永远不命中内部名 `bash`，`"Edit, Write"` 落进正则档也不命中。
   *
   * 现在：精确档每个 token 先过别名表归一到内部名再比较（`Bash` / `bash` 都命中 `bash`）；
   * 正则档对内部名与 CC 名各测一次，任一命中即算（`Edit|Write.*` 这类 CC 正则照样能用）。
   */
  private matchesToolName(matcher: string, toolName: string): boolean {
    const internal = toInternalToolName(toolName);
    const cc = toCcToolName(internal);
    const candidates = cc ? [internal, cc] : [internal];
    return matchesPattern(matcher, candidates, toInternalToolName);
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

/** CC 精确档字符集：字母、数字、`_`、`-`、空格、`,`、`|` */
const EXACT_MATCHER_RE = /^[A-Za-z0-9_\-\s,|]+$/;

/**
 * CC 三档 matcher：
 *   1. `''` / `'*'` → 全部匹配；
 *   2. 纯精确档字符 → 按 `|` 或 `,` 拆成精确列表（去空格），任一 token 等于任一候选即命中；
 *   3. 其他 → 正则（大小写敏感，不锚定，与 CC 一致），对每个候选各测一次；非法正则记日志返回 false。
 * 兼容 sid 旧语法 `/pattern/`：强制正则。
 * `normalize` 只作用于精确档的 token（工具事件传别名归一，生命周期事件不传）。
 */
export function matchesPattern(
  matcher: string,
  candidates: string[],
  normalize: (s: string) => string = (s) => s,
): boolean {
  const m = matcher.trim();
  if (m === "" || m === "*") return true;

  let regexSrc: string | undefined;
  if (m.startsWith("/") && m.endsWith("/") && m.length > 2) {
    regexSrc = m.slice(1, -1);
  } else if (EXACT_MATCHER_RE.test(m)) {
    const tokens = m
      .split(/[|,]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map(normalize);
    const normCandidates = candidates.map(normalize);
    return tokens.some((t) => normCandidates.includes(t));
  } else {
    regexSrc = m;
  }

  try {
    const re = new RegExp(regexSrc);
    return candidates.some((c) => re.test(c));
  } catch (e) {
    getLogger().warn("HOOK", `非法 matcher 正则 "${matcher}": ${e}`);
    return false;
  }
}
