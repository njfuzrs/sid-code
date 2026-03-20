/**
 * TUI 渲染模块（Ink 原生 alternateBuffer 模式）
 *
 * 使用 Ink fork 提供的 alternateBuffer + incrementalRendering 参数，
 * 不再手动管理 ANSI 转义序列，不再 monkey-patch Ink 内部 API。
 *
 * 退出时 Ink fork 会自动将最终帧渲染到主缓冲区（由 AlternateBufferQuittingDisplay 提供内容），
 * 不再需要手动输出文本摘要。
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

/** 启用鼠标按钮事件 + SGR 编码（支持滚轮） */
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
/** 禁用鼠标按钮事件 + SGR 编码 */
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

export interface FullScreenInstance {
  instance: ReturnType<typeof render>;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

/**
 * 创建 ink 应用（Ink 原生 alternateBuffer 模式）
 *
 * 使用 Ink fork 的 alternateBuffer: true 参数，Ink 自动管理 alternate screen。
 * 退出时 Ink 自动恢复终端状态，并在主缓冲区渲染最终帧（由 React 组件树提供）。
 */
export function createFullScreen(
  node: ReactElement,
): FullScreenInstance {
  const log = getLogger();
  const stdout = process.stdout;

  let instance: ReturnType<typeof render>;
  let exitPromise: Promise<void>;

  return {
    get instance() { return instance; },
    start: async () => {
      // 启用鼠标事件（Ink fork 不自动管理鼠标）
      stdout.write(ENABLE_MOUSE);

      instance = render(node, {
        stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateBuffer: true,
        incrementalRendering: true,
      } as Parameters<typeof render>[1]);

      log.info("TUI:RENDER", "ink 实例已创建（Ink 原生 alternateBuffer 模式）");

      exitPromise = (async () => {
        await instance.waitUntilExit();

        // 禁用鼠标事件
        stdout.write(DISABLE_MOUSE);

        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
