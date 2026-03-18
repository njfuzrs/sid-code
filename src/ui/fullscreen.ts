/**
 * TUI 渲染模块
 *
 * 不使用 alternate screen buffer，消息通过 Static 组件写入终端原生滚动缓冲区，
 * 支持鼠标滚轮浏览历史消息。退出时对话记录保留在终端中。
 *
 * ink 已内置 DEC Mode 2026 (Synchronized Output) 支持，无需额外 hook。
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

const SHOW_CURSOR = "\x1b[?25h";
/** ESC[H — 光标移动到左上角 */
const CURSOR_HOME = "\x1b[H";
/** ESC[J — 从光标位置清除到屏幕末尾 */
const CLEAR_BELOW = "\x1b[J";

interface FullScreenInstance {
  instance: ReturnType<typeof render>;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

/**
 * 创建 ink 应用（主缓冲区模式）
 *
 * 不进入 alternate screen buffer，渲染到主缓冲区。
 * Static 输出写入终端滚动缓冲区，支持原生鼠标滚轮滚动。
 */
export function createFullScreen(
  node: ReactElement,
  options?: Parameters<typeof render>[1],
): FullScreenInstance {
  const log = getLogger();
  const stdout = process.stdout;

  let instance: ReturnType<typeof render>;
  let exitPromise: Promise<void>;

  return {
    get instance() { return instance; },
    start: async () => {
      // 启动前清屏，为 Ink 提供干净的渲染空间
      stdout.write(CURSOR_HOME + CLEAR_BELOW);

      instance = render(node, options);
      log.info("TUI:RENDER", "ink 实例已创建（主缓冲区模式）");

      exitPromise = (async () => {
        await instance.waitUntilExit();
        stdout.write(SHOW_CURSOR);
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
