/**
 * 插件管理命令
 *   /plugin                       - 打开插件交互管理面板（查看 / 启用 / 禁用 / 更新 / 卸载）
 *   /plugin list                  - 列出所有插件（启用/禁用/错误）
 *   /plugin info <name>           - 查看插件详情
 *   /plugin market [--market <名>] [关键词] - 浏览插件市场（默认列出全部已注册市场）
 *   /plugin marketplaces          - 列出已注册的市场（企业 company / 官方 sid-code / 额外）
 *   /plugin install <name>@<市场>  - 从市场安装（下载 → sha256 校验 → 安全解包）
 *   /plugin install <path>        - 从本地目录安装插件（企业策略锁定时拒绝）
 *   /plugin update [name]         - 回各自安装来源的市场比对并更新
 *   /plugin uninstall <name>      - 卸载插件（--delete 删文件，--force 忽略依赖）
 *   /plugin enable <name>         - 启用插件
 *   /plugin disable <name>        - 禁用插件（--force 忽略反向依赖）
 *
 *   /reload-plugins               - 重新加载所有插件组件（含 LSP 配置重载）
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import {
  loadAllPlugins,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  refreshActivePlugins,
  formatPluginError,
  parsePluginId,
} from "../plugin/index.ts";
import {
  installFromMarket,
  isMarketSpec,
  listMarket,
  listMarketplaces,
  updateFromMarket,
} from "../plugin/market-operations.ts";

/** 带值的 flag（`--market <name>` 或 `--market=<name>`） */
const VALUE_FLAGS = new Set(["market"]);

/** 解析 flag 与位置参数 */
function parseArgs(args: string): {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.startsWith("--")) {
      positionals.push(p);
      continue;
    }
    const eq = p.indexOf("=");
    const key = eq > 0 ? p.slice(2, eq) : p.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const v = eq > 0 ? p.slice(eq + 1) : parts[++i];
      if (v) values.set(key, v);
    } else {
      flags.add(key);
    }
  }
  return { positionals, flags, values };
}

/** /plugin 命令 */
export class PluginCommand implements Command {
  name() {
    return "plugin";
  }
  aliases() {
    return ["plugins"];
  }
  description() {
    return "插件管理（无参打开交互面板）";
  }
  argumentHint() {
    return "[list|market|marketplaces|info|install|update|uninstall|enable|disable] [插件名]";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { positionals, flags, values } = parseArgs(args);
    // 无参 → 打开交互管理面板（同 /mcp、/skills）。此前无参落到 list 文本：
    // 只有 1 个插件时结果仅 2 行，低于 PANEL_MIN_LINES，被路由到状态栏一闪而过。
    // CLI `sid-code plugin` 无参在 plugin-cli.ts 里先打印用法，走不到这里。
    if (positionals.length === 0 && flags.size === 0 && values.size === 0) {
      return { kind: "dialog", dialog: "plugins" };
    }
    const sub = positionals[0]?.toLowerCase() || "list";

    switch (sub) {
      case "list":
      case "ls":
        return this.list();
      case "info":
        return this.info(positionals[1]);
      case "market":
      case "search":
        return this.wrap(
          listMarket(positionals.slice(1).join(" "), { market: values.get("market") }),
        );
      case "marketplaces":
      case "markets": {
        const r = listMarketplaces();
        return r.ok ? { kind: "message", message: r.message } : { kind: "error", message: r.error };
      }
      case "update":
      case "upgrade":
        return this.wrap(updateFromMarket(positionals[1]), true);
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
        return {
          kind: "error",
          message: `未知子命令: ${sub}\n用法: /plugin list|market|marketplaces|info|install|update|uninstall|enable|disable`,
        };
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

    // 列表是查看型报告，行数再少也要进面板（不受 PANEL_MIN_LINES 约束），否则 1 个插件时
    // 只有 2 行、落到状态栏一闪而过。panel 字段只影响 TUI，CLI / headless 照样输出纯文本。
    return { kind: "message", message: lines.join("\n"), panel: { title: "/plugin list" } };
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

  private async wrap(
    p: Promise<{ ok: true; message: string } | { ok: false; error: string }>,
    reloadHint = false,
  ): Promise<CommandResult> {
    const r = await p;
    if (!r.ok) return { kind: "error", message: r.error };
    return {
      kind: "message",
      message: reloadHint ? `${r.message}\n提示: 运行 /reload-plugins 使其生效` : r.message,
    };
  }

  private async install(path: string | undefined, flags: Set<string>): Promise<CommandResult> {
    if (!path)
      return {
        kind: "error",
        message: "用法: /plugin install <name>@<市场> | <本地目录路径> [--no-copy]",
      };
    if (isMarketSpec(path)) return this.wrap(installFromMarket(path), true);
    const result = await installPlugin(path, { copy: !flags.has("no-copy") });
    return result.ok
      ? { kind: "message", message: `${result.message}\n提示: 运行 /reload-plugins 使其生效` }
      : { kind: "error", message: result.error };
  }

  private async uninstall(name: string | undefined, flags: Set<string>): Promise<CommandResult> {
    if (!name)
      return { kind: "error", message: "用法: /plugin uninstall <name> [--delete] [--force]" };
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
    if (!name)
      return { kind: "error", message: `用法: /plugin ${enable ? "enable" : "disable"} <name>` };
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
  name() {
    return "reload-plugins";
  }
  aliases() {
    return ["reload-plugin"];
  }
  description() {
    return "重新加载所有插件组件（命令/Skills/Hooks/MCP）";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    const result = await refreshActivePlugins({
      // 新体系优先：app.ts 会注入 unifiedRegistry；旧路径（bridge/headless）回退 commandRegistry
      unifiedRegistry: ctx.unifiedRegistry,
      commandRegistry: ctx.commandRegistry,
      toolRegistry: ctx.registry,
      hookSystem: ctx.hookSystem,
      mcpManager: ctx.mcpManager,
      // §18.10：插件带的 skills 也要随刷新生效/失效（原子替换）
      skillManager: ctx.skillManager,
    });

    const lines = [
      "插件已重新加载:",
      `  ${result.loadResult.enabled.length} 个启用插件`,
      `  ${result.commandsLoaded} 个命令`,
      `  ${result.skillsLoaded} 个 Skill`,
      `  ${result.mcpToolsLoaded} 个 MCP 工具`,
    ];
    if (result.hooksRefreshed) lines.push("  Hooks 已刷新");

    // D15：顺手重载 LSP。插件可能带来新的项目文件/语言，且用户改 lsp.json 后最容易
    // 想到的就是"刷新一下"。reinitializeLSP 在 LSP 未启动（--print / --bridge，见 D16）
    // 时是空操作，所以这里无条件调用是安全的。
    //
    // ⚠️ 但这**不是**唯一入口 —— 专门的 `/lsp reload` 才是。触发重载的真实场景是
    // "我刚改了 lsp.json"，那和"我刚装了插件"是两件不同的事，把 LSP 重载只藏在
    // 插件命令里，等于让用户猜。
    try {
      const { reinitializeLSP, getLSPInitState } = await import("@sid-code/core/lsp/manager.ts");
      if (getLSPInitState() !== "not-started") {
        reinitializeLSP(process.cwd());
        lines.push("  LSP 配置已重载");
      }
    } catch {
      // LSP 是可选增强：重载失败不该让 /reload-plugins 整体报错
    }

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
