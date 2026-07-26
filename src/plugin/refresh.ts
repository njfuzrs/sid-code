/**
 * 插件运行时刷新：/reload-plugins 的核心实现
 *
 * 流程：
 *   1. clearAllPluginCaches()  — 清除所有 memoize 缓存
 *   2. loadAllPlugins()        — 完整重新加载（验证 manifest、依赖降级）
 *   3. 重新合并各组件到运行时系统：
 *      - Commands → CommandRegistry.replacePluginCommands
 *      - Hooks    → HookSystem.replacePluginHooks
 *      - MCP      → MCPManager.reconnectPluginServers + ToolRegistry 重注册
 *
 * 错误隔离：任一组件刷新失败不影响其他组件。
 */

import { getLogger } from "../debug/logger.ts";
import type { Registry as CommandRegistry } from "../command/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { HookSystem } from "../hook/system.ts";
import type { MCPManager } from "../mcp/manager.ts";
import type { UnifiedCommandRegistry } from "../command/unified-registry.ts";
import { clearAllPluginCaches } from "./caches.ts";
import { loadAllPlugins } from "./loader.ts";
import { mergePluginCommands } from "./merge.ts";
import { loadPluginHooks } from "./loadPluginHooks.ts";
import { collectPluginMcpServers } from "./loadPluginMcp.ts";
import { PLUGIN_MCP_PREFIX } from "./scope.ts";
import type { PluginLoadResult } from "./types.ts";

/** 刷新时可用的运行时系统句柄 */
export interface RefreshContext {
  /**
   * 命令刷新目标（二选一，优先 unifiedRegistry）：
   * - unifiedRegistry: 新命令体系（清缓存后已由 clearAllPluginCaches 完成，
   *   这里调 reloadPlugins 重新拉取插件命令快照）
   * - commandRegistry: 旧命令体系（bridge/headless 等仍用旧 Registry 的路径）
   */
  unifiedRegistry?: UnifiedCommandRegistry;
  commandRegistry?: CommandRegistry;
  toolRegistry?: ToolRegistry;
  hookSystem?: HookSystem;
  mcpManager?: MCPManager;
  /**
   * Skill 管理器。插件带的 skills（§18.10）此前不参与刷新——装了新插件要重启才能用它的
   * skill，卸载插件后它的 skill 还留着。传入后走 replacePluginSkills 原子替换。
   */
  skillManager?: import("../skill/manager.ts").SkillManager;
}

/** 刷新结果摘要 */
export interface RefreshResult {
  loadResult: PluginLoadResult;
  commandsLoaded: number;
  hooksRefreshed: boolean;
  mcpToolsLoaded: number;
  /** 刷新后生效的插件 Skill 数量（未传 skillManager 时为 0） */
  skillsLoaded: number;
  componentErrors: string[];
}

/**
 * 刷新所有活跃插件组件。
 * @param ctx 运行时系统句柄（缺省的组件跳过）
 */
export async function refreshActivePlugins(ctx: RefreshContext): Promise<RefreshResult> {
  const log = getLogger();
  const componentErrors: string[] = [];

  // 1. 清缓存 + 完整重新加载
  clearAllPluginCaches();
  const loadResult = await loadAllPlugins();

  // 2. 命令
  let commandsLoaded = 0;
  if (ctx.unifiedRegistry) {
    // 新命令体系：缓存已由 clearAllPluginCaches 清除，重新拉取插件命令快照
    try {
      commandsLoaded = await ctx.unifiedRegistry.reloadPlugins();
    } catch (err: any) {
      componentErrors.push(`命令刷新失败: ${err.message}`);
      log.error("PLUGIN", `命令刷新失败: ${err.message}`);
    }
  } else if (ctx.commandRegistry) {
    // 旧命令体系（bridge/headless 等路径）
    try {
      commandsLoaded = await mergePluginCommands(ctx.commandRegistry);
    } catch (err: any) {
      componentErrors.push(`命令刷新失败: ${err.message}`);
      log.error("PLUGIN", `命令刷新失败: ${err.message}`);
    }
  }

  // 3. Hooks
  let hooksRefreshed = false;
  if (ctx.hookSystem) {
    try {
      // loadPluginHooks 是 memoize 的，clearAllPluginCaches 已清除，这里会重新执行
      await loadPluginHooks(ctx.hookSystem);
      hooksRefreshed = true;
    } catch (err: any) {
      componentErrors.push(`Hook 刷新失败: ${err.message}`);
      log.error("PLUGIN", `Hook 刷新失败: ${err.message}`);
    }
  }

  // 4. Skills（§18.10 插件带的 skills）
  let skillsLoaded = 0;
  if (ctx.skillManager) {
    try {
      // getPluginSkills 是 memoize 的，clearAllPluginCaches 已清除，这里会重新加载
      const { getPluginSkills } = await import("./loadPluginSkills.ts");
      const pluginSkills = await getPluginSkills();
      // 原子替换：卸载/禁用的插件其 skill 一并移除（纯追加会永久残留）
      skillsLoaded = ctx.skillManager.replacePluginSkills(pluginSkills);
    } catch (err: any) {
      componentErrors.push(`Skill 刷新失败: ${err.message}`);
      log.error("PLUGIN", `Skill 刷新失败: ${err.message}`);
    }
  }

  // 5. MCP
  let mcpToolsLoaded = 0;
  if (ctx.mcpManager) {
    try {
      const servers = await collectPluginMcpServers();
      // 重连前清理 ToolRegistry 中的旧插件 MCP 工具
      if (ctx.toolRegistry) {
        ctx.toolRegistry.removeByPrefix(`mcp__${PLUGIN_MCP_PREFIX}`);
      }
      const tools = await ctx.mcpManager.reconnectPluginServers(servers);
      mcpToolsLoaded = tools.length;
      // 注册新工具
      if (ctx.toolRegistry) {
        for (const tool of tools) {
          ctx.toolRegistry.register(tool);
        }
      }
    } catch (err: any) {
      componentErrors.push(`MCP 刷新失败: ${err.message}`);
      log.error("PLUGIN", `MCP 刷新失败: ${err.message}`);
    }
  }

  log.info(
    "PLUGIN",
    `插件刷新完成: ${loadResult.enabled.length} 启用, ${commandsLoaded} 命令, ${skillsLoaded} Skill, ${mcpToolsLoaded} MCP 工具`,
  );

  return {
    loadResult,
    commandsLoaded,
    hooksRefreshed,
    mcpToolsLoaded,
    skillsLoaded,
    componentErrors,
  };
}
