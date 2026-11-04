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

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import {
  loadAllPlugins,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  formatPluginError,
  parsePluginId,
} from "../../../plugin/index.ts";
import {
  installFromMarket,
  isMarketSpec,
  listMarket,
  listMarketplaces,
  updateFromMarket,
} from "../../../plugin/market-operations.ts";
import { listComponentLoadErrors } from "../../../plugin/component-errors.ts";

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
export class PluginCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { positionals, flags, values } = parseArgs(args);
    // 无参 → 打开交互管理面板（同 /mcp、/skills）。此前无参落到 list 文本：
    // 只有 1 个插件时结果仅 2 行，低于 PANEL_MIN_LINES，被路由到状态栏一闪而过。
    // CLI `sid-code plugin` 无参在 plugin-cli.ts 里先打印用法，走不到这里。
    if (positionals.length === 0 && flags.size === 0 && values.size === 0) {
      return { type: "dialog", dialog: "plugins" };
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
        return r.ok ? { type: "text", value: r.message } : errorText(r.error);
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
        return errorText(
          `未知子命令: ${sub}\n用法: /plugin list|market|marketplaces|info|install|update|uninstall|enable|disable`,
        );
    }
  }

  private async list(): Promise<LocalCommandResult> {
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

    // 组件（命令/Skill/Agent）是延迟加载的，失败不会进 result.errors。不在这里补一段，
    // 用户体感就是「插件装了，命令少了几个，没有任何提示」。只有在这些组件已被加载过
    // （/plugin 面板、/reload-plugins）时收集器里才有内容，这也是它唯一可能的落点。
    const componentErrors = listComponentLoadErrors();
    if (componentErrors.length > 0) {
      lines.push("", "组件加载失败:");
      for (const err of componentErrors) {
        lines.push(`  ⚠ ${formatPluginError(err)}`);
      }
    }

    // 列表是查看型报告，行数再少也要进面板（不受 PANEL_MIN_LINES 约束），否则 1 个插件时
    // 只有 2 行、落到状态栏一闪而过。panel 字段只影响 TUI，CLI / headless 照样输出纯文本。
    return { type: "text", value: lines.join("\n"), panel: { title: "/plugin list" } };
  }

  private async info(name?: string): Promise<LocalCommandResult> {
    if (!name) return errorText("用法: /plugin info <name>");

    const { name: pluginName } = parsePluginId(name);
    const result = await loadAllPlugins();
    const plugin = [...result.enabled, ...result.disabled].find((p) => p.name === pluginName);
    if (!plugin) {
      return { type: "text", value: `未找到插件: ${pluginName}` };
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

    return { type: "text", value: lines.join("\n") };
  }

  private async wrap(
    p: Promise<{ ok: true; message: string } | { ok: false; error: string }>,
    reloadHint = false,
  ): Promise<LocalCommandResult> {
    const r = await p;
    if (!r.ok) return errorText(r.error);
    return {
      type: "text",
      value: reloadHint ? `${r.message}\n提示: 运行 /reload-plugins 使其生效` : r.message,
    };
  }

  /**
   * 生命周期操作成功后的文案：运行时已刷新就不再让用户手动敲 /reload-plugins。
   * 未注册刷新器（headless / CLI 子命令 / 测试）时才保留旧提示。
   */
  private successMessage(result: { message: string; runtimeRefreshed?: boolean }): string {
    return result.runtimeRefreshed
      ? result.message
      : `${result.message}\n提示: 运行 /reload-plugins 使其生效`;
  }

  private async install(path: string | undefined, flags: Set<string>): Promise<LocalCommandResult> {
    if (!path) return errorText("用法: /plugin install <name>@<市场> | <本地目录路径> [--no-copy]");
    if (isMarketSpec(path)) return this.wrap(installFromMarket(path), true);
    const result = await installPlugin(path, { copy: !flags.has("no-copy") });
    return result.ok
      ? { type: "text", value: this.successMessage(result) }
      : errorText(result.error);
  }

  private async uninstall(
    name: string | undefined,
    flags: Set<string>,
  ): Promise<LocalCommandResult> {
    if (!name) return errorText("用法: /plugin uninstall <name> [--delete] [--force]");
    const result = await uninstallPlugin(name, {
      deleteFiles: flags.has("delete"),
      force: flags.has("force"),
    });
    return result.ok
      ? { type: "text", value: this.successMessage(result) }
      : errorText(result.error);
  }

  private async toggle(
    name: string | undefined,
    enable: boolean,
    flags: Set<string>,
    _ctx: CommandContext,
  ): Promise<LocalCommandResult> {
    if (!name) return errorText(`用法: /plugin ${enable ? "enable" : "disable"} <name>`);
    const result = enable
      ? await enablePlugin(name)
      : await disablePlugin(name, { force: flags.has("force") });
    return result.ok
      ? { type: "text", value: this.successMessage(result) }
      : errorText(result.error);
  }
}
