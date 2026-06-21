/**
 * SendMessageTool — 向运行中或已完成的后台 Agent 发送消息
 * 支持追加指令和自动唤醒已停止的 Agent（Resume 能力，对标 cc resumeAgent）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getTask,
  isTerminalStatus,
  isAgentTask,
  createAgentTask,
  completeAgentTask,
  failAgentTask,
} from "../task/index.ts";
import type { LocalAgentTaskState } from "../task/types.ts";
import { injectMessageToAgent } from "../agent/message-queue.ts";
import { SubAgent } from "../agent/sub-agent.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const sendMessageSchema = lazySchema(() =>
  z.object({
    to: z.string().describe("目标 Agent 的 task_id"),
    message: z.string().describe("要发送的消息内容"),
    summary: z.string().optional().describe("消息摘要（可选，用于通知显示）"),
  }),
);

export class SendMessageTool implements Tool {
  readonly zodSchema = sendMessageSchema();
  /** 长尾工具:代理间消息低频使用,延迟加载,由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "send message agent communication resume 发送 消息 代理 通信 恢复 续传";

  private providerRegistry?: ProviderRegistry;
  private toolRegistry?: ToolRegistry;

  constructor(providerRegistry?: ProviderRegistry, toolRegistry?: ToolRegistry) {
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
  }

  name(): string {
    return "send_message";
  }

  description(): string {
    return `向一个后台 Agent 发送消息。
- Agent 正在运行：消息注入到其对话循环中（立即生效）
- Agent 已终止（completed/failed）：自动 resume——基于原上下文重启 Agent 并注入新消息（保留 task_id 便于继续追踪）`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(sendMessageSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const { to, message } = input as {
      to: string;
      message: string;
      summary?: string;
    };

    if (!to || !message) {
      return { output: "错误: 缺少必需参数 (to, message)", isError: true };
    }

    const task = getTask(to);
    if (!task || !isAgentTask(task)) {
      return { output: `目标 Agent "${to}" 不存在或不是 Agent 类型任务`, isError: true };
    }

    if (task.status === "running") {
      injectMessageToAgent(to, message);
      return {
        output: JSON.stringify({
          status: "delivered",
          agent_id: to,
          message: "消息已注入到 Agent 对话循环",
        }),
      };
    }

    // Resume 已终态 Agent（对标 cc resumeAgent）
    if (isTerminalStatus(task.status)) {
      return this.resumeAgent(task as LocalAgentTaskState, message);
    }

    return { output: `Agent "${to}" 状态异常: ${task.status}`, isError: true };
  }

  /**
   * Resume 已终态 Agent：基于原任务上下文(prompt + output)重启 Agent。
   *
   * 对标 cc resumeAgent：不解析完整 JSONL transcript（复杂度高），
   * 而是用轻量续传——把原 prompt + 原 output 作为上下文前缀，新消息作为续传指令，
   * 创建新的后台 agent task 继续执行。调用方得到新 task_id 便于追踪。
   *
   * 这比 cc 的"从完整 transcript 恢复"轻量得多，但覆盖了主要用例：
   * 用户觉得子代理做完后"还差一步"时，能直接续传而不是从头再来。
   */
  private async resumeAgent(task: LocalAgentTaskState, message: string): Promise<ToolResult> {
    const log = getLogger();

    if (!this.providerRegistry || !this.toolRegistry) {
      return {
        output: JSON.stringify({
          status: "cannot_resume",
          agent_id: task.id,
          message: "Resume 能力未就绪（缺少 Provider/Tool 注册表），请启动新的子代理。",
        }),
      };
    }

    // 构建续传 prompt：原上下文 + 原输出 + 新指令
    const originalOutput = task.result?.output ?? task.error ?? "(无输出)";
    const resumePrompt = [
      `[续传上下文] 你之前执行了以下任务并已完成：`,
      ``,
      `原始任务：${task.prompt}`,
      ``,
      `你的执行结果：`,
      originalOutput,
      ``,
      `---`,
      ``,
      `[续传指令] 基于以上上下文，现在继续执行以下新指令：`,
      ``,
      message,
    ].join("\n");

    // 创建新的后台 agent task
    const { taskState, abortController } = createAgentTask({
      agentType: task.agentType,
      prompt: resumePrompt,
      description: `[Resume] ${message.slice(0, 80)}`,
    });
    const newTaskId = taskState.id;

    // 后台执行（不 await）
    void (async () => {
      try {
        const subAgent = SubAgent.fromRegistry(this.providerRegistry!, this.toolRegistry!);
        const result = await subAgent.execute(
          {
            type: task.agentType,
            description: `[Resume] ${message.slice(0, 80)}`,
            prompt: resumePrompt,
          },
          abortController.signal,
        );
        completeAgentTask(newTaskId, {
          output: result.output,
          totalToolUseCount: result.toolUseCount,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        });
      } catch (err: any) {
        log.error("SUBAGENT", `Resume agent 执行失败: ${err.message}`);
        failAgentTask(newTaskId, err.message);
      }
    })();

    log.info("SUBAGENT", `Resume agent: 原 ${task.id} → 新 ${newTaskId} (${task.agentType})`);

    return {
      output: JSON.stringify({
        status: "resumed",
        original_agent_id: task.id,
        new_task_id: newTaskId,
        agent_type: task.agentType,
        message: `已恢复 Agent 执行（新 task_id: ${newTaskId}），完成后会通知你`,
      }),
    };
  }
}
