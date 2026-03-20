/**
 * TUI 渲染模块（Alternate Screen Buffer 模式）
 *
 * 进入 alternate screen buffer，整个屏幕由 Ink 组件树控制：
 * - 消息区域：VirtualizedList 虚拟化渲染
 * - 底部区域：工具状态 / 输入框 / 状态栏
 *
 * 退出时恢复主缓冲区，输出简要对话摘要。
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";
import { patchInk } from "./renderer/index.ts";
import type { RenderController } from "./renderer/render-controller.ts";

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
/** 进入 alternate screen buffer */
const ENTER_ALT_SCREEN = "\x1b[?1049h";
/** 退出 alternate screen buffer */
const EXIT_ALT_SCREEN = "\x1b[?1049l";
/** ESC[H — 光标移动到左上角 */
const CURSOR_HOME = "\x1b[H";
/** ESC[J — 从光标位置清除到屏幕末尾 */
const CLEAR_BELOW = "\x1b[J";
/** 启用鼠标按钮事件 + SGR 编码（支持滚轮） */
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
/** 禁用鼠标按钮事件 + SGR 编码 */
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

export interface FullScreenInstance {
  instance: ReturnType<typeof render>;
  controller: RenderController | null;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

/** 退出时生成对话摘要的回调 */
export type OnExitCallback = () => string[];

/**
 * 创建 ink 应用（Alternate Screen Buffer 模式）
 *
 * 进入 alternate screen buffer，整个屏幕由 Ink 组件树渲染。
 * 退出时恢复主缓冲区并输出简要摘要。
 */
export function createFullScreen(
  node: ReactElement,
  options?: Parameters<typeof render>[1],
  onExit?: OnExitCallback,
): FullScreenInstance {
  const log = getLogger();
  const stdout = process.stdout;

  let instance: ReturnType<typeof render>;
  let controller: RenderController | null = null;
  let exitPromise: Promise<void>;
  let altScreenActive = false;

  /** 确保退出 alternate screen buffer + 显示光标 + 禁用鼠标 */
  const restoreTerminal = () => {
    if (altScreenActive) {
      altScreenActive = false;
      stdout.write(DISABLE_MOUSE + EXIT_ALT_SCREEN + SHOW_CURSOR);
    }
  };

  // 安全网：进程异常退出时恢复终端
  const onProcessExit = () => restoreTerminal();
  const onSignal = () => { restoreTerminal(); process.exit(1); };

  return {
    get instance() { return instance; },
    get controller() { return controller; },
    start: async () => {
      // 进入 alternate screen buffer + 隐藏光标 + 清屏 + 启用鼠标
      stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + CURSOR_HOME + CLEAR_BELOW + ENABLE_MOUSE);
      altScreenActive = true;

      // 注册安全网：确保异常退出时恢复终端
      process.on("exit", onProcessExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      instance = render(node, options);
      log.info("TUI:RENDER", "ink 实例已创建（alternate screen 模式）");

      // 用 RenderController 替换 Ink 的渲染层
      controller = patchInk(stdout);

      exitPromise = (async () => {
        await instance.waitUntilExit();

        // 退出 alternate screen buffer + 显示光标
        restoreTerminal();

        // 清理安全网监听器
        process.off("exit", onProcessExit);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);

        // 在主缓冲区输出简要对话摘要
        if (onExit) {
          try {
            const summaryLines = onExit();
            if (summaryLines.length > 0) {
              stdout.write("\n" + summaryLines.join("\n") + "\n");
            }
          } catch (err) {
            log.error("TUI:RENDER", `onExit 回调异常: ${err}`);
          }
        }

        log.info("TUI:RENDER", "ink 实例已退出（已恢复主缓冲区）");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
