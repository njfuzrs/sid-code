/**
 * SendMessageTool — 向运行中或已完成的后台 Agent 发送消息
 * 支持追加指令和自动唤醒已停止的 Agent
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getTask,
  isTerminalStatus,
  isAgentTask,
} from "../task/index.ts";
import { injectMessageToAgent } from "../agent/message-queue.ts";

export class SendMessageTool implements Tool {
  name(): string {
    return "send_message";
  }

  description(): string {
    return "向一个运行中的后台 Agent 发送消息。如果 Agent 正在运行，消息会注入到其对话循环中。";
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "目标 Agent 的 task_id",
        },
        message: {
          type: "string",
          description: "要发送的消息内容",
        },
        summary: {
          type: "string",
          description: "消息摘要（可选，用于通知显示）",
        },
      },
      required: ["to", "message"],
    };
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

    if (isTerminalStatus(task.status)) {
      return {
        output: JSON.stringify({
          status: "agent_stopped",
          agent_id: to,
          agent_status: task.status,
          message: `Agent 已处于终态 (${task.status})，无法发送消息。请启动新的子代理。`,
        }),
      };
    }

    return { output: `Agent "${to}" 状态异常: ${task.status}`, isError: true };
  }
}
