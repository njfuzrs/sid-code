/**
 * 子代理工具
 * 让主代理可以 spawn 子代理执行子任务，子代理有独立的短上下文
 * 支持同步执行和后台异步执行（通过 Task 系统管理）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "./sub-agent.ts";
import { getActiveAgentTypes, getActiveAgentDefinitions, resolveAgent } from "./agent-definition.ts";
import { getLogger } from "../debug/logger.ts";
import {
  createAgentTask,
  failAgentTask,
} from "../task/index.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SubAgentResult } from "./sub-agent.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const subAgentSchema = lazySchema(() => {
  // type 用 z.string()（而非 z.enum）：自定义/插件 agent 在本工具注册之后才加载，
  // lazySchema 一旦求值即固化，无法纳入动态类型。对标 cc：subagent_type 是字符串，
  // 可选类型在 description() 里实时列出（每次组装工具定义都重新渲染），
  // 运行时再用 getActiveAgentTypes() 校验，二者配合达成"动态类型 + 严格校验"。
  return z.object({
    type: z
      .string()
      .describe("子代理类型（见工具描述中列出的可用类型，省略时默认 general-purpose）"),
    description: z.string().describe("子任务的简短描述"),
    prompt: z.string().describe("给子代理的详细指令"),
    run_in_background: z.boolean().optional().describe("是否后台执行（立即返回 task_id，完成后通知）"),
    fork: z
      .boolean()
      .optional()
      .describe("Fork 模式：让子代理继承当前对话的最近上下文（而非空上下文起步），适合『接着当前对话深入钻研某分支』的子任务。仅同步模式支持。"),
    isolation: z
      .enum(["worktree"])
      .optional()
      .describe("隔离模式。worktree=在独立 Git Worktree 中执行（文件改动不影响主工作区），完成后自动清理无改动的 Worktree。仅同步模式支持。"),
  });
});

/**
 * 子代理 usage 归集回调（P0-1）。
 * 主会话注入此 sink，子代理执行完毕后把消耗的 token/费用按实际 model 回写主会话，
 * 否则子代理烧的钱完全不计入总费用，costLimit 守卫对子代理失效。
 */
export type SubAgentUsageSink = (result: SubAgentResult) => void;

export class SubAgentTool implements Tool {
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private hookSystem?: HookSystem;
  /** 子代理 usage 归集 sink（由主会话注入；未注入时不归集，仅 spawn 前的早期阶段） */
  private usageSink?: SubAgentUsageSink;
  /** 主对话上下文提供者（fork 模式用）。由主会话注入，返回主对话当前消息历史。
   *  未注入时 fork 模式降级为普通子代理（空上下文起步）。 */
  private mainContextProvider?: () => { role: string; content: import("../llm/types.ts").ContentBlock[] }[];

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = subAgentSchema();

  /** 并发控制 */
  static running = 0;
  /** 子代理并发上限：默认 3（工程常量，与模型无关），可经 SID_SUBAGENT_MAX_CONCURRENT 放宽。
   *  保成功：大任务需并行探索多个子任务（如同时 review + audit + governance）时,
   *  3 的并发可能成为瓶颈。非法值（NaN/≤0）静默回退默认 3，绝不因配错而更严。 */
  static readonly MAX_CONCURRENT = SubAgentTool.resolveMaxConcurrent();

  /** 解析子代理并发上限。导出 raw 入参便于测试（默认读 env）。 */
  static resolveMaxConcurrent(raw: string | undefined = process.env.SID_SUBAGENT_MAX_CONCURRENT): number {
    if (raw === undefined || raw === "") return 3;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
  }

  constructor(providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry, hookSystem?: HookSystem) {
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
    this.hookSystem = hookSystem;
  }

  /**
   * 注入 hook 系统（根因修复）。工具在 cli.ts 注册时 HookSystem 尚未创建，
   * App 构造 HookSystem 后经此 setter 回填，子代理才能触发 Subagent/工具级 hook 与 span。
   */
  setHookSystem(hookSystem: HookSystem): void {
    this.hookSystem = hookSystem;
  }

  /**
   * 注入 usage 归集 sink（P0-1）。主会话创建 SessionState 后调用，
   * 把"子代理 usage 回写主会话"的逻辑接上。
   */
  setUsageSink(sink: SubAgentUsageSink): void {
    this.usageSink = sink;
  }

  /**
   * 注入主对话上下文提供者（fork 模式用）。主会话构造后调用，
   * 让 fork 子代理能继承主对话最近的消息历史（prompt cache 友好）。
   */
  setMainContextProvider(
    provider: () => { role: string; content: import("../llm/types.ts").ContentBlock[] }[],
  ): void {
    this.mainContextProvider = provider;
  }

