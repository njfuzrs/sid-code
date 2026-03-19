/**
 * 统一渲染控制器（Alternate Screen Buffer 模式）
 *
 * 替代 Ink 的 onRender() + log-update，将所有渲染路径合并为 1 条。
 * 通过 patchInk() 入口函数 monkey-patch Ink 实例，接管所有渲染逻辑。
 *
 * Alternate Screen 模式下的渲染流程：
 * 1. 计算 Live 区域高度（Yoga layout）
 * 2. 计算消息区域高度 = stdout.rows - liveHeight
 * 3. 从 ScrollBuffer 获取可见行，用 CUP 定位写入消息区域
 * 4. Live 区域用 ScreenRenderer 差分输出（从 liveStartRow 开始）
 */

import { ScreenRenderer } from "./screen-renderer.ts";
import { Rasterizer } from "./rasterizer.ts";
import { CUP, RESET_STYLE } from "./constants.ts";
import { getLogger } from "../../debug/logger.ts";
import type { ScrollBuffer } from "../scroll-buffer.ts";

// @ts-ignore — ink 未在 exports 中暴露这些内部文件
import { shouldSynchronize, bsu, esu } from "../../../node_modules/ink/build/write-synchronized.js";
// @ts-ignore
import instances from "../../../node_modules/ink/build/instances.js";
// @ts-ignore — 仅用于 Ink 内部状态同步
import inkRenderer from "../../../node_modules/ink/build/renderer.js";
import { throttle } from "es-toolkit/compat";

/** ESC[2K — 清除整行 */
const EL = "\x1b[2K";

export class RenderController {
  private stdout: NodeJS.WriteStream;
  private screenRenderer: ScreenRenderer;
  private rasterizer: Rasterizer;
  private lastOutput = "";
  private lastWidth: number;
  private scrollBuffer: ScrollBuffer | null = null;
  /** 上一帧 Live 区域起始行（用于检测位置上移时清屏） */
  private lastLiveStartRow = 0;

  constructor(stdout: NodeJS.WriteStream) {
    this.stdout = stdout;
    const width = stdout.columns || 80;
    this.screenRenderer = new ScreenRenderer(stdout, width, 1);
    this.rasterizer = new Rasterizer();
    this.lastWidth = width;
  }

  /** 设置 ScrollBuffer 实例 */
  setScrollBuffer(buffer: ScrollBuffer): void {
    this.scrollBuffer = buffer;
  }

  /**
   * 统一渲染入口 — Alternate Screen 模式
   *
   * 流程：
   * 1. 光栅化 Live 区域到 back buffer
   * 2. 计算消息区域高度 = rows - liveHeight
   * 3. 写入消息区域（ScrollBuffer 可见行）
   * 4. 设置 liveStartRow，差分输出 Live 区域
   * 5. 同步 Ink 内部状态
   */
  handleRender(ink: any): void {
    if (ink.isUnmounted) return;

    const startTime = performance.now();
    const rootNode = ink.rootNode;

    if (!rootNode?.yogaNode) return;

    // 调用 inkRenderer 获取 Ink 内部状态（不再使用 staticOutput）
    const { output: inkOutput, outputHeight: inkOutputHeight } = inkRenderer(
      rootNode,
      ink.isScreenReaderEnabled,
    );

    const renderTime = performance.now() - startTime;
    ink.options?.onRender?.({ renderTime });

    // --- Live 区域光栅化 ---
    const width = rootNode.yogaNode.getComputedWidth();
    const liveHeight = rootNode.yogaNode.getComputedHeight();

    if (width <= 0 || liveHeight <= 0) return;

    // 确保 back buffer 尺寸匹配
    const back = this.screenRenderer.getBackBuffer();
    if (back.width !== width || back.height !== liveHeight) {
      back.resize(width, liveHeight);
    }
    back.clear();

    // 光栅化 Live 区域到 back buffer（跳过 Static 元素）
    this.rasterizer.rasterize(rootNode, back, { skipStaticElements: true });

    // --- 消息区域渲染 ---
    const rows = this.stdout.rows || 24;
    const maxMessageAreaHeight = Math.max(0, rows - liveHeight);
    const messageLines = this.scrollBuffer?.totalLines() ?? 0;

    // Live 区域紧跟消息内容：消息不满一屏时紧贴消息下方，满屏后固定在底部
    const liveStartRow = Math.min(messageLines, maxMessageAreaHeight);

    // Live 区域位置变化时处理残影
    if (liveStartRow !== this.lastLiveStartRow) {
      // 先清除旧位置的 Live 区域（CUP 定位 + EL 逐行清除 + 重置 front buffer）
      this.screenRenderer.clearLive();
      this.scrollBuffer?.markDirty();
    }
    this.lastLiveStartRow = liveStartRow;

    // 设置 Live 区域起始行
    this.screenRenderer.setLiveStartRow(liveStartRow);

    // 渲染消息区域（只在有消息且 ScrollBuffer 内容/滚动变化时重绘）
    if (messageLines > 0 && this.scrollBuffer && maxMessageAreaHeight > 0) {
      if (this.scrollBuffer.isDirtyAndReset()) {
        this.renderMessageArea(liveStartRow, width);
      }
    }

    // --- Live 区域差分输出 ---
    this.screenRenderer.flush();

    // --- 同步 Ink 内部状态 ---
    this.lastOutput = inkOutput;

    ink.lastOutput = inkOutput;
    ink.lastOutputToRender = inkOutput + "\n";
    ink.lastOutputHeight = inkOutputHeight;
    ink.fullStaticOutput = "";
  }

