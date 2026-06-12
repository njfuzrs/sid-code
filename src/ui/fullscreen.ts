/**
 * TUI 渲染模块（双模式）
 *
 * - alternateBuffer=true：Ink 原生 alternateBuffer + incrementalRendering（全屏 TUI，虚拟滚动）
 * - alternateBuffer=false（默认，ADR-040）：主屏渲染，历史进终端 scrollback，支持原生文本选择
 * 鼠标事件启用/禁用由 MouseContext 管理（仅 alternateBuffer 模式启用）
 * 退出时 Ink fork 会自动将最终帧渲染到主缓冲区（由 AlternateBufferQuittingDisplay 提供内容）
 */

import render from "../ink/root.js";
import { AlternateScreen } from "../ink/components/AlternateScreen.js";
import React, { type ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";
import { registerProcessOutputErrorHandlers } from "../utils/process.ts";

/** 禁用终端行自动换行（防止长行折行导致布局溢出） */
function disableLineWrapping() {
  process.stdout.write("\x1b[?7l");
}

/** 恢复终端行自动换行 */
function enableLineWrapping() {
  process.stdout.write("\x1b[?7h");
}

export interface FullScreenInstance {
  instance: Awaited<ReturnType<typeof render>>;
  start: () => Promise<void>;
  waitUntilExit: () => Promise<void>;
}

export interface FullScreenOptions {
  /** 是否启用 alternate buffer 全屏模式；默认 false（主屏渲染） */
  alternateBuffer?: boolean;
}

/**
 * 创建 ink 应用（双模式：alternate buffer 全屏 / 主屏）
 */
export function createFullScreen(
  node: ReactElement,
  opts?: FullScreenOptions,
): FullScreenInstance {
  const log = getLogger();
  const stdout = process.stdout;
  const alternateBuffer = opts?.alternateBuffer ?? false;

  let instance: Awaited<ReturnType<typeof render>>;
  let exitPromise: Promise<void>;

  return {
    get instance() { return instance; },
    start: async () => {
      // 防止 EIO/EPIPE 错误从 Ink 渲染管线抛出 uncaughtException
      // 对标 claude-code registerProcessOutputErrorHandlers()
      // 必须在 Ink render() 之前注册，因为 Ink 渲染时立即开始写 stdout
      registerProcessOutputErrorHandlers();

      // vendored ink 的 alt-screen 是组件(<AlternateScreen>)而非 render option。
      // alternateBuffer=true 时用 AlternateScreen 包裹(约束高度到视口 + 启用鼠标跟踪);
      // 主屏模式直接渲染,内容自然滚入终端 scrollback。
      const rootNode = alternateBuffer
        ? React.createElement(AlternateScreen, null, node)
        : node;

      const options = {
        stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      };

      // vendored ink 的 render 是 async(返回 Promise<Instance>)。
      instance = await render(rootNode, options);

      // alternate buffer 模式下禁用行自动换行（防折行溢出，与 gemini-cli 一致）。
      // 主屏模式必须保留自动换行，否则长行被截断且不进 scrollback。
      if (alternateBuffer) {
        disableLineWrapping();
      }

      log.info("TUI:RENDER", `ink 实例已创建（${alternateBuffer ? "Alternate Buffer" : "主屏"} 模式）`);

      exitPromise = (async () => {
        await instance.waitUntilExit();
        // 退出时恢复行自动换行（仅 alternate buffer 模式改过）
        if (alternateBuffer) {
          enableLineWrapping();
        }
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
