/**
 * 扩展管理命令
 * 支持 skills/agents/commands 的列表查看和启用/禁用
 */

import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";

/** /commands 命令 */
export class CommandsListCommand implements LocalCommandModule {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数 → 打开交互式命令浏览面板
    if (!_args.trim()) {
      return { type: "dialog", dialog: "commands" };
    }

    const loader = new ExtensionLoader();
    const files = await loader.scan("commands", process.cwd());

    if (files.length === 0) {
      return {
        type: "text",
        value:
          "未找到自定义命令\n在 .sid-code/commands/ 或 ~/.sid-code/commands/ 目录添加 .md 文件",
      };
    }

    const lines = ["自定义命令:"];
    const userCommands = files.filter((f) => f.source === "user");
    const projectCommands = files.filter((f) => f.source === "project");

    if (userCommands.length > 0) {
      lines.push("\n用户级 (~/.sid-code/commands/):");
      for (const cmd of userCommands) {
        const desc = cmd.frontmatter.description || "";
        lines.push(`  /${cmd.name}${desc ? ` - ${desc}` : ""}`);
      }
    }

    if (projectCommands.length > 0) {
      lines.push("\n项目级 (.sid-code/commands/):");
      for (const cmd of projectCommands) {
        const desc = cmd.frontmatter.description || "";
        lines.push(`  /${cmd.name}${desc ? ` - ${desc}` : ""}`);
      }
    }

    return { type: "text", value: lines.join("\n") };
  }
}
