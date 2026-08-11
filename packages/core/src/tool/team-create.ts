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
          depends_on: z
            .array(z.string())
            .optional()
            .describe("依赖的其他成员名列表：这些成员完成后本成员才开始（用于有序编排，如测试成员依赖实现成员）。不填=无依赖，立即并发"),
        }),
      )
      .describe("团队成员列表"),
    shared_tasks: z
      .array(
        z.object({
          subject: z.string().describe("任务标题（简短）"),
          description: z.string().describe("任务详细要求"),
        }),
      )
      .optional()
      .describe(
        "共享任务池：不预先指派给具体成员的任务。成员做完自己的 task 后会主动认领这里的任务，直到池空——适合「有 N 件零散活、谁空谁做」的场景。不填=成员只做各自的 task",
      ),
  }),
);

/**
 * Agent Teams 实验开关（对齐 CC 的 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 定位）。
 *
 * Teams 会并发起多个子代理、各自开 worktree、跑满 15 分钟硬超时——成本与副作用都远大于
 * 单个 sub_agent。CC 把它放在实验开关后面，sid-code 此前无条件注册，模型可能在用户没有
 * 预期的情况下拉起一整个团队。这里补上对等开关：**默认关闭**，开启才可用。
 *
 * 关闭时工具仍注册（保留可发现性 + 明确的引导错误），但调用直接返回提示，不会真的起团队。
 */
export function isAgentTeamsEnabled(
  raw: string | undefined = process.env.SID_ENABLE_AGENT_TEAMS,
): boolean {
  return raw === "1" || raw === "true";
}

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
    // 开关关闭时在描述里直说，避免模型反复尝试再吃错误（白烧 token）。
    if (!isAgentTeamsEnabled()) {
      return `[实验特性，当前未启用] 多代理团队协作。需设 SID_ENABLE_AGENT_TEAMS=1 才可用。
未启用时请改用多个并行的 sub_agent 调用做分治。`;
    }
    return `创建一个多代理团队，让多个子代理各自承担一个任务并行/隔离执行，最后汇总结果。
适用于可分解为多个独立子任务的复杂工作（如：A 改前端、B 改后端、C 写测试）。
每个会改文件的成员默认在独立 Git Worktree 中执行（文件隔离，互不冲突）。
成员之间通过团队邮箱通信（成员可用 team_message 工具给 leader 或其他成员发消息），结果统一回汇给你。
可用 shared_tasks 放一批不指派给具体成员的任务：成员做完自己的 task 后会主动认领，直到池空。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(teamCreateSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      team_name?: string;
      members?: Array<Omit<TeammateSpec, "dependsOn"> & { depends_on?: string[] }>;
      shared_tasks?: Array<{ subject: string; description: string }>;
    };

    // P3-2：实验开关闸门——默认关闭。Teams 会并发拉起多个子代理 + worktree，
    // 成本远高于单个 sub_agent，需用户显式 opt-in（对齐 CC 的实验性定位）。
    if (!isAgentTeamsEnabled()) {
      return {
        output:
          "Agent Teams 是实验特性，当前未启用（设 SID_ENABLE_AGENT_TEAMS=1 开启）。\n" +
          "替代方案：用多个并行的 sub_agent 调用做分治——同样能并发执行，且成本可控。",
        isError: true,
      };
    }

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

    // P2-2：校验 depends_on 引用的成员名都存在（引用不存在的成员是明显的编排错误，早失败）。
    for (const m of params.members) {
      if (!m.depends_on) continue;
      for (const dep of m.depends_on) {
        if (!names.has(dep)) {
          return { output: `错误: 成员 "${m.name}" 的依赖 "${dep}" 不是有效成员名`, isError: true };
        }
        if (dep === m.name) {
          return { output: `错误: 成员 "${m.name}" 不能依赖自己`, isError: true };
        }
      }
    }

    try {
      // 协议层字段名是 depends_on；TeammateSpec.dependsOn 是 swarm 内部数据模型（team.ts 多处
      // 消费），不跟着改。此处做一次桥接——漏掉它会让依赖编排静默失效（dependsOn 恒 undefined，
      // 所有成员退化成无依赖并发），而不是报错，属于最难发现的一类缺陷。
      const members: TeammateSpec[] = params.members.map(({ depends_on, ...rest }) => ({
        ...rest,
        ...(depends_on ? { dependsOn: depends_on } : {}),
      }));

      const team = new TeamManager({
        teamName: params.team_name,
        members,
        providerRegistry: this.providerRegistry,
        toolRegistry: this.toolRegistry,
        subAgentChecker: this.permissionChecker,
        hookSystem: this.hookSystem,
        // P2-2：共享任务池（成员做完自己的活后认领）
        sharedTasks: params.shared_tasks,
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
      // P3-2：tmux 观察模式生效时告知 attach 方式（降级为 in-process 时 session 为 null，不提示）。
      const tmuxSession = team.getTmuxSession();
      if (tmuxSession) {
        lines.push(`观察窗（每个成员一个 window）: tmux attach -t ${tmuxSession}`, "");
      }
      for (const r of results) {
        const header = colorize(`── ${r.name} (${r.success ? "成功" : "失败"}) ──`, r.color);
        lines.push(header);
        lines.push(r.output);
        // P2-2：额外认领了共享池任务时标注数量，让 leader 看清活是怎么分掉的。
        if (r.claimedTaskCount) lines.push(`  (额外认领共享任务: ${r.claimedTaskCount} 个)`);
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
