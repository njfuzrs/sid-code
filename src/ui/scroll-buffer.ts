/**
 * 消息历史滚动缓冲区
 *
 * 存储所有已完成消息的渲染后 ANSI 文本行，支持滚动浏览。
 * 在 alternate screen buffer 模式下，消息区域由 RenderController 直接写入屏幕上方，
 * 用户可用 PageUp/PageDown 滚动浏览历史。
 */

import chalk from "chalk";
import type { DisplayItem } from "./App.tsx";
import type { Message, ContentBlock } from "../llm/types.ts";
import { renderMarkdown } from "./markdown.ts";

/** 最大缓存行数 */
const MAX_LINES = 50000;

export class ScrollBuffer {
  private lines: string[] = [];
  /** 滚动偏移：0 = 底部对齐（最新消息可见），正数 = 向上滚动的行数 */
  private scrollOffset = 0;
  private maxLines = MAX_LINES;
  /** 脏标记：内容或滚动位置变化时为 true */
  private dirty = true;

  /** 追加新消息的渲染行 */
  appendLines(newLines: string[]): void {
    if (newLines.length === 0) return;
    this.lines.push(...newLines);
    // 超限时截断旧内容
    if (this.lines.length > this.maxLines) {
      const excess = this.lines.length - this.maxLines;
      this.lines.splice(0, excess);
      // 调整滚动偏移
      this.scrollOffset = Math.max(0, this.scrollOffset - excess);
    }
    this.dirty = true;
  }

  /** 获取当前视口应显示的行 */
  getVisibleLines(viewportHeight: number): string[] {
    if (viewportHeight <= 0 || this.lines.length === 0) return [];

    const total = this.lines.length;

    if (total <= viewportHeight) {
      // 内容不足一屏，全部显示（顶部对齐）
      return this.lines.slice();
    }

    // 底部对齐：endIdx = total - scrollOffset, startIdx = endIdx - viewportHeight
    const endIdx = total - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - viewportHeight);
    return this.lines.slice(startIdx, endIdx);
  }

  /** 向上滚动 n 行，返回是否实际发生了滚动 */
  scrollUp(n: number): boolean {
    const maxOffset = Math.max(0, this.lines.length - 1);
    const newOffset = Math.min(maxOffset, this.scrollOffset + n);
    if (newOffset === this.scrollOffset) return false;
    this.scrollOffset = newOffset;
    this.dirty = true;
    return true;
  }

  /** 向下滚动 n 行，返回是否实际发生了滚动 */
  scrollDown(n: number): boolean {
    const newOffset = Math.max(0, this.scrollOffset - n);
    if (newOffset === this.scrollOffset) return false;
    this.scrollOffset = newOffset;
    this.dirty = true;
    return true;
  }

  /** 滚动到底部 */
  scrollToBottom(): void {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = 0;
    this.dirty = true;
  }

  /** 滚动到顶部 */
  scrollToTop(): void {
    const maxOffset = Math.max(0, this.lines.length - 1);
    if (this.scrollOffset === maxOffset) return;
    this.scrollOffset = maxOffset;
    this.dirty = true;
  }

  /** 是否在底部 */
  isAtBottom(): boolean {
    return this.scrollOffset === 0;
  }

  /** 清空 */
  clear(): void {
    this.lines = [];
    this.scrollOffset = 0;
    this.dirty = true;
  }

  /** 总行数 */
  totalLines(): number {
    return this.lines.length;
  }

  /** 获取滚动百分比（0-100），在底部时返回 100 */
  getScrollPercent(viewportHeight: number): number {
    const total = this.lines.length;
    if (total <= viewportHeight) return 100;
    const maxOffset = total - viewportHeight;
    if (maxOffset <= 0) return 100;
    return Math.round(((maxOffset - this.scrollOffset) / maxOffset) * 100);
  }

  /** 检查并重置脏标记 */
  isDirtyAndReset(): boolean {
    if (this.dirty) {
      this.dirty = false;
      return true;
    }
    return false;
  }

  /** 手动标记为脏（resize 时使用） */
  markDirty(): void {
    this.dirty = true;
  }
}

// ── DisplayItem → ANSI 文本行 渲染函数 ──────────────────────────

/** 分隔线生成 */
function makeSeparator(termWidth: number): string {
  const sepWidth = Math.max(10, termWidth - 4);
  return chalk.dim("── ".repeat(Math.floor(sepWidth / 3)));
}

/** 从工具输入中提取参数摘要 */
function getToolSummary(name: string, input: unknown): string {
  const inp = input as any;
  const lower = name.toLowerCase();
  if (lower === "read") {
    const fp = inp?.file_path || inp?.filePath || "";
    const offset = inp?.offset;
    const limit = inp?.limit;
    let suffix = "";
    if (offset && limit) suffix = ` (行 ${offset}-${offset + limit})`;
    else if (limit) suffix = ` (前 ${limit} 行)`;
    return `${fp}${suffix}`;
  }
  if (lower === "edit") return inp?.file_path || inp?.filePath || "";
  if (lower === "write") return inp?.file_path || inp?.filePath || "";
  if (lower === "bash") {
    const cmd = inp?.command || "";
    return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
  }
  if (lower === "grep") return `"${inp?.pattern || ""}"`;
  if (lower === "glob") return inp?.pattern || "";
  if (lower.startsWith("subagent") || lower.startsWith("agent__") || lower.startsWith("skill__")) {
    const agentType = inp?.type || inp?.agentType || "";
    const prompt = inp?.prompt || inp?.task || "";
    const short = prompt.length > 30 ? prompt.slice(0, 27) + "..." : prompt;
    return agentType ? `${agentType} "${short}"` : short;
  }
  return "";
}

