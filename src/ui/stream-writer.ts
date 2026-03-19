/**
 * 流式输出管理器
 *
 * 通过 ink 的 writeToStdout 输出已完成段落（ink 自动清除/恢复 Live 区域），
 * 未完成行通过回调通知外部（在 ink Live 区域渲染），输入栏始终保持在底部。
 *
 * 策略：
 * - 按行 flush：每收到完整行（\n 结尾）就通过 writeToStdout 渲染输出
 * - 代码块内不拆分，等 fence 闭合后整块输出
 * - 未完成行通过 onCurrentLine 回调通知外部，在 ink Live 区域显示
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
   * 写入已完成段落的函数。
   * 应使用 ink 的 writeToStdout，这样 ink 会自动清除/恢复 Live 区域。
   * 如果未提供，回退到 process.stdout.write。
   */
  writeFn?: (data: string) => void;
  /** 未完成行变化时的回调（用于在 ink Live 区域显示预览） */
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
  /** 写入函数 */
  private writeFn: (data: string) => void;
  /** 未完成行回调 */
  private onCurrentLine: ((line: string) => void) | null;

  constructor(opts?: StreamWriterOptions) {
    this.writeFn = opts?.writeFn ?? ((data) => process.stdout.write(data));
    this.onCurrentLine = opts?.onCurrentLine ?? null;
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

    // 首次收到文本时输出 "助手 ●" 标题
    if (!this.headerEmitted) {
      this.headerEmitted = true;
      const header = chalk.bold.green("助手 ") + chalk.green("●") + "\n";
      this.writeFn(header);
    }

    // 尝试将已完成的行渲染输出
    this.flushCompleted();

    // 通知外部当前未完成行（在 ink Live 区域显示）
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
        this.writeFn(rendered + "\n");
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
   * 表格行格式：以 | 开头并以 | 结尾（忽略前后空白）
   * 如果最后一个非空行是表格行，说明表格可能还没结束
   */
  private isInTable(text: string): boolean {
    // 从末尾向前找最后一个非空行
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      // 检查是否是表格行（以 | 开头且以 | 结尾）
      return trimmed.startsWith("|") && trimmed.endsWith("|");
    }
    return false;
  }

  /**
   * 在文本中找到安全的拆分点（段落边界）
   * 返回从 renderedLen 开始的偏移量，-1 表示没有安全拆分点
   * 安全拆分点 = 连续两个换行符（空行），且不在代码块/表格内
   */
  private findSafeSplitPoint(unrendered: string): number {
    // 查找所有空行位置（段落边界）作为候选拆分点
    // 从后往前找最大的安全拆分点
    let bestSplit = -1;

    // 查找 \n\n 段落边界
    let searchFrom = 0;
    while (true) {
      const idx = unrendered.indexOf("\n\n", searchFrom);
      if (idx < 0) break;

      const candidatePos = this.renderedLen + idx + 1; // +1: 在第一个 \n 之后拆分
      const textToSplit = this.fullText.slice(0, candidatePos);

      // 检查代码块
      const fenceCount = this.countFences(textToSplit);
      if (fenceCount % 2 !== 0) {
        searchFrom = idx + 2;
        continue;
      }

      // 检查表格：拆分点前的最后一个非空行不能是表格行
      if (!this.isInTable(textToSplit)) {
        bestSplit = idx + 1;
      }

      searchFrom = idx + 2;
    }

    return bestSplit;
  }

  /**
   * 将已完成的段落渲染输出
   * 在代码块和表格内部不拆分，等结构完整后再输出。
   */
  private flushCompleted(): void {
    const unrendered = this.fullText.slice(this.renderedLen);

    // 查找最后一个换行符
    const lastNewline = unrendered.lastIndexOf("\n");
    if (lastNewline < 0) return;

    const splitPos = this.renderedLen + lastNewline;

    // 检查拆分点是否在未闭合的代码块内
    const textToSplit = this.fullText.slice(0, splitPos);
    const fenceCount = this.countFences(textToSplit);
    if (fenceCount % 2 !== 0) return; // 代码块未闭合，不拆分

    // 检查拆分点是否在表格内部
    if (this.isInTable(textToSplit)) {
      // 表格未结束，尝试找段落边界拆分（表格前的内容可以先输出）
      const safeSplit = this.findSafeSplitPoint(unrendered);
      if (safeSplit < 0) return; // 没有安全拆分点，等待表格结束

      const toRender = this.fullText.slice(this.renderedLen, this.renderedLen + safeSplit).trim();
      this.renderedLen = this.renderedLen + safeSplit;

      if (!toRender) return;

      const termWidth = process.stdout.columns || 80;
      const rendered = renderMarkdown(toRender, termWidth);
      if (rendered) {
        this.writeFn(rendered + "\n");
      }
      return;
    }

    // 渲染已完成的内容
    const toRender = this.fullText.slice(this.renderedLen, splitPos).trim();
    this.renderedLen = splitPos;

    if (!toRender) return;

    const termWidth = process.stdout.columns || 80;
    const rendered = renderMarkdown(toRender, termWidth);
    if (rendered) {
      this.writeFn(rendered + "\n");
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

    // 截断每行到终端宽度
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
