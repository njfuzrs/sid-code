/**
 * TUI 渲染模块
 *
 * 不使用 alternate screen buffer，消息通过 Static 组件写入终端原生滚动缓冲区，
 * 支持鼠标滚轮浏览历史消息。退出时对话记录保留在终端中。
 *
 * DEC Mode 2026 (Synchronized Output)：
 * 在 ink 的 stdout.write 外包裹 BSU/ESU 序列，支持的终端（Ghostty, Kitty,
 * WezTerm, foot, Contour 等）会原子性刷新帧，彻底消除撕裂和闪烁。
 * 不支持的终端静默忽略这些序列，无副作用。
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

const SHOW_CURSOR = "\x1b[?25h";
/** ESC[H — 光标移动到左上角 */
const CURSOR_HOME = "\x1b[H";
/** ESC[J — 从光标位置清除到屏幕末尾 */
const CLEAR_BELOW = "\x1b[J";

/** DEC Mode 2026: Begin Synchronized Update */
const BSU = "\x1b[?2026h";
/** DEC Mode 2026: End Synchronized Update */
const ESU = "\x1b[?2026l";

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
  let resizeHandler: (() => void) | null = null;

  return {
    get instance() { return instance; },
    start: async () => {
      // 启动前清屏，为 Ink 提供干净的渲染空间
      stdout.write(CURSOR_HOME + CLEAR_BELOW);

      // 在 render() 之前注册 resize 处理器，确保先于 Ink 内置的 resized() 执行。
      //
      // 原因：终端宽度变化时，终端自身会 reflow 已渲染内容（长行折行/短行合并），
      // 导致实际视觉行数与 Ink 内部 log-update 跟踪的逻辑行数不一致。
      // Ink 的 eraseLines(previousLineCount) 只能擦除逻辑行数，残留的折行内容
      // 会在新渲染内容上方形成"幽灵行"（如重复的输入框）。
      //
      // 修复：在 Ink 处理前，将光标移至屏幕顶部并清除整个可见区域。
      // Ink 随后在干净画布上重新渲染。Static 内容仍在滚动缓冲区中（可向上滚动查看）。
      let lastWidth = stdout.columns;
      resizeHandler = () => {
        const newWidth = stdout.columns;
        if (newWidth !== lastWidth) {
          log.debug("TUI:RENDER", `终端 resize: ${lastWidth}→${newWidth}x${stdout.rows}`);
          stdout.write(CURSOR_HOME + CLEAR_BELOW);
          lastWidth = newWidth;
        }
      };
      stdout.on("resize", resizeHandler);

      // Hook stdout.write，为 ink 的渲染输出包裹 DEC 2026 synchronized output。
      // 支持的终端（Ghostty, Kitty, WezTerm 等）会原子性刷新帧，消除撕裂。
      // 不支持的终端静默忽略 BSU/ESU 序列，无副作用。
      const originalWrite = stdout.write.bind(stdout) as typeof stdout.write;
      (stdout as any).write = function syncWrite(
        chunk: any,
        encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
      ): boolean {
        // 只对包含 ANSI 转义序列的字符串输出包裹（即 ink 的渲染输出）
        // 纯文本（如 StreamWriter 的直接输出）不需要包裹
        if (typeof chunk === "string" && chunk.includes("\x1b[")) {
          const wrapped = BSU + chunk + ESU;
          return originalWrite(wrapped, encodingOrCb as any, cb);
        }
        return originalWrite(chunk, encodingOrCb as any, cb);
      };

      instance = render(node, options);
      log.info("TUI:RENDER", "ink 实例已创建（主缓冲区模式 + DEC 2026）");

      exitPromise = (async () => {
        await instance.waitUntilExit();
        if (resizeHandler) {
          stdout.off("resize", resizeHandler);
          resizeHandler = null;
        }
        // 恢复原始 stdout.write，移除 DEC 2026 包裹
        (stdout as any).write = originalWrite;
        stdout.write(SHOW_CURSOR);
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
