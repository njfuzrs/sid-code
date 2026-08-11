/**
 * TUI 渲染模块（双模式）
 *
 * - alternateBuffer=true：进 alternate screen 全屏 TUI（<AlternateScreen> 组件 + 虚拟滚动）
 * - alternateBuffer=false（默认，ADR-040）：主屏渲染，历史进终端 scrollback，支持原生文本选择
 * 鼠标事件启用/禁用由 MouseContext 管理（仅 alternateBuffer 模式启用）
 * 退出时 src/ink fork 会自动将最终帧渲染到主缓冲区（由 AlternateBufferQuittingDisplay 提供内容）
 */

import render from "@sid-code/tui-renderer/root.ts";
import { AlternateScreen } from "@sid-code/tui-renderer/components/AlternateScreen.tsx";
import React, { type ReactElement } from "react";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { registerProcessOutputErrorHandlers } from "@sid-code/shared/utils/process.ts";
import { installTUIConsoleGuard, uninstallTUIConsoleGuard } from "./console-guard.ts";

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

      // console 护栏：把 console.error/warn/trace 转进日志，不让它砸在 TUI 画面上。
      // 必须在 render() 之前装——render 一开始写 stdout，此后任何 console.error 都会破画面。
      // 注意这与下面 patchConsole:false 不矛盾：护栏只拦 stderr 三件套，不碰 console.log
      // 等 stdout 类方法。详见 console-guard.ts 头部注释（含 patchStderr 拦不到 console
      // 这条信道差异的说明）。
      installTUIConsoleGuard();

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
        try {
          await instance.waitUntilExit();
        } finally {
          // 卸载 console 护栏：TUI 已退出，终端重新归 shell 所有，此后的
          // console.error 应当**正常可见**（比如退出后的收尾错误、cli.ts 外层
          // catch 的报错）。不卸载会把这些错误静默转进日志，用户什么都看不到——
          // 那是在用一个"看不见的故障"换掉另一个。放 finally 里保证异常退出
          // （waitUntilExit reject，见 ink.tsx unmount(error) 的 rejectExitPromise）
          // 也能恢复。
          uninstallTUIConsoleGuard();
          // 退出时恢复行自动换行（仅 alternate buffer 模式改过）
          if (alternateBuffer) {
            enableLineWrapping();
          }
        }
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}
