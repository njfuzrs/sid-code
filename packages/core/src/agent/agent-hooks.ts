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
import { ConfigSource } from "../hook/types.ts";

/**
 * 把 agent frontmatter 声明的 hooks 注册进给定 HookSystem。
 *
 * HC3：形状解析统一走 hook/config-normalize.ts。原先这里只取 command / timeout，
 * frontmatter 里的 if / env / url / prompt / async 全部静默丢失。
 * 非法事件名 / 缺字段的项 warn 跳过（不 spawn 失败）。
 * @returns 成功注册的 hook 数量
 */
export function registerAgentHooks(
  hookSystem: HookSystem,
  agentType: string,
  hooksConfig: unknown,
): number {
  if (!hooksConfig || typeof hooksConfig !== "object") return 0;
  const log = getLogger();
  const before = hookSystem.getAllHooks().length;
  const diagnostics = hookSystem.addNormalizedHooks(hooksConfig, ConfigSource.Runtime, {
    pathPrefix: `agent:${agentType}.hooks`,
    defaultName: `agent:${agentType}`,
  });
  for (const d of diagnostics) {
    log.warn("AGENT", `Agent ${agentType} 的 hook 已跳过 ${d.path}: ${d.message}`);
  }
  const count = hookSystem.getAllHooks().length - before;
  if (count > 0) log.info("AGENT", `Agent ${agentType} 注册了 ${count} 个专属 hook`);
  return count;
}

/**
 * 为声明了 hooks 的 agent 构建专属隔离 HookSystem。
 * agent 未声明 hooks（或结构非法/注册数为 0）时返回 undefined，调用方回退共享 hookSystem。
 */
export function buildAgentHookSystem(
  agentType: string,
  hooksConfig: unknown,
): HookSystem | undefined {
  if (!hooksConfig || typeof hooksConfig !== "object") return undefined;
  const sys = new HookSystem();
  const n = registerAgentHooks(sys, agentType, hooksConfig);
  return n > 0 ? sys : undefined;
}
