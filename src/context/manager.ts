/**
 * 上下文管理器
 * 管理对话消息历史、token 估算、自动压缩、持久化输出管理
 */

import type { Message } from "../llm/types.ts";
import { MessageValidator } from "./validator.ts";
import { getLogger } from "../debug/logger.ts";

/** 持久化输出阈值（对标 Claude Code 30000 字符） */
const OUTPUT_THRESHOLD = 30000;  // 30K 字符，超过此大小的工具输出会被截断
const KEEP_RECENT_OUTPUTS = 3;   // 保留最近 N 个大输出，旧的清理掉
const CLEARED_MARKER = "[旧的工具输出已清理]";

/** 上下文管理器配置 */
export interface ManagerOptions {
  maxTokens: number;        // 上下文窗口最大 token 数
  compactThreshold?: number; // 触发压缩的阈值比例（默认 0.7）
}

export class Manager {
  private messages: Message[] = [];
  private systemPrompt: string = "";
  private maxTokens: number;
  private compactThreshold: number;

  constructor(opts: ManagerOptions) {
    this.maxTokens = opts.maxTokens;
    this.compactThreshold = opts.compactThreshold ?? 0.7;
  }

  /** 设置系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 获取系统提示词 */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /** 添加消息（带验证） */
  addMessage(msg: Message): void {
    const log = getLogger();

    // 验证单条消息的基本格式
    if (!msg.content || msg.content.length === 0) {
      log.warn("CONTEXT", "尝试添加空内容消息，已忽略");
      return;
    }

    // 检查角色交替
    if (this.messages.length > 0) {
      const lastMsg = this.messages[this.messages.length - 1];
      if (lastMsg.role === msg.role) {
        log.warn("CONTEXT", `角色未交替: 上一条=${lastMsg.role}, 当前=${msg.role}，自动修复`);
        // 插入占位消息以保持交替
        const placeholderRole = msg.role === "user" ? "assistant" : "user";
        this.messages.push({
          role: placeholderRole,
          content: [{ type: "text", text: "[系统] 自动插入占位消息以保持角色交替" }],
        });
      }
    }

    // 增量压缩：tool_result 内容在添加时即截断，防止上下文膨胀
    const compressed: Message = {
      ...msg,
      content: msg.content.map(block => {
        if (block.type === "tool_result" && block.content.length > OUTPUT_THRESHOLD) {
          log.debug("CONTEXT", `增量压缩 tool_result: ${block.content.length} → 截断`);
          return { ...block, content: Manager.truncateToolOutput(block.content) };
        }
        return block;
      }),
    };

    this.messages.push(compressed);
  }