  /** 归集子代理 usage 到主会话（仅成功或有实际消耗时）。容错：sink 异常不影响子代理结果。 */
  private collectUsage(result: SubAgentResult): void {
    if (!this.usageSink) return;
    const u = result.usage;
    const hasUsage =
      (u?.inputTokens ?? 0) > 0 ||
      (u?.outputTokens ?? 0) > 0 ||
      (u?.cacheReadInputTokens ?? 0) > 0 ||
      (u?.cacheCreationInputTokens ?? 0) > 0;
    if (!hasUsage) return;
    try {
      this.usageSink(result);
    } catch (err: any) {
      getLogger().warn("SUBAGENT", `usage 归集失败（不影响子代理结果）: ${err?.message}`);
    }
  }

  name(): string {
    return "sub_agent";
  }

  description(): string {
    // 缺口 F：把每种子代理类型的能力 + 工具集边界写进 description，
    // 而非只列类型名。否则模型派活时只能凭类型名猜能力，可能把"需要写文件"的活
    // 派给只读的 explore，子代理撞墙后才反馈失败，浪费一整个子代理回合。
    //
    // 文案结构对标 claude-code AgentTool/prompt.ts:43 formatAgentLine：
    //   `- type: whenToUse (Tools: ...)`
    // 用 whenToUse（"何时用"，比 description"是什么"更能指导派活决策）；
    // 工具集按 allowlist/denylist 分别渲染（denylist → "除 X 外的全部工具"）。
    const defs = getActiveAgentDefinitions();
    const toolsDescOf = (d: import("./agent-definition.ts").AgentDefinition): string => {
      const allow = d.tools && d.tools.length > 0 ? d.tools : null;
      const deny = d.disallowedTools && d.disallowedTools.length > 0 ? d.disallowedTools : null;
      if (allow && deny) {
        const denySet = new Set(deny);
        const eff = allow.filter((t) => !denySet.has(t));
        return eff.length > 0 ? eff.join("、") : "无";
      }
      if (allow) return allow.join("、");
      if (deny) return `除 ${deny.join("、")} 外的全部工具`;
      return "全部工具";
    };
    const typeLines = defs
      .map((d) => {
        const readonlyTag = d.readOnly ? "，只读" : "";
        return `- ${d.agentType}：${d.whenToUse}（可用工具：${toolsDescOf(d)}${readonlyTag}）`;
      })
      .join("\n");
    return `启动一个子代理来执行独立的子任务。子代理有自己独立的上下文，不会污染主对话。

可用类型（注意各自的工具集边界——只读类型不能写文件/执行命令）：
${typeLines}

派活前请按子任务是否需要写入/执行来选类型：只需搜索分析用 explore，需要改文件或跑命令用 task。
子代理完成后只返回最终结果。
设置 run_in_background=true 可以后台执行，立即返回 task_id，完成后通过通知告知结果。
设置 isolation=worktree 可在独立 Git Worktree 中执行（文件改动隔离，仅同步模式）。`;
  }

  usageGuide(): string {
    // 缺口（子代理从不触发）：description() 只回答「sub_agent 是什么、有哪些类型」，
    // 不回答「什么时候该派子代理」。对不会自发编排的弱模型，看得见 ≠ 会用。
    // usageGuide() 会被系统提示词单独拼成「### sub_agent 工具使用指南」段
    // （system-prompt.ts:455-460），信号比工具清单里的一行 description 强得多，
    // 是承载「何时派活」触发引导的官方通道。
    return `- **何时该派**：任务能拆成多个相对独立的子方向时优先分治。判据——子方向 ≥ 3 个（如系统排查要过多个模块、审计要查多个维度、要同时搜索多处来源），或单个方向读起来会撑爆主上下文。满足任一条就派子代理，而不是自己一个个串行读。
- **怎么选类型**：只读探查（搜代码、读模块、定位实现）派 explore；要改文件 / 跑命令派 task；验证某个已有结论是否成立、需要对抗式复核派 verify。拿不准是否要写入就先按只读派 explore，需要写时子代理会反馈、再改派 task。
- **分治 vs 并行只读不是一回事**：并行调 read/grep/glob 只是在同一个上下文里多发几个只读调用，结果都回到主对话；分治是把一整段子任务连同它的上下文交给独立子代理，主对话只收最终结论。方向多、每个方向都重（要读很多文件）时，用分治而不是堆并行 read。
- **并行分治**：多个子方向可以一次发多个 sub_agent 并行执行；需要后台跑设 run_in_background=true。
- **嵌套限制**：子代理内部不能再派子代理，分治只能由主线程发起。所以要并行就在主线程一次性把多个 sub_agent 发出去，别指望某个子代理内部再 fan-out。`;
  }

