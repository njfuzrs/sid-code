/**
 * TeamCreateTool（Spec 18 §7.3.4）
 * 创建一个多代理团队并并发/隔离执行各成员任务，返回汇总结果。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { TeamManager, type TeammateSpec } from "../swarm/team.ts";
import { getActiveAgentTypes } from "../agent/agent-definition.ts";
import { colorize } from "../agent/color.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const teamCreateSchema = lazySchema(() =>
  z.object({
    team_name: z.string().describe("团队名称"),
    members: z
      .array(
        z.object({
          name: z.string().describe("成员名（团队内唯一）"),
          type: z.string().describe("子代理类型（见 sub_agent 工具描述中列出的可用类型）"),
          task: z.string().describe("分配给该成员的任务"),
          isolated: z.boolean().optional().describe("是否在独立 Worktree 执行（会改文件的成员应为 true，默认 true）"),
        }),
      )
      .describe("团队成员列表"),
  }),
);

export class TeamCreateTool implements Tool {
  readonly zodSchema = teamCreateSchema();
  /** 长尾工具：多代理协作低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "team swarm multi-agent collaboration 团队 多代理 协作";
  /** 权限检查器（子代理 dontAsk 语义，由主会话注入） */
  private permissionChecker?: import("../permission/types.ts").Checker;
  /** leader 权限确认回调（由主会话注入） */
  private permissionConfirm?: (desc: string) => Promise<boolean>;
  /** G11：Hook 系统（主会话注入，用于 teammate 空闲时触发 TeammateIdle） */
  private hookSystem?: import("../hook/system.ts").HookSystem;

  constructor(
    private providerRegistry: ProviderRegistry,
    private toolRegistry: ToolRegistry,
  ) {}

  /** 注入权限检查器（子代理 dontAsk 语义） */
  setPermissionChecker(checker: import("../permission/types.ts").Checker): void {
    this.permissionChecker = checker;
  }

  /** G11：注入 Hook 系统（用于 TeammateIdle 事件） */
  setHookSystem(hookSystem: import("../hook/system.ts").HookSystem): void {
    this.hookSystem = hookSystem;
  }

  /** 注入 leader 权限确认回调（swarm teammate 需确认时转发给 leader） */
  setPermissionConfirm(confirm: (desc: string) => Promise<boolean>): void {
    this.permissionConfirm = confirm;
  }

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
    return z.toJSONSchema(teamCreateSchema()) as Record<string, unknown>;
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

    // 成员名唯一性校验 + 类型有效性校验
    const names = new Set<string>();
    const validTypes = getActiveAgentTypes();
    for (const m of params.members) {
      if (!m.name || !m.type || !m.task) {
        return { output: "错误: 每个成员需要 name、type、task", isError: true };
      }
      if (names.has(m.name)) {
        return { output: `错误: 成员名重复 "${m.name}"`, isError: true };
      }
      // 对标 sub_agent 工具：运行时校验成员类型有效性（支持动态注册的自定义/插件 Agent）
      if (!validTypes.includes(m.type)) {
        return { output: `错误: 成员 "${m.name}" 的无效子代理类型 "${m.type}"，可选: ${validTypes.join(", ")}`, isError: true };
      }
      names.add(m.name);
    }

    try {
      const team = new TeamManager({
        teamName: params.team_name,
        members: params.members,
        providerRegistry: this.providerRegistry,
        toolRegistry: this.toolRegistry,
        subAgentChecker: this.permissionChecker,
        hookSystem: this.hookSystem,
        permissionArbiter: this.permissionConfirm
          ? async (req) => {
              const desc = `[${req.teammate}] 请求执行 ${req.toolName}: ${req.description}`;
              const allowed = await this.permissionConfirm!(desc);
              return allowed ? "allow" : "deny";
            }
          : undefined,
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
