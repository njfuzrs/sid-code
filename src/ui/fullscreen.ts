/**
 * TUI 渲染模块
 *
 * 不使用 alternate screen buffer，消息通过 Static 组件写入终端原生滚动缓冲区，
 * 支持鼠标滚轮浏览历史消息。退出时对话记录保留在终端中。
 *
 * ink 已内置 DEC Mode 2026 (Synchronized Output) 支持，无需额外 hook。
 *
 * Resize 处理策略（解决终端 reflow 导致的 ghost lines / UI stamping）：
 *
 * 根因：终端宽度变化时，已输出的文本被终端自动 reflow（重新换行），导致物理行数
 * 与 Ink 内部记录的逻辑行数不一致。eraseLines(N) 只能擦除 N 行，但 reflow 后
 * 实际可能有 M 行（M > N），剩余 M-N 行成为 ghost lines。
 *
 * 方案：Monkey-patch Ink 内部的 resized() 方法，宽度变化时执行：
 * 1. 清除整个可见视口（ESC[2J + ESC[H）
 * 2. 重写 fullStaticOutput（历史消息）+ 当前 Live 区域
 * 3. 同步 log-update 内部状态
 *
 * 这样既能消除 ghost lines，又能保留可见区域内的历史消息。
 */

import { createRequire } from "node:module";
import { render } from "ink";
import type { ReactElement } from "react";
import { getLogger } from "../debug/logger.ts";

// Ink 内部 instances WeakMap，用于获取 Ink 实例以 patch resized()
// Ink 的 exports 只暴露 build/index.js，需要通过 createRequire 绕过
const require = createRequire(import.meta.url);
const instances: WeakMap<NodeJS.WriteStream, any> =
  require("ink/build/instances.js").default;

const SHOW_CURSOR = "\x1b[?25h";
/** ESC[H — 光标移动到左上角 */
const CURSOR_HOME = "\x1b[H";
/** ESC[J — 从光标位置清除到屏幕末尾 */
const CLEAR_BELOW = "\x1b[J";
/** ESC[2J — 清除整个可见屏幕（不影响 scrollback） */
const CLEAR_SCREEN = "\x1b[2J";
/** DEC Mode 2026 同步输出 */
const BSU = "\x1b[?2026h";
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

  return {
    get instance() { return instance; },
    start: async () => {
      // 启动前清屏，为 Ink 提供干净的渲染空间
      stdout.write(CURSOR_HOME + CLEAR_BELOW);

      instance = render(node, options);
      log.info("TUI:RENDER", "ink 实例已创建（主缓冲区模式）");

      // Monkey-patch Ink 的 resized() 方法，修复 resize 时的 ghost lines
      patchInkResize(stdout, log);

      exitPromise = (async () => {
        await instance.waitUntilExit();
        stdout.write(SHOW_CURSOR);
        log.info("TUI:RENDER", "ink 实例已退出");
      })();
    },
    waitUntilExit: () => exitPromise,
  };
}

/**
 * Monkey-patch Ink 内部的 resized() 方法
 *
 * 原始 Ink resized() 的问题：
 * - 宽度缩小时：log.clear() 内部的 eraseLines(previousLineCount) 无法擦除 reflow 后多出的物理行
 * - 宽度增大时：完全不处理，旧内容残留
 *
 * Patch 后的行为：
 * - 宽度变化时：清除整个可见视口 → 重写 fullStaticOutput + output → 同步 log-update 状态
 * - 仅高度变化时：保持原始行为
 */
function patchInkResize(stdout: NodeJS.WriteStream, log: ReturnType<typeof getLogger>) {
  // 通过 Ink 内部的 instances WeakMap 获取 Ink 实例
  const ink = (instances as WeakMap<NodeJS.WriteStream, any>).get(stdout);
  if (!ink) {
    log.warn("TUI:RESIZE", "无法获取 Ink 实例，跳过 resize patch");
    return;
  }

  // 保存原始方法引用
  const originalResized = ink.resized;
  let lastWidth = ink.getTerminalWidth();

  ink.resized = () => {
    const newWidth = ink.getTerminalWidth();
    const widthChanged = newWidth !== lastWidth;

    log.info("TUI:RESIZE", `宽度: ${lastWidth} → ${newWidth}, rows=${stdout.rows}`);

    if (!widthChanged) {
      // 仅高度变化，使用原始行为
      log.debug("TUI:RESIZE", "仅高度变化，使用原始 resized()");
      originalResized.call(ink);
      lastWidth = newWidth;
      return;
    }

    // 宽度变化：清屏 + 重写 fullStaticOutput + 重新渲染 Live 区域
    log.debug("TUI:RESIZE",
      `宽度${newWidth < lastWidth ? '缩小' : '增大'}，执行清屏+重写`
    );

    const useSync = stdout.isTTY;
    if (useSync) stdout.write(BSU);

    // 1. 重置 log-update 内部状态（previousLineCount → 0, previousOutput → ''）
    //    log.clear() 会写入 eraseLines(previousLineCount) 尝试擦除旧 Live 区域，
    //    可能因 reflow 擦不干净，但没关系——步骤 2 会清除整个视口
    ink.log.clear();
    ink.lastOutput = "";
    ink.lastOutputToRender = "";
    ink.lastOutputHeight = 0;

    // 2. 清除整个可见视口（ESC[2J 不影响 scrollback）
    stdout.write(CLEAR_SCREEN + CURSOR_HOME);

    // 3. 重写 Static 历史（fullStaticOutput 累积了所有 Static 组件的输出）
    if (ink.fullStaticOutput) {
      stdout.write(ink.fullStaticOutput);
    }

    // 4. 更新宽度记录，重新布局并渲染 Live 区域
    //    onRender() 检测 output !== lastOutput（lastOutput=""），走 throttledLog 路径
    //    log-update 的 previousLineCount=0，eraseLines(0) 不产生输出，直接写入新内容
    ink.lastTerminalWidth = newWidth;
    lastWidth = newWidth;
    ink.calculateLayout();
    ink.onRender();

    if (useSync) stdout.write(ESU);
  };

  log.info("TUI:RESIZE", "已 patch Ink resized() 方法");
}