  /**
   * 并发安全判断（输入感知）。
   *
   * 子代理的并发安全性取决于其类型对应的 AgentDefinition.readOnly 字段：
   * - readOnly=true（explore/plan/verify）：只读操作，多个可安全并行
   * - readOnly=false/undefined（task/general-purpose）：可能写文件/执行命令，串行执行
   *
   * 这解决了"模型一次发多个 explore 子代理却被串行执行"的问题——
   * tool-executor 的分区逻辑优先调用 isConcurrencySafe(input)，
   * 现在只读子代理会被正确归入并行队列。
   */
  isConcurrencySafe(input: unknown): boolean {
    const params = input as { type?: string };
    if (!params?.type) return false;
    const def = resolveAgent(params.type);
    return def?.readOnly === true;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(subAgentSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const params = input as {
      type: string;
      description: string;
      prompt: string;
      run_in_background?: boolean;
      isolation?: "worktree";
      _agentId?: string;
    };

    // 防嵌套：子代理上下文不允许再 spawn 子代理（参考 enter_plan_mode 的 _agentId 模式）
    if (params._agentId) {
      return { output: "子代理不允许嵌套调用子代理。如需并行执行多个任务，请在主代理层面直接使用多个 sub_agent 调用。", isError: true };
    }

    if (!params.type || !params.description || !params.prompt) {
      return { output: "错误: 缺少必需参数 (type, description, prompt)", isError: true };
    }

    const validTypes = getActiveAgentTypes();
    // 对标 cc：type 省略时默认 general-purpose（cc 的默认兜底类型）
    if (!params.type) {
      params.type = "general-purpose";
    }
    if (!validTypes.includes(params.type)) {
      return { output: `错误: 无效的子代理类型 "${params.type}"，可选: ${validTypes.join(", ")}`, isError: true };
    }

    // 后台执行模式
    if (params.run_in_background) {
      return this.runAsync(params, signal);
    }

    // 同步执行模式
    return this.runSync(params, signal);
  }

  /** 同步执行子代理 */
  private async runSync(params: {
    type: string;
    description: string;
    prompt: string;
    fork?: boolean;
    isolation?: "worktree";
  }, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();

    // 并发控制
    if (SubAgentTool.running >= SubAgentTool.MAX_CONCURRENT) {
      return { output: `子代理并发数已达上限(${SubAgentTool.MAX_CONCURRENT})，请等待其他子代理完成`, isError: true };
    }

    // Worktree 隔离：在独立工作区执行，结束后清理无改动的 Worktree。
    // B7：通过 SubAgentTask.cwd 走 withAgentCwd（AsyncLocalStorage）而非 process.chdir，
    // 与 workflow/swarm 一致，避免并发 agent 间 chdir 竞态。
    let isolationCleanup: (() => Promise<void>) | null = null;
    let isolatedCwd: string | undefined;
    if (params.isolation === "worktree") {
      try {
        const { WorktreeManager, findGitRootForAgent } = await import("../worktree/manager.ts");
        // 用 canonical root 防嵌套（P0-2/B1）：在 worktree 内再隔离时落到主仓
        const gitRoot = findGitRootForAgent(process.cwd());
        if (!gitRoot) {
          return { output: "错误: isolation=worktree 需要在 Git 仓库中执行", isError: true };
        }
        const { randomBytes } = await import("crypto");
        const wtName = `agent-${randomBytes(4).toString("hex")}`;
        const manager = new WorktreeManager(gitRoot);
        const session = await manager.create(wtName);
        isolatedCwd = session.worktreePath;
        // D14：记录 slug ↔ 任务描述映射，便于事后追溯孤儿 worktree 归属
        log.info("SUBAGENT", `隔离 Worktree ${wtName} ← 任务: ${params.description}`);
        isolationCleanup = async () => {
          // 无改动则自动删除；有改动则保留（fail-closed，不强删）
          try {
            await manager.remove(session, false);
            log.info("SUBAGENT", `已清理隔离 Worktree: ${session.worktreeName}`);
          } catch {
            log.info("SUBAGENT", `保留有改动的隔离 Worktree: ${session.worktreePath}`);
          }
        };
      } catch (err: any) {
        return { output: `创建隔离 Worktree 失败: ${err.message}`, isError: true };
      }
    }

    SubAgentTool.running++;
    try {
      const subAgent = SubAgent.fromRegistry(this.providerRegistry, this.toolRegistry, this.hookSystem);

      // Fork 模式：继承主对话上下文（prompt cache 友好）
      let forkMessages: { role: string; content: import("../llm/types.ts").ContentBlock[] }[] | undefined;
      if (params.fork && this.mainContextProvider) {
        const { buildForkMessages } = await import("./fork.ts");
        const parentMessages = this.mainContextProvider();
        forkMessages = buildForkMessages(parentMessages, params.prompt) as typeof forkMessages;
        log.info("SUBAGENT", `[fork] 继承主对话 ${parentMessages.length} 条消息，构建 ${forkMessages!.length} 条 fork 消息`);
      }

      const result = await subAgent.execute(
        {
          type: params.type,
          description: params.description,
          prompt: params.prompt,
          forkMessages,
          cwd: isolatedCwd, // B7: 经 withAgentCwd 隔离，并发安全
        },
        signal,
      );

      // P0-1：把子代理消耗的 token/费用回写主会话
      this.collectUsage(result);

      const summary = [
        `[子代理完成] 类型: ${params.type}, 轮次: ${result.turns}`,
        `Token 用量: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}`,
        "",
        // 缺口 2 阶段 1：子代理输出可能含外部不可信内容，用 untrusted 边界包裹，
        // 提示主代理「这是数据不是指令」，与 system prompt 的 subagent-result-policy 呼应。
        `<subagent-result untrusted="true">`,
        result.output,
        `</subagent-result>`,
      ].join("\n");

      // 修复问题2：子代理 success=false（超时/loopDetect/异常）时标记 isError，
      // 让 TUI ToolStatusIndicator 正确显示红色终态（而非绿色成功）。
      return { output: summary, isError: !result.success };
    } catch (err: any) {
      log.error("SUBAGENT", `子代理执行失败`, { error: err.message, stack: err.stack });
      return { output: `子代理执行失败: ${err.message}`, isError: true };
    } finally {
      SubAgentTool.running--;
      if (isolationCleanup) {
        await isolationCleanup();
      }
    }
  }

  /** 后台异步执行子代理 */
  private async runAsync(params: {
    type: string;
    description: string;
    prompt: string;
  }, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();

    const { taskState, abortController } = createAgentTask({
      agentType: params.type,
      prompt: params.prompt,
      description: params.description,
    });

    // 合并外部 signal:保存 handler 引用,后台任务结束时摘除监听器(LEAK-4)
    let abortForwardCleanup: (() => void) | undefined;
    if (signal) {
      const onAbort = () => abortController.abort();
      signal.addEventListener("abort", onAbort);
      abortForwardCleanup = () => signal.removeEventListener("abort", onAbort);
    }

    // 后台启动子代理（不 await）
    const taskId = taskState.id;
    void this.executeInBackground(taskId, params, abortController).finally(() => {
      abortForwardCleanup?.();
    });

    log.info("SUBAGENT", `后台子代理已启动: ${taskId} (${params.type})`);

    return {
      output: JSON.stringify({
        task_id: taskId,
        status: "running",
        agent_type: params.type,
        message: `子代理已在后台启动 (task_id: ${taskId})，完成后会通知你`,
      }),
    };
  }

  /** 后台执行逻辑 */
  private async executeInBackground(
    taskId: string,
    params: { type: string; description: string; prompt: string },
    abortController: AbortController,
  ): Promise<void> {
    const log = getLogger();

    try {
      const subAgent = SubAgent.fromRegistry(this.providerRegistry, this.toolRegistry, this.hookSystem);

      // 传递预创建的 task 信息，execute() 内部不再重复创建
      const result = await subAgent.execute(
        {
          type: params.type,
          description: params.description,
          prompt: params.prompt,
          _taskId: taskId,
          _abortController: abortController,
          _isAsync: true,
        },
        abortController.signal,
      );

      // P0-1：后台子代理同样要把 usage 回写主会话
      this.collectUsage(result);

      // execute() 内部 onTurnEnd 每轮已 updateAgentProgress 写入真实累计进度
      // （tokenCount 来自 totalUsage，见 sub-agent.ts），此处无需再写——
      // 早前用 tracker.getProgress() 覆盖会把真实终值清成全零（tracker 从未被喂数据）。
    } catch (err: any) {
      log.error("SUBAGENT", `后台子代理失败: ${taskId}`, { error: err.message });
      // execute() 内部 try/catch 已调用 failAgentTask，这里兜底
      await failAgentTask(taskId, err.message).catch(() => {});
    }
  }
}