/** 从工具结果中提取结果摘要 */
function getResultSummary(name: string, content: string, isError?: boolean): string {
  if (isError) return content.length > 60 ? content.slice(0, 57) + "..." : content;
  const lower = name.toLowerCase();
  if (lower === "read") return `${content.split("\n").length} 行`;
  if (lower === "edit") return "替换完成";
  if (lower === "write") return `${content.length} 字符`;
  if (lower === "bash") return `${content.split("\n").length} 行输出`;
  if (lower === "grep") return `${content.trim().split("\n").filter(l => l.length > 0).length} 个结果`;
  if (lower === "glob") return `${content.trim().split("\n").filter(l => l.length > 0).length} 个文件`;
  return `${content.length} 字符`;
}

/** 构建 tool_use_id → toolName 映射 */
function buildToolNameMap(message: Message, prevMessage?: Message): Map<string, string> {
  const map = new Map<string, string>();
  const sourceMsg = message.role === "user" ? prevMessage : message;
  if (sourceMsg) {
    for (const block of sourceMsg.content) {
      if (block.type === "tool_use") map.set(block.id, block.name);
    }
  }
  for (const block of message.content) {
    if (block.type === "tool_use") map.set(block.id, block.name);
  }
  return map;
}

/** 渲染单个内容块为文本行 */
function renderBlockToText(block: ContentBlock, toolNameMap: Map<string, string>, termWidth: number): string[] {
  if (block.type === "text") {
    const rendered = renderMarkdown(block.text, termWidth);
    return rendered ? rendered.split("\n") : [];
  }
  if (block.type === "tool_use") {
    const summary = getToolSummary(block.name, block.input);
    const line = chalk.yellow("● ") + chalk.bold(block.name) + (summary ? chalk.dim(`  ${summary}`) : "");
    return ["  " + line];
  }
  if (block.type === "tool_result") {
    const isErr = !!block.is_error;
    const icon = isErr ? chalk.red("✗ ") : chalk.green("✓ ");
    const toolName = toolNameMap.get(block.tool_use_id) || "";
    const summary = getResultSummary(toolName, block.content, isErr);
    const line = icon + chalk.bold(toolName) + chalk.dim(`  ${summary}`);
    return ["  " + line];
  }
  return [];
}

/**
 * 将 DisplayItem 渲染为 ANSI 文本行数组
 * 不经过 Ink React 渲染管线，直接生成文本
 */
export function renderDisplayItemToLines(
  item: DisplayItem,
  termWidth: number,
  prevItem?: DisplayItem,
): string[] {
  const lines: string[] = [];
  const separator = makeSeparator(termWidth);

  if (item.kind === "system") {
    const text = chalk.dim(`── ${item.text} ──`);
    lines.push(text);
    return lines;
  }

  if (item.kind === "command") {
    // 分隔线
    if (prevItem) lines.push(" " + separator);
    // 命令输入（右对齐模拟：用空格填充）
    const label = chalk.bold.blueBright("● 你");
    lines.push(label);
    lines.push("  " + chalk.dim(item.input));
    // 命令输出
    if (item.output) {
      for (const line of item.output.split("\n")) {
        lines.push("  " + chalk.dim(line));
      }
    }
    return lines;
  }

  if (item.kind === "streaming-chunk") {
    lines.push(item.text);
    return lines;
  }

  // kind === "message"
  const msg = item.message;
  const prevMsg = prevItem?.kind === "message" ? prevItem.message : undefined;
  const toolNameMap = buildToolNameMap(msg, prevMsg);

  // 纯 tool_result 消息——无角色标签
  const hasOnlyToolResults = msg.content.every(b => b.type === "tool_result");
  if (msg.role === "user" && hasOnlyToolResults) {
    for (const block of msg.content) {
      lines.push(...renderBlockToText(block, toolNameMap, termWidth));
    }
    return lines;
  }

  // 用户消息
  if (msg.role === "user") {
    const isUserNonTool = !msg.content.every((b: ContentBlock) => b.type === "tool_result");
    if (isUserNonTool && prevItem) {
      lines.push(" " + separator);
    }
    lines.push(chalk.bold.blueBright("● 你"));
    for (const block of msg.content) {
      if (block.type === "text") {
        lines.push("  " + block.text);
      } else {
        lines.push(...renderBlockToText(block, toolNameMap, termWidth));
      }
    }
    return lines;
  }

  // 助手消息
  const ASSISTANT_PADDING_RIGHT = 10;
  const contentWidth = termWidth - ASSISTANT_PADDING_RIGHT;
  for (const block of msg.content) {
    lines.push(...renderBlockToText(block, toolNameMap, contentWidth));
  }
  return lines;
}
