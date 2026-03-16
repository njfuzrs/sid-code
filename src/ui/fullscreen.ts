/**
 * 自定义全屏渲染模块
 * 替代 fullscreen-ink，解决两个问题：
 *
 * 1. clearTerminal 导致的闪烁（cursorHome + 行尾清除 + CSI 2026）
 * 2. macOS Terminal.app 中文 IME 预编辑文本回显导致的布局挤压
 *    （每次渲染后将光标定位到输入区域内）
 *
 * IME 问题根因：Terminal.app 的 IME 预编辑文本直接写入终端光标位置，
 * 绕过了 raw mode 和 ink 的控制。ink 渲染后光标停在最后一行末尾（状态栏），
 * IME 文字出现在那里就会挤压布局。解决方案是渲染后把光标移到输入区域内。
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

// ANSI 转义序列常量
const ENTER_ALT_BUFFER = "\x1b[?1049h";
const EXIT_ALT_BUFFER = "\x1b[?1049l";
const CURSOR_HOME = "\x1b[H";
const ERASE_LINE_RIGHT = "\x1b[K";
const ERASE_DISPLAY_BELOW = "\x1b[J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// CSI 2026 Synchronized Output（终端不支持时会静默忽略）
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** 光标定位：\x1b[{row};{col}H（1-based） */
function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

interface FullScreenInstance {
  instance: ReturnType<typeof render>;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

/**
 * 给内容的每行末尾追加 \x1b[K 并在末尾追加 \x1b[J
 * 确保覆写后旧内容不会残留
 */
function appendLineClears(content: string): string {
  const lines = content.split("\n");
  return lines.join(ERASE_LINE_RIGHT + "\n") + ERASE_DISPLAY_BELOW;
}

/**
 * 路径 A：处理 clearTerminal 输出
 * clearTerminal(\x1b[2J\x1b[3J\x1b[H) → cursorHome(\x1b[H) + 行尾清除 + 底部清除
 */
function transformClearTerminal(data: string): string {
  let content = data
    .replace(/\x1b\[2J\x1b\[3J\x1b\[H/, CURSOR_HOME)
    .replace(/\x1b\[2J\x1b\[3J/g, "")
    .replace(/\x1b\[2J/g, "");
  return appendLineClears(content);
}

/**
 * 路径 B：处理 eraseLines 输出
 * eraseLines(N) + newContent → cursorHome + newContent（每行追加 \x1b[K）+ \x1b[J
 */
function transformEraseLines(data: string): string {
  const content = data
    .replace(/(\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/, CURSOR_HOME);
  return appendLineClears(content);
}

/**
 * 创建全屏 ink 应用
 * 替代 fullscreen-ink 的 withFullScreen
 */
export function createFullScreen(
  node: ReactElement,
  options?: Parameters<typeof render>[1],
): FullScreenInstance {
  const log = getLogger();
  const stdout = process.stdout;

  // 保存原始 write
  const origWrite = stdout.write.bind(stdout);
  let patched = false;

  /**
   * 计算输入区域的光标安全位置
   * 布局（从下往上）：状态栏(1) + 输入区 border 底(1) + 输入内容(1) + 输入区 border 顶(1)
   * 输入内容行 = rows - 2（倒数第 2 行）
   * 列放到行尾——不遮挡已渲染内容，IME 预编辑文本出现在输入行右侧
   */
  function getInputCursorPosition(): { row: number; col: number } {
    const rows = stdout.rows || 49;
    const cols = stdout.columns || 80;
    const inputRow = rows - 2;
    // 放到输入行右侧 border 内（cols - 1 是右侧 border 的位置）
    const inputCol = cols - 2;
    return { row: inputRow, col: inputCol };
  }

  // patch stdout.write——拦截 ink 的所有渲染输出
  const patchStdoutWrite = () => {
    if (patched) return;
    patched = true;

    (stdout as any).write = (data: any, ...args: any[]) => {
      if (typeof data !== "string") {
        return origWrite(data, ...args);
      }

      let transformed = data;
      let isRenderOutput = false;

      // 路径 A：clearTerminal（\x1b[2J）
      if (data.includes("\x1b[2J")) {
        transformed = transformClearTerminal(data);
        isRenderOutput = true;
      }
      // 路径 B：eraseLines（\x1b[2K + \x1b[G 组合）
      else if (data.includes("\x1b[2K") && data.includes("\x1b[G")) {
        transformed = transformEraseLines(data);
        isRenderOutput = true;
      }

      if (isRenderOutput) {
        // 渲染后将光标移到输入区域内
        // 这样 macOS Terminal.app 的 IME 预编辑文本会出现在输入框内
        // 而不是状态栏末尾（避免挤压布局）
        const { row, col } = getInputCursorPosition();
        transformed += cursorTo(row, col);

        // 用 CSI 2026 synchronized output 包裹
        transformed = SYNC_START + transformed + SYNC_END;
      }

      return origWrite(transformed, ...args);
    };

    log.debug("TUI:FULLSCREEN", "stdout.write 已 patch（clearTerminal + eraseLines + IME 光标定位）");
  };

  // 恢复 stdout.write
  const restoreStdoutWrite = () => {
    if (!patched) return;
    (stdout as any).write = origWrite;
    patched = false;
    log.debug("TUI:FULLSCREEN", "stdout.write 已恢复");
  };

  // 创建 ink 实例（先渲染 null）
  const instance = render(null, options);

  // 退出时清理
  const exitPromise = (async () => {
    await instance.waitUntilExit();
    restoreStdoutWrite();
    origWrite(SHOW_CURSOR);
    origWrite(EXIT_ALT_BUFFER);
    log.info("TUI:FULLSCREEN", "已退出 alternate screen buffer");
  })();

  return {
    instance,
    start: async () => {
      // 进入 alternate screen buffer + 隐藏光标
      origWrite(ENTER_ALT_BUFFER);
      origWrite(HIDE_CURSOR);
      log.info("TUI:FULLSCREEN", "已进入 alternate screen buffer");

      // patch stdout.write（在 ink 开始渲染前）
      patchStdoutWrite();

      // 开始渲染
      instance.rerender(node);
    },
    waitUntilExit: () => exitPromise,
  };
}
