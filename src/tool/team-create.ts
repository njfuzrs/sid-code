/**
 * TeamCreateTool（Spec 18 §7.3.4）
 * 创建一个多代理团队并并发/隔离执行各成员任务，返回汇总结果。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { TeamManager, type TeammateSpec } from "../swarm/team.ts";
import { colorize } from "../agent/color.ts";
import { getLogger } from "../debug/logger.ts";

export class TeamCreateTool implements Tool {
  constructor(
    private providerRegistry: ProviderRegistry,
    private toolRegistry: ToolRegistry,
  ) {}

  name(): string {
    return "team_create";
  }

  description(): string {
    return `创建一个多代理团队，让多个子代理各自承担一个任务并行/隔离执行，最后汇总结果。
适用于可分解为多个独立子任务的复杂工作（如：A 改前端、B 改后端、C 写测试）。
每个会改文件的成员默认在独立 Git Worktree 中执行（文件隔离，互不冲突）。
成员之间通过团队邮箱通信，结果统一回汇给你。`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        team_name: { type: "string", description: "团队名称" },
        members: {
          type: "array",
          description: "团队成员列表",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "成员名（团队内唯一）" },
              type: {
                type: "string",
                enum: ["explore", "task", "summarize", "plan", "verify"],
                description: "子代理类型",
              },
              task: { type: "string", description: "分配给该成员的任务" },
              isolated: {
                type: "boolean",
                description: "是否在独立 Worktree 执行（会改文件的成员应为 true，默认 true）",
              },
            },
            required: ["name", "type", "task"],
          },
        },
      },
      required: ["team_name", "members"],
    };
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      team_name?: string;
      members?: TeammateSpec[];
    };

    if (!params.team_name || !Array.isArray(params.members) || params.members.length === 0) {
      return { output: "错误: 缺少必需参数 (team_name, members[])", isError: true };
    }

    // 成员名唯一性校验
    const names = new Set<string>();
    for (const m of params.members) {
      if (!m.name || !m.type || !m.task) {
        return { output: "错误: 每个成员需要 name、type、task", isError: true };
      }
      if (names.has(m.name)) {
        return { output: `错误: 成员名重复 "${m.name}"`, isError: true };
      }
      names.add(m.name);
    }

    try {
      const team = new TeamManager({
        teamName: params.team_name,
        members: params.members,
        providerRegistry: this.providerRegistry,
        toolRegistry: this.toolRegistry,
      });

      log.info("SWARM", `团队 "${params.team_name}" 启动，成员数: ${params.members.length}`);
      const results = await team.run(signal);

      const lines = [`[团队 ${params.team_name} 完成]`, ""];
      for (const r of results) {
        const header = colorize(`── ${r.name} (${r.success ? "成功" : "失败"}) ──`, r.color);
        lines.push(header);
        lines.push(r.output);
        if (r.worktreePath) lines.push(`  (Worktree: ${r.worktreePath})`);
        lines.push("");
      }

      return { output: lines.join("\n") };
    } catch (err: any) {
      log.error("SWARM", `团队执行失败: ${err.message}`);
      return { output: `团队执行失败: ${err.message}`, isError: true };
    }
  }
}
