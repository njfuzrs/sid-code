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
  /** P2-3：分派/通信类工具，每次发给不同代理、内容天然不同，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  private providerRegistry?: ProviderRegistry;
  private toolRegistry?: ToolRegistry;
  /** P2-3：父会话 id，用于定位子代理 sidechain transcript 做真恢复。由 app.ts 鸭子类型注入。 */
  private parentSessionId?: string;

  constructor(providerRegistry?: ProviderRegistry, toolRegistry?: ToolRegistry) {
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
  }

  /** P2-3：注入父会话 id（与 SubAgentTool 同款，app.ts wireParentSessionId 统一接线）。 */
  setParentSessionId(sessionId: string | undefined): void {
    this.parentSessionId = sessionId;
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
   * Resume 已终态 Agent（P2-3，对标 cc resumeAgent 真恢复）。
   *
   * 优先从子代理 sidechain JSONL transcript 重建**完整对话历史**（含中间轮工具调用/结论），
   * 经 forkMessages 灌入新子代理，让 resume 的 agent 看到自己之前的完整上下文再续接新指令。
   *
   * transcript 缺失/损坏/无 parentSessionId 时，fail-open 降级到**轻量续传**：
   * 把原 prompt + 原 output 拼成上下文前缀 + 新指令起新 task（覆盖「还差一步」主用例）。
   *
   * 两条路径都创建新的后台 agent task，调用方得到新 task_id 便于追踪。
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

    // P2-3：尝试从 sidechain transcript 重建完整历史（真恢复）。成功则走 forkMessages 续跑。
    let forkMessages:
      | { role: "user" | "assistant"; content: import("../llm/types.ts").ContentBlock[] }[]
      | undefined;
    let resumeMode: "transcript" | "lightweight" = "lightweight";
    if (this.parentSessionId) {
      try {
        const { reconstructSidechainMessages } = await import("../session/sidechain.ts");
        const reconstructed = reconstructSidechainMessages(this.parentSessionId, task.id);
        if (reconstructed && reconstructed.messages.length > 0) {
          // 在完整历史末尾追加新的续传指令（user 消息）。
          forkMessages = [
            ...reconstructed.messages,
            { role: "user", content: [{ type: "text", text: `[续传指令] ${message}` }] },
          ];
          resumeMode = "transcript";
          log.info(
            "SUBAGENT",
            `Resume(真恢复): 从 transcript 重建 ${reconstructed.messages.length} 条消息`,
          );
        }
      } catch (err: any) {
        log.warn("SUBAGENT", `Resume transcript 重建失败，降级轻量续传: ${err?.message ?? err}`);
      }
    }

    // 构建续传 prompt：原上下文 + 原输出 + 新指令（轻量续传路径 / transcript 路径的 description 用）
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
        if (this.parentSessionId) subAgent.setParentSessionId(this.parentSessionId);
        const result = await subAgent.execute(
          {
            type: task.agentType,
            description: `[Resume] ${message.slice(0, 80)}`,
            // transcript 恢复：走 forkMessages（完整历史）；轻量续传：走拼接 prompt。
            prompt: forkMessages ? message : resumePrompt,
            forkMessages,
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

    log.info(
      "SUBAGENT",
      `Resume agent(${resumeMode}): 原 ${task.id} → 新 ${newTaskId} (${task.agentType})`,
    );

    return {
      output: JSON.stringify({
        status: "resumed",
        resume_mode: resumeMode, // transcript=完整历史真恢复 / lightweight=轻量续传
        original_agent_id: task.id,
        new_task_id: newTaskId,
        agent_type: task.agentType,
        message: `已恢复 Agent 执行（新 task_id: ${newTaskId}，模式: ${resumeMode}），完成后会通知你`,
      }),
    };
  }
}
