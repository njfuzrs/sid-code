/**
 * 全屏渲染模块（ink v6 适配版）
 *
 * 只负责 alternate screen buffer 的进入/退出。
 * 光标定位交给 ink v6 的 useCursor() hook 处理（见 InputArea.tsx）。
 *
 * ink v6 内置了：
 * - CSI 2026 synchronized output（write-synchronized.js）
 * - 全屏检测 + clearTerminal 优化
 * - useCursor() 光标管理（log-update.js 在渲染输出末尾追加光标定位序列）
 *
 * 因此不再需要 patch stdout.write。
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

// ANSI 转义序列常量
const ENTER_ALT_BUFFER = "\x1b[?1049h";
const EXIT_ALT_BUFFER = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

interface FullScreenInstance {
  instance: ReturnType<typeof render>;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

/**
 * 创建全屏 ink 应用
 * 管理 alternate screen buffer 的生命周期，渲染交给 ink v6 原生管道
 *
 * 时序：先进入 alternate screen buffer，再调用 render()，
 * 确保 ink 的首次渲染输出到 alternate buffer 而非主 buffer。
 */
export function createFullScreen(
  node: ReactElement,
  options?: Parameters<typeof render>[1],
): FullScreenInstance {
  const log = getLogger();
  const stdout = process.stdout;
  const origWrite = stdout.write.bind(stdout);

  // 延迟创建 ink 实例（在 start() 中创建，确保先进入 alternate buffer）
  let instance: ReturnType<typeof render>;

  // exitPromise 在 start() 中初始化
  let exitPromise: Promise<void>;

  return {
    get instance() { return instance; },
    start: async () => {
      // 先进入 alternate screen buffer
      origWrite(ENTER_ALT_BUFFER);
      log.info("TUI:FULLSCREEN", "已进入 alternate screen buffer");

      // 再创建 ink 实例——首次渲染输出到 alternate buffer
      instance = render(node, options);

      // 退出时清理
      exitPromise = (async () => {
        await instance.waitUntilExit();
        origWrite(SHOW_CURSOR);
        origWrite(EXIT_ALT_BUFFER);
        log.info("TUI:FULLSCREEN", "已退出 alternate screen buffer");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
