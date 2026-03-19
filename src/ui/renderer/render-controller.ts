/**
 * 统一渲染控制器（方案 B：ScreenBuffer 游戏引擎）
 *
 * 替代 Ink 的 onRender() + log-update，将 6 条分散的渲染路径合并为 1 条。
 * 通过 patchInk() 入口函数 monkey-patch Ink 实例，接管所有渲染逻辑。
 *
 * 方案 B 用 ScreenRenderer（双缓冲 + 逐 cell 差分）+ Rasterizer（Yoga DOM → ScreenBuffer）
 * 替换方案 A 的 DiffRenderer（逐行差分），从根本上解决 resize 渲染问题。
 *
 * 注意：本模块不处理 Ink 的 cursorPosition 功能（setCursorPosition / isCursorDirty），
 * 因为项目使用 inverse 样式模拟光标，不依赖 Ink 的原生光标定位。
 */

import { ScreenRenderer } from "./screen-renderer.ts";
import { Rasterizer } from "./rasterizer.ts";
import { getLogger } from "../../debug/logger.ts";

// @ts-ignore — ink 未在 exports 中暴露这些内部文件
import { shouldSynchronize, bsu, esu } from "../../../node_modules/ink/build/write-synchronized.js";
// @ts-ignore
import instances from "../../../node_modules/ink/build/instances.js";
// @ts-ignore — 仅用于 Static 区域的字符串生成和 Ink 内部状态同步
import inkRenderer from "../../../node_modules/ink/build/renderer.js";
import { throttle } from "es-toolkit/compat";

/** ESC[2J — 清除整个可见屏幕（不影响 scrollback） */
const CLEAR_SCREEN = "\x1b[2J";
/** ESC[H — 光标移动到左上角 */
const CURSOR_HOME = "\x1b[H";

/** fullStaticOutput 最大长度（1MB），超过时截断旧内容 */
const MAX_STATIC_OUTPUT_LENGTH = 1024 * 1024;

export class RenderController {
  private stdout: NodeJS.WriteStream;
  private screenRenderer: ScreenRenderer;
  private rasterizer: Rasterizer;
  private fullStaticOutput = "";
  private lastOutput = "";
  private lastOutputHeight = 0;
  private lastWidth: number;

  constructor(stdout: NodeJS.WriteStream) {
    this.stdout = stdout;
    const width = stdout.columns || 80;
    this.screenRenderer = new ScreenRenderer(stdout, width, 1);
    this.rasterizer = new Rasterizer();
    this.lastWidth = width;
  }

  /**
   * 统一渲染入口 — 替代 ink.js 的 onRender() 全部 6 条路径
   *
   * 方案 B 流程：
   * 1. 处理 Static 输出（仍用 Ink 的 Output 生成字符串）
   * 2. Live 区域光栅化到 back buffer
   * 3. 逐 cell 差分输出
   * 4. 同步 Ink 内部状态
   */
  handleRender(ink: any): void {
    if (ink.isUnmounted) return;

    const startTime = performance.now();
    const rootNode = ink.rootNode;

    if (!rootNode?.yogaNode) return;

    // --- Static 输出处理 ---
    // 仍用 Ink 的 inkRenderer 获取 staticOutput 字符串
    // （Static 写入终端滚动缓冲区，不经过 ScreenBuffer）
    const { output: inkOutput, outputHeight: inkOutputHeight, staticOutput } = inkRenderer(
      rootNode,
      ink.isScreenReaderEnabled,
    );

    const renderTime = performance.now() - startTime;
    ink.options?.onRender?.({ renderTime });

    const hasStaticOutput = staticOutput && staticOutput !== "\n";

    if (hasStaticOutput) {
      this.fullStaticOutput += staticOutput;
      // 限制 fullStaticOutput 大小，超过时截断旧内容（保留尾部）
      if (this.fullStaticOutput.length > MAX_STATIC_OUTPUT_LENGTH) {
        this.fullStaticOutput = this.fullStaticOutput.slice(-MAX_STATIC_OUTPUT_LENGTH);
      }
    }

    // --- Live 区域光栅化 ---
    // 计算 Live 区域尺寸
    const width = rootNode.yogaNode.getComputedWidth();
    const height = rootNode.yogaNode.getComputedHeight();

    if (width <= 0 || height <= 0) return;

    // 确保 back buffer 尺寸匹配
    const back = this.screenRenderer.getBackBuffer();
    if (back.width !== width || back.height !== height) {
      back.resize(width, height);
    }
    back.clear();

    // 光栅化 Live 区域到 back buffer
    this.rasterizer.rasterize(rootNode, back, { skipStaticElements: true });

    if (hasStaticOutput) {
      // 有新的 Static 内容：清除 Live → 写入 Static → flush Live
      this.screenRenderer.clearLive();
      this.stdout.write(staticOutput);
      this.screenRenderer.flush();
    } else {
      // 正常更新：逐 cell 差分输出
      this.screenRenderer.flush();
    }

    // --- 同步 Ink 内部状态 ---
    this.lastOutput = inkOutput;
    this.lastOutputHeight = inkOutputHeight;

    ink.lastOutput = inkOutput;
    ink.lastOutputToRender = inkOutput + "\n";
    ink.lastOutputHeight = inkOutputHeight;
    ink.fullStaticOutput = this.fullStaticOutput;
  }