  /**
   * 渲染消息区域 — 将 ScrollBuffer 可见行写入屏幕上方
   * 当内容超过一屏时，在最右列绘制滚动条
   */
  private renderMessageArea(height: number, width: number): void {
    if (!this.scrollBuffer) return;

    const visibleLines = this.scrollBuffer.getVisibleLines(height);
    const scrollbar = this.scrollBuffer.getScrollbarInfo(height);
    const sync = shouldSynchronize(this.stdout);
    const out: string[] = [];

    if (sync) out.push(bsu);

    for (let y = 0; y < height; y++) {
      out.push(CUP(y, 0) + EL);
      if (y < visibleLines.length) {
        const line = visibleLines[y];
        out.push(line + RESET_STYLE);
      }
      // 在最右列绘制滚动条
      if (scrollbar) {
        const isThumb = y >= scrollbar.thumbStart && y <= scrollbar.thumbEnd;
        // CUP 定位到最右列，绘制滚动条字符
        out.push(CUP(y, width - 1) + RESET_STYLE);
        out.push(isThumb ? "\x1b[38;5;245m█\x1b[0m" : "\x1b[38;5;238m│\x1b[0m");
      }
    }
    if (sync) out.push(esu);

    this.stdout.write(out.join(""));
  }

  /**
   * 统一 resize 处理 — Alternate Screen 模式
   *
   * alternate screen 没有 scrollback reflow 问题，
   * 直接清屏 + 重新计算布局 + 全量重绘即可。
   */
  handleResize(ink: any): void {
    const log = getLogger();
    const newWidth = ink.getTerminalWidth();

    log.info("TUI:RESIZE", `宽度: ${this.lastWidth} → ${newWidth}, rows=${this.stdout.rows}`);

    this.lastWidth = newWidth;
    ink.lastTerminalWidth = newWidth;
    ink.calculateLayout();

    // 清屏（alternate screen 无 reflow，直接清屏即可；clearScreen 内部已 reset 状态）
    this.screenRenderer.clearScreen();

    // 标记 ScrollBuffer 为脏，强制重绘消息区域
    this.scrollBuffer?.markDirty();

    // 重新渲染
    this.handleRender(ink);
  }

  /**
   * 恢复 Live 区域
   */
  restoreOutput(): void {
    if (!this.lastOutput) return;
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

  /**
   * 获取当前 Live 区域高度（由最近一次 handleRender 计算）
   */
  getLiveHeight(): number {
    return this.screenRenderer.getLiveHeight();
  }

  /**
   * 触发消息区域重绘（ScrollBuffer 内容变化时调用）
   */
  requestMessageAreaRedraw(): void {
    this.scrollBuffer?.markDirty();
  }
}

/**
 * 创建一个空操作的 log 代理，替换 Ink 的 log-update 实例。
 */
function createNoopLog(stdout: NodeJS.WriteStream) {
  const noop: any = () => false;
  noop.clear = () => {};
  noop.done = () => {
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
 * Alternate Screen 模式：用 ScreenRenderer + Rasterizer + ScrollBuffer
 * 替换 Ink 的整个输出管线。
 */
export function patchInk(stdout: NodeJS.WriteStream): RenderController {
  const log = getLogger();
  const ink = instances.get(stdout);
  if (!ink) {
    throw new Error("无法获取 Ink 实例，patchInk 必须在 render() 之后调用");
  }

  const controller = new RenderController(stdout);

  // 0. 清除 Ink 首次渲染的输出（alternate screen 下直接清屏）
  if (ink.lastOutputHeight > 0) {
    stdout.write("\x1b[H\x1b[J");
  }

  // 1. 替换 onRender
  ink.onRender = () => controller.handleRender(ink);

  // 重新绑定 rootNode 的回调
  if (ink.throttledOnRender) {
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
    ink.throttledLog = () => {};
  } else {
    ink.rootNode.onRender = ink.onRender;
  }
  ink.rootNode.onImmediateRender = ink.onRender;

  // 2. 替换 resized
  const oldResized = ink.resized;
  ink.resized = () => controller.handleResize(ink);
  stdout.off("resize", oldResized);
  stdout.on("resize", ink.resized);
  ink.unsubscribeResize = () => {
    stdout.off("resize", ink.resized);
  };

  // 3. 替换 writeToStdout / writeToStderr
  // alternate screen 模式下不再需要 handleExternalWrite，
  // StreamWriter 直接写入 ScrollBuffer，不经过 writeToStdout
  ink.writeToStdout = (_data: string) => {
    // 空操作：alternate screen 模式下 StreamWriter 直接写 ScrollBuffer
  };
  ink.writeToStderr = (data: string) => {
    if (ink.isUnmounted) return;
    process.stderr.write(data);
  };

  // 4. 替换 restoreLastOutput
  ink.restoreLastOutput = () => controller.restoreOutput();

  // 5. 替换 clear
  ink.clear = () => {
    controller.clearLive();
  };

  // 6. 替换 log 对象
  ink.log = createNoopLog(stdout);

  log.info("TUI:RENDER", "已 patch Ink 渲染层 → RenderController（Alternate Screen 模式）");

  // 7. 立即触发一次渲染
  controller.handleRender(ink);

  return controller;
}
