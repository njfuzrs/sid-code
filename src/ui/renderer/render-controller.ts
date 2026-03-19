/**
 * 统一渲染控制器
 *
 * 替代 Ink 的 onRender() + log-update，将 6 条分散的渲染路径合并为 1 条。
 * 通过 patchInk() 入口函数 monkey-patch Ink 实例，接管所有渲染逻辑。
 *
 * 注意：本模块不处理 Ink 的 cursorPosition 功能（setCursorPosition / isCursorDirty），
 * 因为项目使用 inverse 样式模拟光标，不依赖 Ink 的原生光标定位。
 * 如果将来引入 Ink 的 <TextInput> 或 useCursor，需要在此集成 cursor 逻辑。
 */

import { DiffRenderer } from "./diff-renderer.ts";
import { getLogger } from "../../debug/logger.ts";

// 直接用相对路径静态 import ink 内部模块，绕过 exports 限制，
// 同时让 bun bundler 在 --compile 时能正确内联这些依赖。
// @ts-ignore — ink 未在 exports 中暴露这些内部文件
import inkRenderer from "../../../node_modules/ink/build/renderer.js";
// @ts-ignore
import { shouldSynchronize, bsu, esu } from "../../../node_modules/ink/build/write-synchronized.js";
// @ts-ignore
import instances from "../../../node_modules/ink/build/instances.js";
import { throttle } from "es-toolkit/compat";

/** ESC[2J — 清除整个可见屏幕（不影响 scrollback） */
const CLEAR_SCREEN = "\x1b[2J";
/** ESC[H — 光标移动到左上角 */
const CURSOR_HOME = "\x1b[H";

export class RenderController {
  private stdout: NodeJS.WriteStream;
  private diff: DiffRenderer;
  private fullStaticOutput = "";
  private lastOutput = "";
  private lastOutputHeight = 0;
  private lastWidth: number;

  constructor(stdout: NodeJS.WriteStream) {
    this.stdout = stdout;
    this.diff = new DiffRenderer(stdout);
    this.lastWidth = stdout.columns || 80;
  }

  /**
   * 统一渲染入口 — 替代 ink.js 的 onRender() 全部 6 条路径
   */
  handleRender(ink: any): void {
    if (ink.isUnmounted) return;

    const startTime = performance.now();
    const { output, outputHeight, staticOutput } = inkRenderer(
      ink.rootNode,
      ink.isScreenReaderEnabled,
    );
    const renderTime = performance.now() - startTime;

    // 触发 onRender 回调（性能监控等）
    ink.options?.onRender?.({ renderTime });

    const hasStaticOutput = staticOutput && staticOutput !== "\n";

    // 累积 Static 输出
    if (hasStaticOutput) {
      this.fullStaticOutput += staticOutput;
    }

    // 全屏检测
    const isFullscreen =
      this.stdout.isTTY && outputHeight >= (this.stdout.rows || 24);
    const outputToRender = isFullscreen ? output : output + "\n";

    if (hasStaticOutput) {
      // 有新的 Static 内容：清除 Live → 写入 Static → 重新渲染 Live
      const sync = shouldSynchronize(this.stdout);
      if (sync) this.stdout.write(bsu);

      this.diff.clear();
      this.stdout.write(staticOutput);
      this.diff.render(outputToRender);

      if (sync) this.stdout.write(esu);
    } else if (output !== this.lastOutput) {
      // 正常更新：差分渲染
      const sync = shouldSynchronize(this.stdout);
      if (sync) this.stdout.write(bsu);

      this.diff.render(outputToRender);

      if (sync) this.stdout.write(esu);
    }

    // 更新状态
    this.lastOutput = output;
    this.lastOutputHeight = outputHeight;

    // 同步 Ink 内部状态（某些 Ink 代码可能读取）
    ink.lastOutput = output;
    ink.lastOutputToRender = outputToRender;
    ink.lastOutputHeight = outputHeight;
    ink.fullStaticOutput = this.fullStaticOutput;
  }

  /**
   * 统一 resize 处理 — 替代 ink.js 的 resized()
   *
   * 注意：fullStaticOutput 是在旧宽度下生成的字符串，resize 后重写时
   * 换行位置可能不完全正确。这是方案 A 的已知局限（Static 输出无法重新布局）。
   */
  handleResize(ink: any): void {
    const log = getLogger();
    const newWidth = ink.getTerminalWidth();
    const widthChanged = newWidth !== this.lastWidth;

    log.info("TUI:RESIZE", `宽度: ${this.lastWidth} → ${newWidth}, rows=${this.stdout.rows}`);

    if (widthChanged) {
      log.debug(
        "TUI:RESIZE",
        `宽度${newWidth < this.lastWidth ? "缩小" : "增大"}，执行清屏+重写`,
      );

      const sync = shouldSynchronize(this.stdout);
      if (sync) this.stdout.write(bsu);

      // 重置差分状态
      this.diff.reset();
      // 清除整个可见视口
      this.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
      // 重写 Static 历史
      if (this.fullStaticOutput) {
        this.stdout.write(this.fullStaticOutput);
      }

      if (sync) this.stdout.write(esu);
    }

    this.lastWidth = newWidth;
    ink.lastTerminalWidth = newWidth;
    ink.calculateLayout();
    // 重新渲染（diff.reset 后会全量输出）
    this.handleRender(ink);
  }

