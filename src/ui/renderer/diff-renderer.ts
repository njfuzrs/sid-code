/**
 * 逐行差分渲染器
 *
 * 替代 Ink 的 log-update，将 6 条分散的渲染路径合并为 1 条。
 * 核心思路：维护 previousLines 快照，每次渲染只更新变化的行，
 * 避免全量重绘导致的闪烁和 ghost lines。
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
   */
  render(output: string): void {
    const newLines = output.split("\n");

    // 首次渲染 — 直接全量输出
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
      this.previousLines = newLines;
      return;
    }

    // 构建 ANSI 序列
    let buf = "";

    // 光标当前在 previousLines 最后一行末尾
    // 移动到 firstChanged 行
    const cursorAt = this.previousLines.length - 1;
    const moveUp = cursorAt - firstChanged;
    if (moveUp > 0) {
      buf += CUU(moveUp);
    } else if (moveUp < 0) {
      buf += CUD(-moveUp);
    }
    buf += "\r"; // 回到行首

    // 逐行重写 firstChanged..lastChanged
    for (let i = firstChanged; i <= lastChanged; i++) {
      if (i < newLines.length) {
        buf += EL + newLines[i];
        // 不是最后一行时换行
        if (i < newLines.length - 1 || i < lastChanged) {
          buf += "\r\n";
        }
      } else {
        // 行数减少：清除多余行
        buf += EL;
        if (i < lastChanged) {
          buf += "\r\n";
        }
      }
    }

    // 如果新行数比旧行数少，需要清除剩余行并回到正确位置
    if (newLines.length < this.previousLines.length) {
      const extraLines = this.previousLines.length - newLines.length;
      // 当前光标在 lastChanged 行，需要继续向下清除多余行
      // lastChanged 已经是 previousLines.length - 1（最后一个变化行）
      // 光标需要回到 newLines 最后一行
      const moveBackUp = lastChanged - (newLines.length - 1);
      if (moveBackUp > 0) {
        buf += "\r" + CUU(moveBackUp);
      }
    } else if (newLines.length > this.previousLines.length) {
      // 行数增加：lastChanged 已经覆盖了新增行，光标在正确位置
      // 无需额外操作
    }

    this.stdout.write(buf);
    this.previousLines = newLines;
  }

  /**
   * 清除当前 Live 区域（从底部逐行向上擦除）
   */
  clear(): void {
    if (this.previousLines.length === 0) return;

    let buf = "";
    const lineCount = this.previousLines.length;

    // 光标在最后一行末尾
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
