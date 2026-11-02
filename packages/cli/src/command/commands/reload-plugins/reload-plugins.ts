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

import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { refreshActivePlugins, formatPluginError } from "../../../plugin/index.ts";

/** /reload-plugins 命令 */
export class ReloadPluginsCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const result = await refreshActivePlugins({
      unifiedRegistry: ctx.unifiedRegistry,
      toolRegistry: ctx.toolRegistry,
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

    return { type: "text", value: lines.join("\n") };
  }
}
