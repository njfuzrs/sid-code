/**
 * 上下文管理器
 * 管理对话消息历史、token 估算、自动压缩
 */

import type { Message, ContentBlock, Usage } from "../llm/types.ts";

/** 上下文管理器配置 */
export interface ManagerOptions {
  maxTokens: number;        // 上下文窗口最大 token 数
  compactThreshold?: number; // 触发压缩的阈值比例（默认 0.8）
}

export class Manager {
  private messages: Message[] = [];
  private systemPrompt: string = "";
  private maxTokens: number;
  private compactThreshold: number;

  constructor(opts: ManagerOptions) {
    this.maxTokens = opts.maxTokens;
    this.compactThreshold = opts.compactThreshold ?? 0.8;
  }

  /** 设置系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 获取系统提示词 */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /** 添加消息 */
  addMessage(msg: Message): void {
    this.messages.push(msg);
  }

  /** 获取所有消息 */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** 设置消息列表（用于恢复会话） */
  setMessages(msgs: Message[]): void {
    this.messages = [...msgs];
  }

  /** 清空消息 */
  clear(): void {
    this.messages = [];
  }

  /** 估算当前 token 数（粗略：4 字符 ≈ 1 token） */
  estimateTokens(): number {
    let total = Math.ceil(this.systemPrompt.length / 4);
    for (const msg of this.messages) {
      for (const block of msg.content) {
        if (block.type === "text") {
          total += Math.ceil(block.text.length / 4);
        } else if (block.type === "tool_use") {
          total += Math.ceil(JSON.stringify(block.input).length / 4);
        } else if (block.type === "tool_result") {
          total += Math.ceil(block.content.length / 4);
        }
      }
    }
    return total;
  }

  /** 是否需要压缩 */
  needsCompaction(): boolean {
    return this.estimateTokens() > this.maxTokens * this.compactThreshold;
  }

  /** 消息数量 */
  messageCount(): number {
    return this.messages.length;
  }

  /** 用摘要替换历史消息（保留最近 N 条） */
  compactWithSummary(summary: string, keepRecent: number = 4): void {
    if (this.messages.length <= keepRecent) {
      return;
    }

    const kept = this.messages.slice(-keepRecent);
    const summaryMsg: Message = {
      role: "user",
      content: [{ type: "text", text: `[对话摘要]\n${summary}` }],
    };
    const ackMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
    };

    this.messages = [summaryMsg, ackMsg, ...kept];
  }
}