  /**
   * 统一 resize 处理 — 替代 ink.js 的 resized()
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

      // 重置 ScreenRenderer 状态
      this.screenRenderer.reset();
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
    // 重新渲染（reset 后会全量输出）
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

    this.screenRenderer.clearLive();
    this.stdout.write(data);
    this.restoreOutput();

    if (sync) this.stdout.write(esu);
  }

  /**
   * 恢复 Live 区域 — 替代 ink.js 的 restoreLastOutput()
   *
   * 重新 flush 当前 back buffer 的内容。
   * 注意：这依赖于 clearLive() 只清空 front buffer 而不清空 back buffer 的行为——
   * clearLive() 后 front 全空 vs back 仍有上一帧内容，flush() 会全量输出 Live 区域。
   */
  restoreOutput(): void {
    if (!this.lastOutput) return;
    // flush 会将 back buffer 的内容输出到终端
    this.screenRenderer.flush();
  }

  /**
   * 清除 Live 区域
   */
  clearLive(): void {
    this.screenRenderer.clearLive();
  }

  /**
   * 获取 ScreenRenderer 实例
   */
  getScreenRenderer(): ScreenRenderer {
    return this.screenRenderer;
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
 * 方案 B：用 ScreenRenderer（双缓冲 + 逐 cell 差分）+ Rasterizer（Yoga DOM → ScreenBuffer）
 * 替换 Ink 的整个输出管线，从根本上解决 resize 渲染问题。
 */
export function patchInk(stdout: NodeJS.WriteStream): RenderController {
  const log = getLogger();
  const ink = instances.get(stdout);
  if (!ink) {
    throw new Error("无法获取 Ink 实例，patchInk 必须在 render() 之后调用");
  }

  const controller = new RenderController(stdout);

  // 0. 清除 Ink 首次渲染的输出
  //    render() 内部会触发首次渲染（走 Ink 原始路径 log-update），
  //    其输出高度与 ScreenBuffer 光栅化高度可能不一致，
  //    直接 syncLiveHeight 会导致光标偏移错误、出现残影（双重边框）。
  //    最可靠的做法：清屏 + liveHeight=0，由末尾的 handleRender 全量重绘。
  if (ink.lastOutputHeight > 0) {
    stdout.write("\x1b[H\x1b[J"); // CURSOR_HOME + CLEAR_BELOW
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
  const oldResized = ink.resized;
  ink.resized = () => controller.handleResize(ink);
  stdout.off("resize", oldResized);
  stdout.on("resize", ink.resized);
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
    const sync = shouldSynchronize(stdout);
    if (sync) stdout.write(bsu);

    controller.clearLive();
    process.stderr.write(data);
    controller.restoreOutput();

    if (sync) stdout.write(esu);
  };

  // 4. 替换 restoreLastOutput
  ink.restoreLastOutput = () => controller.restoreOutput();

  // 5. 替换 clear（Ink 的 clear() 方法在 unmount 时调用）
  ink.clear = () => {
    controller.clearLive();
  };

  // 6. 替换 log 对象
  ink.log = createNoopLog(stdout);

  log.info("TUI:RENDER", "已 patch Ink 渲染层 → RenderController（方案 B: ScreenBuffer）");

  // 7. 立即触发一次渲染，确保清除首次输出后画面不为空
  controller.handleRender(ink);

  return controller;
}
