/**
 * Agent 专用 hooks 注册（P2-1，对齐 CC frontmatter hooks + §11.8「子代理专用 hooks」）
 *
 * 自定义/插件 agent 可在 frontmatter 声明 hooks，spawn 时注册到该子代理**专属**的
 * HookSystem，PostToolUse / PreToolUse 等事件触发。
 *
 * 隔离设计：并发子代理共享主 HookSystem 实例，若把 agent hooks 注册进去，A 的 hook 会
 * 对 B 的工具调用误触发（matcher 无法区分是哪个 agent）。故 hook-declaring agent 走
 * **独立 HookSystem**（本模块 buildAgentHookSystem 创建），只承载该 agent 自己的 hooks，
 * 与其他 agent / 主会话完全隔离。权限安全仍由 permissionChecker 独立保证（不依赖 hooks）。
 *
 * frontmatter 结构与 skill hooks / settings.json hooks 一致：
 *   hooks:
 *     PostToolUse:
 *       - matcher: "write"
 *         hooks:
 *           - command: "npx eslint --fix"
 */

import { getLogger } from "../debug/logger.ts";
import { HookSystem } from "../hook/system.ts";
import {
  HookEventName,
  LEGACY_EVENT_MAP,
  type CommandHookConfig,
} from "../hook/types.ts";

/** 事件名解析（PascalCase 或旧 snake_case）；未知返回 null。 */
function resolveEvent(name: string): HookEventName | null {
  const values = Object.values(HookEventName) as string[];
  if (values.includes(name)) return name as HookEventName;
  return (LEGACY_EVENT_MAP as Record<string, HookEventName>)[name] ?? null;
}

/**
 * 把 agent frontmatter 声明的 hooks 注册进给定 HookSystem。
 * 非法事件名 / 缺 command 的项 warn 跳过（不 spawn 失败）。
 * @returns 成功注册的 hook 数量
 */
export function registerAgentHooks(
  hookSystem: HookSystem,
  agentType: string,
  hooksConfig: unknown,
): number {
  if (!hooksConfig || typeof hooksConfig !== "object") return 0;
  const log = getLogger();
  let count = 0;

  for (const [eventName, definitions] of Object.entries(hooksConfig as Record<string, unknown>)) {
    const resolved = resolveEvent(eventName);
    if (!resolved) {
      log.warn("AGENT", `Agent ${agentType} 声明了未知的 hook 事件: ${eventName}`);
      continue;
    }
    if (!Array.isArray(definitions)) continue;

    for (const def of definitions as Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>) {
      if (!def || !Array.isArray(def.hooks)) continue;
      for (const hook of def.hooks) {
        if (!hook?.command) continue;
        const config: CommandHookConfig = {
          type: "command",
          name: `agent:${agentType}`,
          command: hook.command,
          ...(typeof hook.timeout === "number" ? { timeout: hook.timeout } : {}),
        };
        try {
          hookSystem.registerHook(config, resolved, { matcher: def.matcher });
          count++;
          log.debug("AGENT", `注册 Agent hook: ${agentType} → ${eventName}:${def.matcher ?? "*"}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("AGENT", `注册 Agent hook 失败 (${agentType}): ${msg}`);
        }
      }
    }
  }

  if (count > 0) log.info("AGENT", `Agent ${agentType} 注册了 ${count} 个专属 hook`);
  return count;
}

/**
 * 为声明了 hooks 的 agent 构建专属隔离 HookSystem。
 * agent 未声明 hooks（或结构非法/注册数为 0）时返回 undefined，调用方回退共享 hookSystem。
 */
export function buildAgentHookSystem(agentType: string, hooksConfig: unknown): HookSystem | undefined {
  if (!hooksConfig || typeof hooksConfig !== "object") return undefined;
  const sys = new HookSystem();
  const n = registerAgentHooks(sys, agentType, hooksConfig);
  return n > 0 ? sys : undefined;
}
