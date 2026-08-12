import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { existsSync, writeFileSync } from "fs";
import { getLogger } from "@sid-code/core/debug/logger.ts";

/**
 * /keybindings（别名 /keys）命令实现（按需加载）。对齐 claude-code §4.3。
 *
 * 无参 → 打印 keybindings.json 路径 + 当前生效键位表（合并用户配置后）+ 是否已应用用户配置。
 * init → 文件不存在则写一份带示例的模板（照 terminal-setup 备份策略：已存在先备份），
 *        已存在则只提示路径不覆盖。
 *
 * 改 keybindings.json 后需重启生效（loadUserBindings 仅在启动读一次），命令里会提示。
 */

/** 模板内容：给几条按 schema 的示例绑定 + 注释性字段，帮用户上手。 */
function templateContent(): string {
  return JSON.stringify(
    {
      // 每条绑定：action 取自内置动作 ID（用 /keybindings 查看全部），stroke 描述按键。
      // 改后重启 sid-code 生效。
      bindings: [
        { action: "app:toggleMarkdown", stroke: { alt: true, name: "m" } },
        { action: "app:clearScreen", stroke: { ctrl: true, name: "l" } },
      ],
    },
    null,
    2,
  );
}

const mod: LocalCommandModule = {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const { userBindingsPath, loadUserBindings } =
      await import("../../../ui/keybindings/loadUserBindings.ts");
    const path = userBindingsPath();
    const sub = args.trim().toLowerCase();

    // ── init：创建模板 ──
    if (sub === "init" || sub === "create") {
      if (existsSync(path)) {
        return {
          type: "text",
          value: `keybindings.json 已存在，未覆盖。\n路径: ${path}\n直接编辑该文件即可，改后重启生效。`,
        };
      }
      try {
        writeFileSync(path, templateContent(), "utf-8");
        return {
          type: "text",
          value:
            `已创建键位配置模板。\n路径: ${path}\n` +
            `编辑后重启 sid-code 生效。用 /keybindings 查看全部可绑定动作。`,
        };
      } catch (e) {
        getLogger().error("KEYBINDING", `写入模板失败: ${(e as Error)?.message}`);
        return {
          type: "text",
          value: `写入模板失败: ${(e as Error)?.message ?? e}\n路径: ${path}`,
        };
      }
    }

    // ── 无参：展示路径 + 当前生效键位 ──
    const { bindings, userConfigApplied } = await loadUserBindings();
    const lines: string[] = [
      "键位绑定:",
      `  配置文件: ${path}${existsSync(path) ? "" : "（不存在，可用 /keybindings init 创建模板）"}`,
      `  用户配置: ${userConfigApplied ? "已应用" : "未应用（使用默认键位）"}`,
      "",
    ];
    // 只列展示项（showInHelp），避免刷屏。
    for (const b of bindings) {
      if (!b.showInHelp) continue;
      lines.push(`  ${b.display.padEnd(14)} ${b.description}  [${b.action}]`);
    }
    lines.push("", "提示: 编辑 keybindings.json 后需重启 sid-code 生效。");
    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
export { templateContent };
