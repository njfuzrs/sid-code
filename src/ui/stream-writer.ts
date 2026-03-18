/**
 * 直接 stdout 流式输出器
 *
 * 将流式文本直接写入 stdout，不经过 ink 渲染循环，
 * 彻底消除 ink eraseLines 导致的闪烁和滚动问题。
 *
 * 策略：
 * - 已完成的段落用 renderMarkdown() 渲染后写入 stdout
 * - 当前未完成行用 \r\x1b[K 原地覆写（原始文本，不做 markdown 渲染）
 * - finish() 时渲染最后一段未输出的文本
 * - 不做光标回退，避免超出可见区域的边界问题
 */

import chalk from "chalk";
import { renderMarkdown } from "./markdown.ts";
import { getLogger } from "../debug/logger.ts";

/** 清除当前行：回车 + 清除行尾 */
const CLEAR_LINE = "\r\x1b[K";

export class StreamWriter {
  /** 累积的全部流式文本 */
  private fullText = "";
  /** 已渲染输出的文本长度（字符偏移） */
  private renderedLen = 0;
  /** 当前未完成行的原始文本（用于 \r 覆写） */
  private currentLine = "";
  /** 是否处于活跃的流式输出中 */
  private active = false;
  /** 是否已输出 "助手 ●" 标题 */
  private headerEmitted = false;
  /** stdout 引用 */
  private stdout = process.stdout;

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

    // 首次收到文本时输出 "助手 ●" 标题
    if (!this.headerEmitted) {
      this.headerEmitted = true;
      const header = chalk.bold.green("助手 ") + chalk.green("●");
      this.stdout.write(header + "\n");
    }

    // 尝试将已完成的段落（双换行分隔）渲染输出
    this.flushCompleted();

    // 更新当前未完成行的显示
    this.updateCurrentLine();
  }

  /** 结束流式输出 */
  finish(): void {
    if (!this.active) return;
    const log = getLogger();
    log.debug("STREAM_WRITER", `结束流式输出: fullTextLen=${this.fullText.length}`);

    // 清除当前未完成行
    if (this.currentLine) {
      this.stdout.write(CLEAR_LINE);
      this.currentLine = "";
    }

    // 渲染剩余未输出的文本
    const remaining = this.fullText.slice(this.renderedLen).trim();
    if (remaining) {
      const termWidth = this.stdout.columns || 80;
      const rendered = renderMarkdown(remaining, termWidth);
      if (rendered) {
        this.stdout.write(rendered + "\n");
      }
    }

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

  /**
   * 将已完成的段落（双换行分隔）渲染输出到 stdout
   * 在代码块内部不拆分，等代码块闭合后再输出
   */
  private flushCompleted(): void {
    const unrendered = this.fullText.slice(this.renderedLen);

    // 查找最后一个段落边界（双换行）
    const paragraphIdx = unrendered.lastIndexOf("\n\n");
    if (paragraphIdx < 0) return;

    const splitPos = this.renderedLen + paragraphIdx;

    // 检查拆分点是否在未闭合的代码块内
    const textToSplit = this.fullText.slice(0, splitPos);
    const fenceCount = (textToSplit.match(/^(?:```|~~~)/gm) || []).length;
    if (fenceCount % 2 !== 0) return; // 代码块未闭合，不拆分

    // 渲染已完成的段落
    const toRender = this.fullText.slice(this.renderedLen, splitPos).trim();
    this.renderedLen = splitPos;

    if (!toRender) return;

    // 先清除当前未完成行的显示
    if (this.currentLine) {
      this.stdout.write(CLEAR_LINE);
      this.currentLine = "";
    }

    const termWidth = this.stdout.columns || 80;
    const rendered = renderMarkdown(toRender, termWidth);
    if (rendered) {
      this.stdout.write(rendered + "\n");
    }
  }

  /** 更新当前未完成行的显示（\r 覆写，不换行） */
  private updateCurrentLine(): void {
    const unrendered = this.fullText.slice(this.renderedLen);
    // 取最后一个换行后的内容作为当前行
    const lastNewline = unrendered.lastIndexOf("\n");
    const line = lastNewline >= 0 ? unrendered.slice(lastNewline + 1) : unrendered;

    this.currentLine = line;
    if (line) {
      this.stdout.write(CLEAR_LINE + line);
    }
  }
}