  /** 获取所有消息（发送给 LLM 前调用，会自动清理旧的大输出） */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 获取清理后的消息列表（发送给 LLM 前调用）
   * 1. 清理旧的大输出，只保留最近 N 个
   * 2. 验证消息格式
   * 3. 返回深拷贝，不影响原始消息
   */
  getCleanedMessages(): Message[] {
    const log = getLogger();
    // 找到所有大输出的位置（从后往前扫描）
    const largeOutputPositions: { msgIdx: number; blockIdx: number }[] = [];

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type === "tool_result" && block.content.length > OUTPUT_THRESHOLD) {
          largeOutputPositions.push({ msgIdx: i, blockIdx: j });
        }
      }
    }

    // 如果大输出数量不超过保留数，直接返回
    if (largeOutputPositions.length <= KEEP_RECENT_OUTPUTS) {
      return [...this.messages];
    }

    // 需要清理的旧输出（保留最近 N 个）
    const toClean = largeOutputPositions.slice(0, -KEEP_RECENT_OUTPUTS);
    const cleanSet = new Set(toClean.map(p => `${p.msgIdx}:${p.blockIdx}`));

    // 深拷贝并清理
    const cleaned = this.messages.map((msg, msgIdx) => ({
      role: msg.role,
      content: msg.content.map((block, blockIdx) => {
        if (cleanSet.has(`${msgIdx}:${blockIdx}`) && block.type === "tool_result") {
          return {
            ...block,
            content: CLEARED_MARKER,
          };
        }
        return block;
      }),
    }));

    // 验证消息格式（仅警告，不阻塞）
    const errors = MessageValidator.validate(cleaned);
    if (errors.length > 0) {
      log.warn("CONTEXT", `消息验证发现 ${errors.length} 个问题:`, {
        errors: errors.map(e => `[${e.code}] ${e.message}`),
      });
    }

    return cleaned;
  }

  /** 设置消息列表（用于恢复会话） */
  setMessages(msgs: Message[]): void {
    this.messages = [...msgs];
  }

  /** 清空消息 */
  clear(): void {
    this.messages = [];
  }

  /**
   * 智能截断超大工具输出（三层策略，对标 Claude Code）
   * 1. 代码块：保留 60% 头 + 40% 尾（行级别）
   * 2. 文件内容（行号特征）：保留前 20 行 + 后 10 行
   * 3. 普通文本：70% 头 + 30% 尾（字符级别）
   */
  static truncateToolOutput(content: string, maxChars: number = OUTPUT_THRESHOLD): string {
    if (content.length <= maxChars) {
      return content;
    }

    // 1. 检测并压缩代码块（``` 包裹的代码）
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let result = content;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const code = match[2];
      if (code.length > 2000) {
        const lines = code.split('\n');
        const keepHead = Math.ceil(lines.length * 0.6);
        const keepTail = Math.floor(lines.length * 0.4);
        const omitted = lines.length - keepHead - keepTail;
        if (omitted > 0) {
          const compressed = [
            ...lines.slice(0, keepHead),
            `\n... [省略 ${omitted} 行] ...\n`,
            ...lines.slice(-keepTail),
          ].join('\n');
          result = result.replace(match[0], `\`\`\`${match[1]}\n${compressed}\`\`\``);
        }
      }
    }
    if (result.length <= maxChars) return result;

    // 2. 检测文件内容（行号特征：→ 或 数字│）
    if (content.includes('→') || /^\s*\d+\s*[│|]/m.test(content)) {
      const lines = content.split('\n');
      if (lines.length > 30) {
        const head = lines.slice(0, 20).join('\n');
        const tail = lines.slice(-10).join('\n');
        return `${head}\n\n... [省略 ${lines.length - 30} 行，共 ${lines.length} 行] ...\n\n${tail}`;
      }
    }

    // 3. 默认：70% 头 + 30% 尾（字符级别）
    const keepHead = Math.floor(maxChars * 0.7);
    const keepTail = Math.floor(maxChars * 0.3);
    return `${result.slice(0, keepHead)}\n\n... [省略约 ${content.length - maxChars} 字符，共 ${content.length} 字符] ...\n\n${result.slice(-keepTail)}`;
  }

  /**
   * 估算当前 token 数（粗略：4 字符 ≈ 1 token）
   * 包含：系统提示词 + 消息内容 + 消息结构开销 + 工具定义开销
   */
  estimateTokens(toolCount: number = 0): number {
    // 系统提示词
    let total = Math.ceil(this.systemPrompt.length / 4);

    // 工具定义开销（每个工具约 80 token）
    total += toolCount * 80;

    // 消息内容 + 结构开销
    for (const msg of this.messages) {
      // 消息结构开销（每条消息约 4 token）
      total += 4;

      for (const block of msg.content) {
        if (block.type === "text") {
          total += Math.ceil(block.text.length / 4);
        } else if (block.type === "tool_use") {
          // tool_use 块：JSON 内容 + 结构开销（约 20 token）
          total += Math.ceil(JSON.stringify(block.input).length / 4) + 20;
        } else if (block.type === "tool_result") {
          // tool_result 块：内容 + 结构开销（约 10 token）
          total += Math.ceil(block.content.length / 4) + 10;
        }
      }
    }

    return total;
  }

  /** 获取上下文窗口最大 token 数 */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /** 是否需要压缩 */
  needsCompaction(toolCount: number = 0): boolean {
    return this.estimateTokens(toolCount) > this.maxTokens * this.compactThreshold;
  }

  /** 消息数量 */
  messageCount(): number {
    return this.messages.length;
  }

  /** 用摘要替换历史消息（保留最近 N 条，对标 Claude Code 保留 10 条） */
  compactWithSummary(summary: string, keepRecent: number = 10): void {
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
