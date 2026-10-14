/**
 * 早期输入捕获
 * 在 bootstrap 阶段启动，TUI 接管 stdin 时停止
 * 缓冲用户在启动期间的按键，避免按键丢失
 *
 * 停止时机必须是「TUI 键盘层接管 stdin」（KeypressProvider 挂载），而不是「InputArea 挂载」：
 * 首屏弹信任框 / MCP 审批框时 InputArea 根本不挂载，捕获若一直开着，会与 KeypressContext
 * 同时读 stdin —— 用户在对话框里按的 ↑ / 回车被这里吞进缓冲，关框后 InputArea 挂载时
 * 回填进输入框（实测：选「信任」回车后输入框多出不可见字符，提交文本是 "\x00\x00\x00"）。
 */

let buffer = "";
let capturing = false;
let handler: (() => void) | null = null;

/**
 * 把一段 stdin 原始数据追加进缓冲。导出供单测直接驱动。
 *
 * data 可能是 Buffer，也可能是字符串：KeypressContext 会 `setEncoding("utf8")`，
 * 之后 `read()` 返回字符串。旧实现按字节遍历，字符串时每个字符都被
 * `String.fromCharCode("a")`（= NaN → "\x00"）变成 NUL，这里统一按字符处理。
 */
export function appendEarlyInputData(data: Buffer | string): void {
  const text = typeof data === "string" ? data : data.toString("utf8");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    // Ctrl+C → 立即退出
    if (code === 3) {
      process.exit(130);
    }
    // Ctrl+D → 停止捕获
    if (code === 4) {
      stopCapturing();
      return;
    }
    // Backspace → 删除最后一个字符
    if (code === 127 || code === 8) {
      buffer = Array.from(buffer).slice(0, -1).join("");
      continue;
    }
    // ESC 序列（箭头键等）→ 整段跳过。只跳 ESC 一个字节的话，↑ 会留下 "[A" 进输入框。
    if (code === 27) {
      const next = text[i + 1];
      if (next === "[" || next === "O") {
        i += 2;
        // CSI / SS3：参数字节直到终止字节（0x40-0x7E）
        while (i < text.length && !(text[i] >= "@" && text[i] <= "~")) i++;
      } else if (next !== undefined) {
        i += 1; // Alt+字符
      }
      continue;
    }
    // CR → 转换为 LF
    if (code === 13) {
      buffer += "\n";
      continue;
    }
    // 其余控制字符（除 Tab/LF）→ 跳过
    if (code < 32 && code !== 9 && code !== 10) continue;
    buffer += ch;
  }
}

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
    appendEarlyInputData(data);
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
 * TUI 键盘层接管 stdin 时调用：停止捕获，但**保留**已缓冲的内容，
 * 等 InputArea 挂载时由 consumeEarlyInput 取走。
 */
export function stopCapturingEarlyInput(): void {
  stopCapturing();
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
