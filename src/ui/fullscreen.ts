/**
 * TUI 渲染模块（Alternate Buffer 模式）
 *
 * 使用 Ink 原生 alternateBuffer + incrementalRendering
 * 鼠标事件启用/禁用由 MouseContext 管理
 * 退出时 Ink fork 会自动将最终帧渲染到主缓冲区（由 AlternateBufferQuittingDisplay 提供内容）
 */

import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

export interface FullScreenInstance {
  instance: ReturnType<typeof render>;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

/**
 * 创建 ink 应用（Alternate Buffer 模式）
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
      const options: Parameters<typeof render>[1] = {
        stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateBuffer: true,
        incrementalRendering: true,
      };

      instance = render(node, options);

      log.info("TUI:RENDER", "ink 实例已创建（Alternate Buffer 模式）");

      exitPromise = (async () => {
        await instance.waitUntilExit();
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
