import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

/** /hooks 命令 — Hook 管理 */
export class HooksCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.hookSystem) {
      return errorText("Hook 系统未初始化");
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    // 剥离持久化标志（-p / --persist / save），其余按 子命令 + hook 名解析。
    const persist = parts.some((t) => t === "-p" || t === "--persist" || t === "save");
    const rest = parts.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
    const subCmd = rest[0] || "";
    const hookName = rest.slice(1).join(" ");
    const persistNote = persist ? "（已持久化到 settings.json）" : "（仅当前会话，加 -p 可持久化）";

    switch (subCmd) {
      case "":
        // 无参数 → 打开交互式 Hooks 管理面板
        return { type: "dialog", dialog: "hooks" };
      case "list":
        return this.listHooks(ctx);
      case "enable":
        if (!hookName) return errorText("用法: /hooks enable <name> [-p]");
        ctx.hookSystem.setHookEnabled(hookName, true);
        if (persist) this.persistHookDisabled(hookName, false);
        return { type: "text", value: `已启用 hook: ${hookName}${persistNote}` };
      case "disable":
        if (!hookName) return errorText("用法: /hooks disable <name> [-p]");
        ctx.hookSystem.setHookEnabled(hookName, false);
        if (persist) this.persistHookDisabled(hookName, true);
        return { type: "text", value: `已禁用 hook: ${hookName}${persistNote}` };
      case "enable-all":
        ctx.hookSystem.setAllEnabled(true);
        // 全部启用 = 清空 disabledHooks（仅在 -p 时落盘）。
        if (persist) this.clearPersistedDisabled();
        return { type: "text", value: `已启用所有 hook${persistNote}` };
      case "disable-all":
        ctx.hookSystem.setAllEnabled(false);
        // 全部禁用：把当前所有 hook 名写入 disabledHooks（仅在 -p 时落盘）。
        if (persist) this.persistAllDisabled(ctx);
        return { type: "text", value: `已禁用所有 hook${persistNote}` };
      default:
        return errorText(
          `未知子命令: ${subCmd}\n用法: /hooks [list|enable|disable|enable-all|disable-all] [-p]`,
        );
    }
  }

  /**
   * 增删 settings.json 顶层 disabledHooks（/hooks enable|disable -p 持久化端）。
   * 复用 /skills 的读-合并-补丁范式（禁整体覆盖，见 settings 有损 round-trip 陷阱）。
   * disable=true 追加 hook 名，false 移除。
   */
  private persistHookDisabled(hookName: string, disable: boolean): void {
    try {
      const {
        getSettingsForSource,
        patchSettingsFile,
      } = require("@sid-code/core/config/settings/index.ts");
      const { settings } = getSettingsForSource("userSettings");
      const set = new Set<string>(settings?.disabledHooks ?? []);
      if (disable) set.add(hookName);
      else set.delete(hookName);
      patchSettingsFile("userSettings", "disabledHooks", [...set]);
    } catch (e) {
      getLogger().warn("HOOK", `持久化 disabledHooks 失败（不阻断）: ${(e as Error)?.message}`);
    }
  }

  /** 清空 disabledHooks（/hooks enable-all -p）。 */
  private clearPersistedDisabled(): void {
    try {
      const { patchSettingsFile } = require("@sid-code/core/config/settings/index.ts");
      patchSettingsFile("userSettings", "disabledHooks", []);
    } catch (e) {
      getLogger().warn("HOOK", `清空 disabledHooks 失败（不阻断）: ${(e as Error)?.message}`);
    }
  }

  /** 把当前所有 hook 名写入 disabledHooks（/hooks disable-all -p）。 */
  private persistAllDisabled(ctx: CommandContext): void {
    try {
      const names = ctx
        .hookSystem!.getAllHooks()
        .map((e) => ctx.hookSystem!.getHookName(e))
        .filter(Boolean);
      const { patchSettingsFile } = require("@sid-code/core/config/settings/index.ts");
      patchSettingsFile("userSettings", "disabledHooks", [...new Set(names)]);
    } catch (e) {
      getLogger().warn(
        "HOOK",
        `持久化 disabledHooks（全部）失败（不阻断）: ${(e as Error)?.message}`,
      );
    }
  }

  private listHooks(ctx: CommandContext): LocalCommandResult {
    const hooks = ctx.hookSystem!.getAllHooks();
    if (hooks.length === 0) {
      return { type: "text", value: "没有已注册的 hook" };
    }

    const lines = ["已注册的 Hook:"];
    for (const entry of hooks) {
      const status = entry.enabled ? "✓" : "✗";
      const name =
        entry.config.name ||
        (entry.config.type === "command" ? entry.config.command : "") ||
        (entry.config.type === "url" ? entry.config.url : "") ||
        "unknown";
      const type = entry.config.type || "command";
      const matcher = entry.matcher ? ` [${entry.matcher}]` : "";
      const source = entry.source;
      lines.push(`  ${status} [${entry.eventName}] ${name} (${type}, ${source})${matcher}`);
    }
    return { type: "text", value: lines.join("\n") };
  }
}
