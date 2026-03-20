/**
 * TUI 渲染模块（支持双模式）
 *
 * 模式 1（默认）：Ink 原生 alternateBuffer + incrementalRendering
 * 模式 2（--no-alternate-buffer）：标准 Ink 渲染（Static 模式，屏幕阅读器友好）
 *
 * 鼠标事件启用/禁用已移至 MouseContext 管理。
 * 退出时 Ink fork 会自动将最终帧渲染到主缓冲区（由 AlternateBufferQuittingDisplay 提供内容）。
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
 * 创建 ink 应用
 *
 * @param useAlternateBuffer - true: Ink 原生 alternateBuffer 模式；false: 标准 Ink 渲染（Static 模式）
 */
export function createFullScreen(
  node: ReactElement,
  useAlternateBuffer: boolean = true,
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
      };

      if (useAlternateBuffer) {
        // Alternate Buffer 模式：全屏接管
        (options as any).alternateBuffer = true;
        (options as any).incrementalRendering = true;
      }

      instance = render(node, options);

      const modeName = useAlternateBuffer ? "Alternate Buffer" : "Static";
      log.info("TUI:RENDER", `ink 实例已创建（${modeName} 模式）`);

      exitPromise = (async () => {
        await instance.waitUntilExit();
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
