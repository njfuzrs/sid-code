/**
 * 扩展管理命令
 * 支持 skills/agents/commands 的列表查看和启用/禁用
 */

import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";

/** /agents 命令 */
export class AgentsCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    return new AgentsListCommand().call(args, ctx);
  }
}

/** /agents list - 列出所有自定义 agents */
export class AgentsListCommand implements LocalCommandModule {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const loader = new ExtensionLoader();
    const files = await loader.scan("agents", process.cwd());

    if (files.length === 0) {
      return {
        type: "text",
        value: "未找到自定义 agents\n在 .sid-code/agents/ 或 ~/.sid-code/agents/ 目录添加 .md 文件",
      };
    }

    const lines = ["自定义 Agents:"];
    const userAgents = files.filter((f) => f.source === "user");
    const projectAgents = files.filter((f) => f.source === "project");

    if (userAgents.length > 0) {
      lines.push("\n用户级 (~/.sid-code/agents/):");
      for (const agent of userAgents) {
        const desc = agent.frontmatter.description || "";
        const tools = agent.frontmatter.tools || [];
        const toolsStr = Array.isArray(tools) ? ` [工具: ${tools.join(", ")}]` : "";
        lines.push(`  • ${agent.name}${desc ? ` - ${desc}` : ""}${toolsStr}`);
      }
    }

    if (projectAgents.length > 0) {
      lines.push("\n项目级 (.sid-code/agents/):");
      for (const agent of projectAgents) {
        const desc = agent.frontmatter.description || "";
        const tools = agent.frontmatter.tools || [];
        const toolsStr = Array.isArray(tools) ? ` [工具: ${tools.join(", ")}]` : "";
        lines.push(`  • ${agent.name}${desc ? ` - ${desc}` : ""}${toolsStr}`);
      }
    }

    return { type: "text", value: lines.join("\n") };
  }
}
