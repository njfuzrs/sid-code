/**
 * 插件管理命令
 *   /plugin list                  - 列出所有插件（启用/禁用/错误）
 *   /plugin info <name>           - 查看插件详情
 *   /plugin install <path>        - 从本地目录安装插件
 *   /plugin uninstall <name>      - 卸载插件（--delete 删文件，--force 忽略依赖）
 *   /plugin enable <name>         - 启用插件
 *   /plugin disable <name>        - 禁用插件（--force 忽略反向依赖）
 *
 *   /reload-plugins               - 重新加载所有插件组件
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import {
  readInstalledPlugins,
  loadAllPlugins,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  refreshActivePlugins,
  formatPluginError,
  parsePluginId,
} from "../plugin/index.ts";

/** 解析 flag 与位置参数 */
function parseArgs(args: string): { positionals: string[]; flags: Set<string> } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const p of parts) {
    if (p.startsWith("--")) flags.add(p.slice(2));
    else positionals.push(p);
  }
  return { positionals, flags };
}

/** /plugin 命令 */
export class PluginCommand implements Command {
  name() { return "plugin"; }
  aliases() { return ["plugins"]; }
  description() { return "插件管理 (list/info/install/uninstall/enable/disable)"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { positionals, flags } = parseArgs(args);
    const sub = positionals[0]?.toLowerCase() || "list";

    switch (sub) {
      case "list":
      case "ls":
        return this.list();
      case "info":
        return this.info(positionals[1]);
      case "install":
      case "add":
        return this.install(positionals[1], flags);
      case "uninstall":
      case "remove":
      case "rm":
        return this.uninstall(positionals[1], flags);
      case "enable":
        return this.toggle(positionals[1], true, flags, ctx);
      case "disable":
        return this.toggle(positionals[1], false, flags, ctx);
      default:
        return { kind: "error", message: `未知子命令: ${sub}\n用法: /plugin list|info|install|uninstall|enable|disable` };
    }
  }

  private async list(): Promise<CommandResult> {
    const result = await loadAllPlugins();
    const lines: string[] = ["插件列表:"];

    if (result.enabled.length === 0 && result.disabled.length === 0) {
      lines.push("  (无已安装插件)");
    }

    for (const p of result.enabled) {
      const builtin = p.isBuiltin ? " [内置]" : "";
      lines.push(`  ✓ ${p.name}@${p.manifest.version}${builtin} — ${p.manifest.description}`);
    }
    for (const p of result.disabled) {
      const builtin = p.isBuiltin ? " [内置]" : "";
      lines.push(`  ✗ ${p.name}@${p.manifest.version}${builtin} (已禁用)`);
    }

    if (result.errors.length > 0) {
      lines.push("", "加载错误:");
      for (const err of result.errors) {
        lines.push(`  ⚠ ${formatPluginError(err)}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }

  private async info(name?: string): Promise<CommandResult> {
    if (!name) return { kind: "error", message: "用法: /plugin info <name>" };

    const { name: pluginName } = parsePluginId(name);
    const result = await loadAllPlugins();
    const plugin = [...result.enabled, ...result.disabled].find((p) => p.name === pluginName);
    if (!plugin) {
      return { kind: "message", message: `未找到插件: ${pluginName}` };
    }

    const m = plugin.manifest;
    const lines = [
      `插件: ${m.name}@${m.version}`,
      `描述: ${m.description}`,
      `来源: ${plugin.source}`,
      `状态: ${plugin.enabled ? "已启用" : "已禁用"}`,
      `路径: ${plugin.path}`,
    ];
    if (m.author) lines.push(`作者: ${m.author}`);
    if (m.license) lines.push(`许可: ${m.license}`);
    if (m.dependencies?.length) lines.push(`依赖: ${m.dependencies.join(", ")}`);

    const components: string[] = [];
    if (plugin.commandsPaths.length) components.push(`命令(${plugin.commandsPaths.length} 目录)`);
    if (plugin.skillsPaths.length) components.push(`Skill(${plugin.skillsPaths.length} 目录)`);
    if (plugin.agentsPaths.length) components.push(`Agent(${plugin.agentsPaths.length} 目录)`);
    if (plugin.hooksConfig) components.push("Hooks");
    if (m.mcpServers) components.push("MCP");
    if (components.length) lines.push(`组件: ${components.join(", ")}`);

    return { kind: "message", message: lines.join("\n") };
  }

  private async install(path: string | undefined, flags: Set<string>): Promise<CommandResult> {
    if (!path) return { kind: "error", message: "用法: /plugin install <本地目录路径> [--no-copy]" };
    const result = await installPlugin(path, { copy: !flags.has("no-copy") });
    return result.ok
      ? { kind: "message", message: `${result.message}\n提示: 运行 /reload-plugins 使其生效` }
      : { kind: "error", message: result.error };
  }

  private async uninstall(name: string | undefined, flags: Set<string>): Promise<CommandResult> {
    if (!name) return { kind: "error", message: "用法: /plugin uninstall <name> [--delete] [--force]" };
    const result = await uninstallPlugin(name, {
      deleteFiles: flags.has("delete"),
      force: flags.has("force"),
    });
    return result.ok
      ? { kind: "message", message: `${result.message}\n提示: 运行 /reload-plugins 使其生效` }
      : { kind: "error", message: result.error };
  }

  private async toggle(
    name: string | undefined,
    enable: boolean,
    flags: Set<string>,
    _ctx: AppContext,
  ): Promise<CommandResult> {
    if (!name) return { kind: "error", message: `用法: /plugin ${enable ? "enable" : "disable"} <name>` };
    const result = enable
      ? await enablePlugin(name)
      : await disablePlugin(name, { force: flags.has("force") });
    return result.ok
      ? { kind: "message", message: `${result.message}\n提示: 运行 /reload-plugins 使其生效` }
      : { kind: "error", message: result.error };
  }
}

/** /reload-plugins 命令 */
export class ReloadPluginsCommand implements Command {
  name() { return "reload-plugins"; }
  aliases() { return ["reload-plugin"]; }
  description() { return "重新加载所有插件组件（命令/Hooks/MCP）"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const result = await refreshActivePlugins({
      // 新体系优先：app.ts 会注入 unifiedRegistry；旧路径（bridge/headless）回退 commandRegistry
      unifiedRegistry: ctx.unifiedRegistry,
      commandRegistry: ctx.commandRegistry,
      toolRegistry: ctx.registry,
      hookSystem: ctx.hookSystem,
      mcpManager: ctx.mcpManager,
    });

    const lines = [
      "插件已重新加载:",
      `  ${result.loadResult.enabled.length} 个启用插件`,
      `  ${result.commandsLoaded} 个命令`,
      `  ${result.mcpToolsLoaded} 个 MCP 工具`,
    ];
    if (result.hooksRefreshed) lines.push("  Hooks 已刷新");

    if (result.loadResult.errors.length > 0) {
      lines.push("", "加载警告:");
      for (const err of result.loadResult.errors) {
        lines.push(`  ⚠ ${formatPluginError(err)}`);
      }
    }
    if (result.componentErrors.length > 0) {
      lines.push("", "组件错误:");
      for (const err of result.componentErrors) {
        lines.push(`  ✗ ${err}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}
