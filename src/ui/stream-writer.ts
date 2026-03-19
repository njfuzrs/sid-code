/**
 * 流式输出管理器（Alternate Screen Buffer 模式）
 *
 * 已完成段落渲染为 ANSI 文本行，追加到 ScrollBuffer（不再写入终端 scrollback）。
 * 未完成行通过回调通知外部（在 Ink Live 区域渲染）。
 *
 * 策略：
 * - 按行 flush：每收到完整行（\n 结尾）就渲染并追加到 ScrollBuffer
 * - 代码块内不拆分，等 fence 闭合后整块输出
 * - 未完成行通过 onCurrentLine 回调通知外部，在 Live 区域显示
 * - finish() 时渲染最后一段未输出的文本
 */

import chalk from "chalk";
import stringWidth from "string-width";
import { renderMarkdown } from "./markdown.ts";
import { getLogger } from "../debug/logger.ts";

/** 匹配代码块 fence（允许最多 3 空格缩进） */
const FENCE_RE = /^ {0,3}(?:```|~~~)/gm;


/** StreamWriter 配置 */
export interface StreamWriterOptions {
  /**
   * 追加渲染后的行到 ScrollBuffer。
   * 替代原来的 writeFn，不再写入终端 scrollback。
   */
  appendToScroll: (lines: string[]) => void;
  /** 未完成行变化时的回调（用于在 Ink Live 区域显示预览） */
  onCurrentLine?: (line: string) => void;
}

export class StreamWriter {
  /** 累积的全部流式文本 */
  private fullText = "";
  /** 已渲染输出的文本长度（字符偏移） */
  private renderedLen = 0;
  /** 当前未完成行的原始文本 */
  private currentLine = "";
  /** 是否处于活跃的流式输出中 */
  private active = false;
  /** 是否已输出 "助手 ●" 标题 */
  private headerEmitted = false;
  /** 追加到 ScrollBuffer 的函数 */
  private appendToScroll: (lines: string[]) => void;
  /** 未完成行回调 */
  private onCurrentLine: ((line: string) => void) | null;

  constructor(opts: StreamWriterOptions) {
    this.appendToScroll = opts.appendToScroll;
    this.onCurrentLine = opts.onCurrentLine ?? null;
  }

  /** 开始流式输出 */
  start(): void {
    const log = getLogger();
    log.debug("STREAM_WRITER", "开始流式输出");
    this.fullText = "";
    this.renderedLen = 0;
    this.currentLine = "";
    this.active = true;
    this.headerEmitted = false;
  }

  /** 追加流式文本 */
  write(text: string): void {
    if (!this.active) return;

    this.fullText += text;

    // 首次收到文本时输出 "助手 ●" 标题到 ScrollBuffer
    if (!this.headerEmitted) {
      this.headerEmitted = true;
      const header = chalk.bold.green("助手 ") + chalk.green("●");
      this.appendToScroll([header]);
    }

    // 尝试将已完成的行渲染输出
    this.flushCompleted();

    // 通知外部当前未完成行（在 Ink Live 区域显示）
    this.notifyCurrentLine();
  }

  /** 结束流式输出 */
  finish(): void {
    if (!this.active) return;
    const log = getLogger();
    log.debug("STREAM_WRITER", `结束流式输出: fullTextLen=${this.fullText.length}`);

    // 渲染剩余未输出的文本
    const remaining = this.fullText.slice(this.renderedLen).trim();
    if (remaining) {
      const termWidth = process.stdout.columns || 80;
      const rendered = renderMarkdown(remaining, termWidth);
      if (rendered) {
        this.appendToScroll(rendered.split("\n"));
      }
    }

    // 清除未完成行预览
    this.onCurrentLine?.("");

    this.active = false;
    this.fullText = "";
    this.renderedLen = 0;
    this.currentLine = "";
    this.headerEmitted = false;
  }

  /** 是否处于活跃状态 */
  isActive(): boolean {
    return this.active;
  }

  /** 获取累积的全部文本 */
  getFullText(): string {
    return this.fullText;
  }

  /** 统计文本中的 fence 数量 */
  private countFences(text: string): number {
    FENCE_RE.lastIndex = 0;
    let count = 0;
    while (FENCE_RE.exec(text)) count++;
    return count;
  }

  /**
   * 检查文本末尾是否处于未完成的表格中
   */
  private isInTable(text: string): boolean {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      return trimmed.startsWith("|") && trimmed.endsWith("|");
    }
    return false;
  }

  /**
   * 在文本中找到安全的拆分点（段落边界）
   */
  private findSafeSplitPoint(unrendered: string): number {
    let bestSplit = -1;
    let searchFrom = 0;
    while (true) {
      const idx = unrendered.indexOf("\n\n", searchFrom);
      if (idx < 0) break;

      const candidatePos = this.renderedLen + idx + 1;
      const textToSplit = this.fullText.slice(0, candidatePos);

      const fenceCount = this.countFences(textToSplit);
      if (fenceCount % 2 !== 0) {
        searchFrom = idx + 2;
        continue;
      }

      if (!this.isInTable(textToSplit)) {
        bestSplit = idx + 1;
      }

      searchFrom = idx + 2;
    }

    return bestSplit;
  }

  /**
   * 将已完成的段落渲染并追加到 ScrollBuffer
   */
  private flushCompleted(): void {
    const unrendered = this.fullText.slice(this.renderedLen);

    const lastNewline = unrendered.lastIndexOf("\n");
    if (lastNewline < 0) return;

    const splitPos = this.renderedLen + lastNewline;

    const textToSplit = this.fullText.slice(0, splitPos);
    const fenceCount = this.countFences(textToSplit);
    if (fenceCount % 2 !== 0) return;

    if (this.isInTable(textToSplit)) {
      const safeSplit = this.findSafeSplitPoint(unrendered);
      if (safeSplit < 0) return;

      const toRender = this.fullText.slice(this.renderedLen, this.renderedLen + safeSplit).trim();
      this.renderedLen = this.renderedLen + safeSplit;

      if (!toRender) return;

      const termWidth = process.stdout.columns || 80;
      const rendered = renderMarkdown(toRender, termWidth);
      if (rendered) {
        this.appendToScroll(rendered.split("\n"));
      }
      return;
    }

    const toRender = this.fullText.slice(this.renderedLen, splitPos).trim();
    this.renderedLen = splitPos;

    if (!toRender) return;

    const termWidth = process.stdout.columns || 80;
    const rendered = renderMarkdown(toRender, termWidth);
    if (rendered) {
      this.appendToScroll(rendered.split("\n"));
    }
  }

  /** 通知外部当前未完成内容（支持多行预渲染） */
  private notifyCurrentLine(): void {
    const unrendered = this.fullText.slice(this.renderedLen);

    if (!unrendered) {
      if (this.currentLine) {
        this.currentLine = "";
        this.onCurrentLine?.("");
      }
      return;
    }

    const maxWidth = (process.stdout.columns || 80) - 4;
    const truncatedLines = unrendered.split("\n").map((line: string) => {
      if (stringWidth(line) <= maxWidth) return line;
      let truncated = "";
      let w = 0;
      for (const ch of line) {
        const cw = stringWidth(ch);
        if (w + cw > maxWidth - 1) {
          truncated += "…";
          break;
        }
        truncated += ch;
        w += cw;
      }
      return truncated;
    });

    const result = truncatedLines.join("\n");
    if (result !== this.currentLine) {
      this.currentLine = result;
      this.onCurrentLine?.(result);
    }
  }
}
