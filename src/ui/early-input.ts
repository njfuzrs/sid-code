/**
 * 早期输入捕获
 * 在 bootstrap 阶段启动，REPL 就绪后停止
 * 缓冲用户在启动期间的按键，避免按键丢失
 */

let buffer = "";
let capturing = false;
let handler: (() => void) | null = null;

/**
 * 开始捕获早期输入
 * 仅在 TTY 交互模式下启用
 */
export function startCapturingEarlyInput(): void {
  if (!process.stdin.isTTY) return;

  capturing = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // 确保异常退出时恢复终端状态
  const restoreOnExit = () => {
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // 静默失败
    }
  };
  process.on("exit", restoreOnExit);
  process.on("uncaughtException", () => {
    restoreOnExit();
  });

  handler = () => {
    const data = process.stdin.read();
    if (!data) return;

    for (const byte of data) {
      // Ctrl+C → 立即退出
      if (byte === 3) {
        process.exit(130);
      }
      // Ctrl+D → 停止捕获
      if (byte === 4) {
        stopCapturing();
        return;
      }
      // Backspace → 删除最后一个字符
      if (byte === 127 || byte === 8) {
        buffer = buffer.slice(0, -1);
        continue;
      }
      // ESC 序列（箭头键等）→ 跳过
      if (byte === 27) continue;
      // 控制字符（除 Tab/LF/CR）→ 跳过
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) continue;
      // CR → 转换为 LF
      if (byte === 13) {
        buffer += "\n";
        continue;
      }
      buffer += String.fromCharCode(byte);
    }
  };

  process.stdin.on("readable", handler);
}

function stopCapturing(): void {
  if (!capturing) return;
  capturing = false;
  if (handler) {
    process.stdin.removeListener("readable", handler);
    handler = null;
  }
  // 注意：不重置 rawMode，让 REPL 接管
}

/**
 * 消费缓冲的早期输入并停止捕获
 * REPL 就绪后调用此函数
 */
export function consumeEarlyInput(): string {
  stopCapturing();
  const result = buffer;
  buffer = "";
  return result;
}

/** 是否正在捕获 */
export function isCapturing(): boolean {
  return capturing;
}