  /**
   * 处理外部写入 — 替代 ink.js 的 writeToStdout()
   *
   * StreamWriter 通过 console.log → patchConsole → writeToStdout 的路径。
   */
  handleExternalWrite(data: string): void {
    const sync = shouldSynchronize(this.stdout);
    if (sync) this.stdout.write(bsu);

    this.diff.clear();
    this.stdout.write(data);
    this.restoreOutput();

    if (sync) this.stdout.write(esu);
  }

  /**
   * 恢复 Live 区域 — 替代 ink.js 的 restoreLastOutput()
   */
  restoreOutput(): void {
    if (!this.lastOutput) return;

    const isFullscreen =
      this.stdout.isTTY &&
      this.lastOutputHeight >= (this.stdout.rows || 24);
    const outputToRender = isFullscreen
      ? this.lastOutput
      : this.lastOutput + "\n";
    this.diff.render(outputToRender);
  }

  /**
   * 获取 DiffRenderer 实例（供 patchInk 中的 clear 使用）
   */
  getDiffRenderer(): DiffRenderer {
    return this.diff;
  }
}

/**
 * 创建一个空操作的 log 代理，替换 Ink 的 log-update 实例。
 *
 * patchInk 接管了所有渲染路径后，Ink 内部的 this.log 不应再执行任何操作。
 * 但 unmount 流程中会调用 this.log.done()（恢复光标），
 * 我们保留 done() 的光标恢复功能，其余方法设为空操作。
 */
function createNoopLog(stdout: NodeJS.WriteStream) {
  const noop: any = () => false;
  noop.clear = () => {};
  noop.done = () => {
    // 保留光标恢复（unmount 时需要）
    stdout.write("\x1b[?25h");
  };
  noop.sync = () => {};
  noop.setCursorPosition = () => {};
  noop.isCursorDirty = () => false;
  noop.willRender = () => false;
  return noop;
}

/**
 * patchInk — 替换 Ink 实例的渲染逻辑
 *
 * 将 Ink 的 6 条渲染路径统一为 RenderController 的 1 条路径，
 * 彻底解决 ghost lines 和渲染闪烁问题。
 */
export function patchInk(stdout: NodeJS.WriteStream): RenderController {
  const log = getLogger();
  const ink = instances.get(stdout);
  if (!ink) {
    throw new Error("无法获取 Ink 实例，patchInk 必须在 render() 之后调用");
  }

  const controller = new RenderController(stdout);

  // 0. 同步首次渲染状态
  //    render() 内部会触发首次渲染（走 Ink 原始路径），
  //    需要将 log-update 的状态同步到 DiffRenderer，避免第二次渲染时重复输出。
  if (ink.lastOutputToRender || ink.lastOutput) {
    const existingOutput = ink.lastOutputToRender || ink.lastOutput + "\n";
    controller.getDiffRenderer().sync(existingOutput);
  }

  // 1. 替换 onRender — 核心：统一所有渲染路径
  ink.onRender = () => controller.handleRender(ink);

  // 重新绑定 rootNode 的回调
  if (ink.throttledOnRender) {
    // throttle 模式：重建 throttle 包装
    ink.throttledOnRender.cancel?.();
    const maxFps = ink.options?.maxFps ?? 30;
    const renderThrottleMs =
      maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;
    const throttled = throttle(ink.onRender, renderThrottleMs, {
      leading: true,
      trailing: true,
    });
    ink.rootNode.onRender = () => {
      ink.hasPendingThrottledRender = true;
      throttled();
    };
    ink.throttledOnRender = throttled;
    // throttledLog 不再使用，设为空函数
    ink.throttledLog = () => {};
  } else {
    ink.rootNode.onRender = ink.onRender;
  }
  ink.rootNode.onImmediateRender = ink.onRender;

  // 2. 替换 resized — 必须重新注册事件监听器
  //    autoBind 使得 stdout.on('resize', this.resized) 持有的是旧的绑定函数引用，
  //    仅替换 ink.resized 属性不会影响已注册的事件监听器。
  const oldResized = ink.resized;
  ink.resized = () => controller.handleResize(ink);
  stdout.off("resize", oldResized);
  stdout.on("resize", ink.resized);
  // 更新 unsubscribeResize 以匹配新的监听器
  ink.unsubscribeResize = () => {
    stdout.off("resize", ink.resized);
  };

  // 3. 替换 writeToStdout / writeToStderr
  ink.writeToStdout = (data: string) => {
    if (ink.isUnmounted) return;
    controller.handleExternalWrite(data);
  };
  ink.writeToStderr = (data: string) => {
    if (ink.isUnmounted) return;
    // stderr 和 stdout 通常指向同一个终端，需要先清除再恢复 Live 区域
    const sync = shouldSynchronize(stdout);
    if (sync) stdout.write(bsu);

    controller.getDiffRenderer().clear();
    process.stderr.write(data);
    controller.restoreOutput();

    if (sync) stdout.write(esu);
  };

  // 4. 替换 restoreLastOutput
  ink.restoreLastOutput = () => controller.restoreOutput();

  // 5. 替换 clear（Ink 的 clear() 方法在 unmount 时调用）
  ink.clear = () => {
    controller.getDiffRenderer().clear();
  };

  // 6. 替换 log 对象 — 防止 unmount 时 log.done() 与 DiffRenderer 状态冲突
  //    Ink 的 unmount() 会调用 this.log.done()，如果不替换，
  //    log-update 会用陈旧的 previousLineCount 执行 eraseLines，导致终端状态异常。
  ink.log = createNoopLog(stdout);

  log.info("TUI:RENDER", "已 patch Ink 渲染层 → RenderController");
  return controller;
}
