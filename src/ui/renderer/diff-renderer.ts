/**
 * 逐行差分渲染器
 *
 * 替代 Ink 的 log-update，将 6 条分散的渲染路径合并为 1 条。
 * 核心思路：维护 previousLines 快照，每次渲染只更新变化的行，
 * 避免全量重绘导致的闪烁和 ghost lines。
 *
 * 光标不变量：render() 结束后光标始终在 previousLines 最后一行末尾。
 * 所有分支（首次渲染、差分更新、行数增减）都必须维护这个不变量。
 */

/** ESC[2K — 清除整行 */
const EL = "\x1b[2K";
/** ESC[nA — 光标上移 n 行 */
const CUU = (n: number) => (n > 0 ? `\x1b[${n}A` : "");
/** ESC[nB — 光标下移 n 行 */
const CUD = (n: number) => (n > 0 ? `\x1b[${n}B` : "");

export class DiffRenderer {
  private stdout: NodeJS.WriteStream;
  private previousLines: string[] = [];

  constructor(stdout: NodeJS.WriteStream) {
    this.stdout = stdout;
  }

  /**
   * 差分渲染：首次全量输出，后续只更新变化的行
   *
   * 光标不变量：调用结束后光标在 newLines 最后一行末尾。
   */
  render(output: string): void {
    const newLines = output.split("\n");

    // 首次渲染 — 直接全量输出
    // stdout.write(output) 后光标在最后一行末尾（如果最后一个字符是 \n，
    // split 会产生尾部空字符串，光标在该空行开头 = 末尾，不变量成立）
    if (this.previousLines.length === 0) {
      this.stdout.write(output);
      this.previousLines = newLines;
      return;
    }

    // 找到变化区间 [firstChanged, lastChanged]
    const maxLen = Math.max(newLines.length, this.previousLines.length);
    let firstChanged = -1;
    let lastChanged = -1;

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }

    // 无变化
    if (firstChanged === -1) {
      return;
    }

    // 构建 ANSI 序列
    let buf = "";

    // 光标当前在 previousLines 最后一行末尾（不变量保证）
    // 移动到 firstChanged 行首
    const cursorAt = this.previousLines.length - 1;
    const moveUp = cursorAt - firstChanged;
    if (moveUp > 0) {
      buf += CUU(moveUp);
    } else if (moveUp < 0) {
      buf += CUD(-moveUp);
    }
    buf += "\r"; // 回到行首

    // 逐行重写 firstChanged 到 min(lastChanged, newLines.length - 1)
    const lastNewLine = Math.min(lastChanged, newLines.length - 1);
    for (let i = firstChanged; i <= lastNewLine; i++) {
      buf += EL + newLines[i];
      if (i < lastNewLine) {
        buf += "\r\n";
      }
    }
    // 此时光标在 lastNewLine 行末尾

    // 行数减少：清除多余行，然后光标回到 newLines 最后一行
    if (newLines.length < this.previousLines.length) {
      const extra = this.previousLines.length - newLines.length;
      for (let i = 0; i < extra; i++) {
        buf += "\r\n" + EL;
      }
      // 光标现在在 lastNewLine + extra 行，需要回到 newLines 最后一行
      const backUp = (lastNewLine + extra) - (newLines.length - 1);
      if (backUp > 0) {
        buf += CUU(backUp);
      }
    } else {
      // 行数不变或增加：光标在 lastNewLine 行，需要移到 newLines 最后一行
      const moveDown = (newLines.length - 1) - lastNewLine;
      if (moveDown > 0) {
        buf += CUD(moveDown);
      }
    }

    // 不变量：光标现在在 newLines 最后一行末尾
    this.stdout.write(buf);
    this.previousLines = newLines;
  }

  /**
   * 清除当前 Live 区域（从底部逐行向上擦除）
   *
   * 光标不变量：调用结束后光标在第一行行首（所有行已清除）。
   */
  clear(): void {
    if (this.previousLines.length === 0) return;

    let buf = "";
    const lineCount = this.previousLines.length;

    // 光标在最后一行末尾（不变量保证）
    // 从最后一行开始，逐行清除并上移
    for (let i = lineCount - 1; i >= 0; i--) {
      buf += "\r" + EL;
      if (i > 0) {
        buf += CUU(1);
      }
    }

    this.stdout.write(buf);
    this.previousLines = [];
  }

  /**
   * 重置内部状态（不写入终端，用于 resize 后）
   */
  reset(): void {
    this.previousLines = [];
  }

  /**
   * 同步状态（不写入终端，只更新 previousLines，用于外部直接写入后同步）
   */
  sync(output: string): void {
    this.previousLines = output.split("\n");
  }

  /**
   * 获取当前行数（用于外部判断）
   */
  getLineCount(): number {
    return this.previousLines.length;
  }
}
