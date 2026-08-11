/**
 * IDE 选区同步
 * 对标 Claude Code 的 useIdeSelection.ts：
 * - 监听 IDE 的 selection_changed 通知
 * - 维护当前选区状态
 * - 通过附件系统注入系统提示词
 */

import type { MCPClient } from "../mcp/client.ts";
import { getLogger } from "../debug/logger.ts";

/** 选区过期时间（5 分钟） */
const SELECTION_TTL_MS = 5 * 60 * 1000;

/** IDE 选区信息 */
export interface IDESelection {
  /** 文件路径 */
  filePath: string;
  /** 选中的文本内容 */
  text: string;
  /** 起始行号（0-based） */
  lineStart: number;
  /** 选中行数 */
  lineCount: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/** IDE 选区同步管理器 */
export class IDESelectionSync {
  private currentSelection: IDESelection | null = null;
  private unsubscribe: (() => void) | null = null;

  /** 获取当前选区（用于附件系统），超过 TTL 视为过期 */
  getSelection(): IDESelection | null {
    if (this.currentSelection && Date.now() - this.currentSelection.updatedAt > SELECTION_TTL_MS) {
      this.currentSelection = null;
    }
    return this.currentSelection;
  }

  /** 注册到 IDE MCP 客户端 */
  register(client: MCPClient): void {
    this.unsubscribe?.();

    this.unsubscribe = client.onNotification(
      "notifications/selection_changed",
      (params: unknown) => {
        try {
          const p = params as {
            selection: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
            text: string;
            filePath: string;
          };
          if (!p?.selection || typeof p.filePath !== "string") return;

          const { start, end } = p.selection;
          let lineCount = end.line - start.line + 1;
          // 对标 Claude Code：如果光标落在行首（character === 0），不计入该行
          if (end.character === 0 && lineCount > 1) {
            lineCount--;
          }

          this.currentSelection = {
            filePath: p.filePath,
            text: p.text ?? "",
            lineStart: start.line,
            lineCount,
            updatedAt: Date.now(),
          };

          getLogger().debug(
            "IDE",
            `选区更新: ${p.filePath}:${start.line + 1}-${start.line + lineCount}`,
          );
        } catch (err) {
          getLogger().error("IDE", "解析选区通知失败", err);
        }
      },
    );
  }

  /** 取消注册 */
  unregister(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentSelection = null;
  }

  /**
   * 生成选区附件内容（纯文本，由附件系统包装 XML 标签）
   * 返回 null 表示无有效选区。
   */
  formatForAttachment(): string | null {
    const sel = this.getSelection();
    if (!sel || !sel.text.trim()) return null;

    return [
      `用户在 IDE 中选中了以下代码：`,
      `文件: ${sel.filePath}`,
      `行范围: ${sel.lineStart + 1}-${sel.lineStart + sel.lineCount}`,
      ``,
      "```",
      sel.text,
      "```",
    ].join("\n");
  }
}
