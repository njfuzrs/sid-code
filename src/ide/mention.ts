/**
 * IDE @提及处理
 * 对标 Claude Code 的 useIdeAtMentioned.ts：
 * - 监听 IDE 的 at_mentioned 通知
 * - 维护提及列表（最近 N 条）
 * - 在用户下一次输入时作为上下文注入
 */

import type { MCPClient } from "../mcp/client.ts";
import { getLogger } from "../debug/logger.ts";

/** @提及信息 */
export interface IDEMention {
  /** 文件路径 */
  filePath: string;
  /** 起始行号（0-based） */
  lineStart?: number;
  /** 结束行号（0-based） */
  lineEnd?: number;
  /** 提及时间戳 */
  timestamp: number;
}

/** IDE @提及管理器 */
export class IDEMentionManager {
  private mentions: IDEMention[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly maxMentions = 10;

  /** 获取并清空待处理的提及列表（消费语义） */
  consumeMentions(): IDEMention[] {
    const result = [...this.mentions];
    this.mentions = [];
    return result;
  }

  /** 查看待处理提及（不清空） */
  peekMentions(): readonly IDEMention[] {
    return this.mentions;
  }

  /** 注册到 IDE MCP 客户端 */
  register(client: MCPClient): void {
    this.unsubscribe?.();

    this.unsubscribe = client.onNotification(
      "notifications/at_mentioned",
      (params: unknown) => {
        try {
          const p = params as {
            filePath: string;
            lineStart?: number;
            lineEnd?: number;
          };
          if (typeof p?.filePath !== "string") return;

          this.mentions.push({
            filePath: p.filePath,
            lineStart: p.lineStart,
            lineEnd: p.lineEnd,
            timestamp: Date.now(),
          });

          // 保留最近 maxMentions 条
          if (this.mentions.length > this.maxMentions) {
            this.mentions = this.mentions.slice(-this.maxMentions);
          }

          getLogger().debug(
            "IDE",
            `@提及: ${p.filePath}${p.lineStart != null ? `:${p.lineStart + 1}` : ""}`,
          );
        } catch (err) {
          getLogger().error("IDE", "解析 @提及通知失败", err);
        }
      },
    );
  }

  /** 取消注册 */
  unregister(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.mentions = [];
  }
}
