/**
 * Agent 进度追踪器
 * 为后台 Agent 提供实时进度信息
 */

import type { AgentProgress, ToolActivity } from "../task/types.ts";

const MAX_RECENT_ACTIVITIES = 5;

export class ProgressTracker {
  toolUseCount = 0;
  latestInputTokens = 0;
  cumulativeOutputTokens = 0;
  recentActivities: ToolActivity[] = [];

  updateFromMessage(message: {
    usage?: { inputTokens: number; outputTokens: number };
    content?: Array<{ type: string; name?: string; input?: unknown }>;
  }): void {
    if (message.usage) {
      this.latestInputTokens = message.usage.inputTokens;
      this.cumulativeOutputTokens += message.usage.outputTokens;
    }

    for (const block of message.content ?? []) {
      if (block.type === "tool_use" && block.name) {
        this.toolUseCount++;
        const activity: ToolActivity = {
          toolName: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
          activityDescription: this.describeActivity(block.name, block.input),
        };
        this.recentActivities.push(activity);
        while (this.recentActivities.length > MAX_RECENT_ACTIVITIES) {
          this.recentActivities.shift();
        }
      }
    }
  }

  private describeActivity(toolName: string, input: unknown): string {
    const inp = input as Record<string, unknown>;
    switch (toolName) {
      case "read": return `读取 ${inp.file_path ?? ""}`;
      case "write": return `写入 ${inp.file_path ?? ""}`;
      case "edit": return `编辑 ${inp.file_path ?? ""}`;
      case "bash": return `执行 ${String(inp.command ?? "").slice(0, 60)}`;
      case "grep": return `搜索 "${inp.pattern ?? ""}"`;
      case "glob": return `查找 ${inp.pattern ?? ""}`;
      default: return toolName;
    }
  }

  getProgress(): AgentProgress {
    return {
      toolUseCount: this.toolUseCount,
      tokenCount: this.latestInputTokens + this.cumulativeOutputTokens,
      lastActivity: this.recentActivities[this.recentActivities.length - 1],
      recentActivities: [...this.recentActivities],
    };
  }
}
