/**
 * 子代理工具
 * 让主代理可以 spawn 子代理执行子任务，子代理有独立的短上下文
 * 支持同步执行和后台异步执行（通过 Task 系统管理）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "./sub-agent.ts";
import { getBuiltInAgentTypes } from "./agent-definition.ts";
import { getLogger } from "../debug/logger.ts";
import {
  createAgentTask,
  failAgentTask,
  updateAgentProgress,
} from "../task/index.ts";
import { ProgressTracker } from "./progress.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SubAgentResult } from "./sub-agent.ts";

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

  /** 并发控制 */
  static running = 0;
  /** 子代理并发上限：默认 3（工程常量，与模型无关），可经 SID_SUBAGENT_MAX_CONCURRENT 放宽。
   *  保成功：大任务需并行探索多个子任务（如同时 review + audit + governance）时,
   *  3 的并发可能成为瓶颈。非法值（NaN/≤0）静默回退默认 3，绝不因配错而更严。 */
  static readonly MAX_CONCURRENT = SubAgentTool.resolveMaxConcurrent();

  private static resolveMaxConcurrent(): number {
    const raw = process.env.SID_SUBAGENT_MAX_CONCURRENT;
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
   * 注入 usage 归集 sink（P0-1）。主会话创建 SessionState 后调用，
   * 把"子代理 usage 回写主会话"的逻辑接上。
   */
  setUsageSink(sink: SubAgentUsageSink): void {
    this.usageSink = sink;
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
    const types = getBuiltInAgentTypes();
    return `启动一个子代理来执行独立的子任务。子代理有自己独立的上下文，不会污染主对话。
可用类型: ${types.join("、")}
子代理完成后只返回最终结果。
设置 run_in_background=true 可以后台执行，立即返回 task_id，完成后通过通知告知结果。
设置 isolation=worktree 可在独立 Git Worktree 中执行（文件改动隔离，仅同步模式）。`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: getBuiltInAgentTypes(),
          description: `子代理类型：${getBuiltInAgentTypes().join("、")}`,
        },
        description: {
          type: "string",
          description: "子任务的简短描述",
        },
        prompt: {
          type: "string",
          description: "给子代理的详细指令",
        },
        run_in_background: {
          type: "boolean",
          description: "是否后台执行（立即返回 task_id，完成后通知）",
        },
        isolation: {
          type: "string",
          enum: ["worktree"],
          description: "隔离模式。worktree=在独立 Git Worktree 中执行（文件改动不影响主工作区），完成后自动清理无改动的 Worktree。仅同步模式支持。",
        },
      },
      required: ["type", "description", "prompt"],
    };
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

    const validTypes = getBuiltInAgentTypes();
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
    isolation?: "worktree";
  }, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();

    // 并发控制
    if (SubAgentTool.running >= SubAgentTool.MAX_CONCURRENT) {
      return { output: `子代理并发数已达上限(${SubAgentTool.MAX_CONCURRENT})，请等待其他子代理完成`, isError: true };
    }

    // Worktree 隔离：在独立工作区执行，结束后清理无改动的 Worktree
    let isolationCleanup: (() => Promise<void>) | null = null;
    let originalCwd: string | null = null;
    if (params.isolation === "worktree") {
      try {
        const { WorktreeManager, findGitRoot } = await import("../worktree/manager.ts");
        const gitRoot = findGitRoot(process.cwd());
        if (!gitRoot) {
          return { output: "错误: isolation=worktree 需要在 Git 仓库中执行", isError: true };
        }
        const { randomBytes } = await import("crypto");
        const wtName = `agent-${randomBytes(4).toString("hex")}`;
        const manager = new WorktreeManager(gitRoot);
        const session = await manager.create(wtName);
        originalCwd = process.cwd();
        process.chdir(session.worktreePath);
        isolationCleanup = async () => {
          if (originalCwd) {
            try { process.chdir(originalCwd); } catch { /* 忽略 */ }
          }
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

      const result = await subAgent.execute(
        {
          type: params.type,
          description: params.description,
          prompt: params.prompt,
        },
        signal,
      );

      // P0-1：把子代理消耗的 token/费用回写主会话
      this.collectUsage(result);

      const summary = [
        `[子代理完成] 类型: ${params.type}, 轮次: ${result.turns}`,
        `Token 用量: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}`,
        "",
        result.output,
      ].join("\n");

      return { output: summary };
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
    const tracker = new ProgressTracker();

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
        },
        abortController.signal,
      );

      // P0-1：后台子代理同样要把 usage 回写主会话
      this.collectUsage(result);

      // execute() 内部已调用 completeAgentTask/failAgentTask，这里只更新进度
      updateAgentProgress(taskId, tracker.getProgress());
    } catch (err: any) {
      log.error("SUBAGENT", `后台子代理失败: ${taskId}`, { error: err.message });
      // execute() 内部 try/catch 已调用 failAgentTask，这里兜底
      await failAgentTask(taskId, err.message).catch(() => {});
    }
  }
}
