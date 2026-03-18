/**
 * 直接 stdout 流式输出器
 *
 * 将流式文本直接写入 stdout，不经过 ink 渲染循环，
 * 彻底消除 ink eraseLines 导致的闪烁和滚动问题。
 *
 * 策略：
 * - 按行 flush：每收到完整行（\n 结尾）就尝试渲染输出
 * - 代码块内不拆分，等 fence 闭合后整块输出
 * - 当前未完成行用 \r\x1b[K 原地覆写（原始文本，不做 markdown 渲染）
 * - 未完成行截断到终端宽度，避免折行产生幽灵行
 * - finish() 时渲染最后一段未输出的文本
 */

import chalk from "chalk";
import stringWidth from "string-width";
import { renderMarkdown } from "./markdown.ts";
import { getLogger } from "../debug/logger.ts";

/** 清除当前行：回车 + 清除行尾 */
const CLEAR_LINE = "\r\x1b[K";

/** 匹配代码块 fence（允许最多 3 空格缩进） */
const FENCE_RE = /^ {0,3}(?:```|~~~)/gm;

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

    // 尝试将已完成的行渲染输出
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

  /** 统计文本中的 fence 数量 */
  private countFences(text: string): number {
    FENCE_RE.lastIndex = 0;
    let count = 0;
    while (FENCE_RE.exec(text)) count++;
    return count;
  }

  /**
   * 将已完成的行渲染输出到 stdout
   *
   * 改进策略：按行（单换行）查找 flush 边界，而非仅双换行。
   * 在代码块内部不拆分，等 fence 闭合后再输出。
   */
  private flushCompleted(): void {
    const unrendered = this.fullText.slice(this.renderedLen);

    // 查找最后一个换行符作为候选拆分点
    const lastNewline = unrendered.lastIndexOf("\n");
    if (lastNewline < 0) return;

    const splitPos = this.renderedLen + lastNewline;

    // 检查拆分点是否在未闭合的代码块内
    const textToSplit = this.fullText.slice(0, splitPos);
    const fenceCount = this.countFences(textToSplit);
    if (fenceCount % 2 !== 0) return; // 代码块未闭合，不拆分

    // 渲染已完成的内容
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

  /**
   * 更新当前未完成行的显示（\r 覆写，不换行）
   * 截断到终端宽度，避免折行导致幽灵行
   */
  private updateCurrentLine(): void {
    const unrendered = this.fullText.slice(this.renderedLen);
    // 取最后一个换行后的内容作为当前行
    const lastNewline = unrendered.lastIndexOf("\n");
    const line = lastNewline >= 0 ? unrendered.slice(lastNewline + 1) : unrendered;

    if (!line) {
      this.currentLine = "";
      return;
    }

    // 截断到终端宽度，避免终端自动折行后 \r 只回到折行最后一行
    const maxWidth = (this.stdout.columns || 80) - 2; // 留 2 列 buffer
    let truncated = line;
    if (stringWidth(line) > maxWidth) {
      // 逐字符截断，确保 CJK 字符正确处理
      truncated = "";
      let w = 0;
      for (const ch of line) {
        const cw = stringWidth(ch);
        if (w + cw > maxWidth - 1) { // -1 留给省略号
          truncated += "…";
          break;
        }
        truncated += ch;
        w += cw;
      }
    }

    this.currentLine = truncated;
    this.stdout.write(CLEAR_LINE + truncated);
  }
}
