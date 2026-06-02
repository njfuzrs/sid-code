/**
 * 子代理工具
 * 让主代理可以 spawn 子代理执行子任务，子代理有独立的短上下文
 * 支持同步执行和后台异步执行（通过 Task 系统管理）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "./sub-agent.ts";
import type { SubAgentType } from "./sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import {
  createAgentTask,
  completeAgentTask,
  failAgentTask,
  appendAgentOutput,
  updateAgentProgress,
} from "../task/index.ts";
import { ProgressTracker } from "./progress.ts";
import type { HookSystem } from "../hook/system.ts";

export class SubAgentTool implements Tool {
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private hookSystem?: HookSystem;

  /** 并发控制 */
  static running = 0;
  static readonly MAX_CONCURRENT = 3;

  constructor(providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry, hookSystem?: HookSystem) {
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
    this.hookSystem = hookSystem;
  }

  name(): string {
    return "sub_agent";
  }

  description(): string {
    return `启动一个子代理来执行独立的子任务。子代理有自己独立的上下文，不会污染主对话。
适用场景：
- explore: 搜索和分析代码库，返回关键发现
- task: 执行特定的编码子任务
- summarize: 总结大量内容
- plan: 分析代码库并输出结构化的实现方案
- verify: 对抗式验证某个结论/修复是否真实成立（只读，倾向证伪）
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
          enum: ["explore", "task", "summarize", "plan", "verify"],
          description: "子代理类型：explore(代码探索)、task(任务执行)、summarize(内容总结)、plan(代码分析和规划)、verify(对抗式验证)",
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
      type: SubAgentType;
      description: string;
      prompt: string;
      run_in_background?: boolean;
      isolation?: "worktree";
    };

    if (!params.type || !params.description || !params.prompt) {
      return { output: "错误: 缺少必需参数 (type, description, prompt)", isError: true };
    }

    const validTypes: SubAgentType[] = ["explore", "task", "summarize", "plan", "verify"];
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
    type: SubAgentType;
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
    type: SubAgentType;
    description: string;
    prompt: string;
  }, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();

    const { taskState, abortController } = createAgentTask({
      agentType: params.type,
      prompt: params.prompt,
      description: params.description,
    });

    // 合并外部 signal
    if (signal) {
      signal.addEventListener("abort", () => abortController.abort());
    }

    // 后台启动子代理（不 await）
    const taskId = taskState.id;
    void this.executeInBackground(taskId, params, abortController.signal);

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
    params: { type: SubAgentType; description: string; prompt: string },
    signal: AbortSignal,
  ): Promise<void> {
    const log = getLogger();
    const tracker = new ProgressTracker();

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

      appendAgentOutput(taskId, result.output);
      updateAgentProgress(taskId, tracker.getProgress());
      await completeAgentTask(taskId, result.output);
    } catch (err: any) {
      log.error("SUBAGENT", `后台子代理失败: ${taskId}`, { error: err.message });
      await failAgentTask(taskId, err.message);
    }
  }
}
