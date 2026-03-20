/**
 * 统一渲染控制器（Alternate Screen Buffer 模式）
 *
 * 替代 Ink 的 onRender() + log-update，将所有渲染路径合并为 1 条。
 * 通过 patchInk() 入口函数 monkey-patch Ink 实例，接管所有渲染逻辑。
 *
 * 新架构：整个屏幕是一棵 Ink 组件树（含 VirtualizedList），
 * RenderController 只负责光栅化 + 差分输出，不再管理消息区域。
 */

import { ScreenRenderer } from "./screen-renderer.ts";
import { Rasterizer } from "./rasterizer.ts";
import { getLogger } from "../../debug/logger.ts";

// @ts-ignore — ink 未在 exports 中暴露这些内部文件
import instances from "../../../node_modules/ink/build/instances.js";
// @ts-ignore — 仅用于 Ink 内部状态同步
import inkRenderer from "../../../node_modules/ink/build/renderer.js";
import { throttle } from "es-toolkit/compat";

export class RenderController {
  private stdout: NodeJS.WriteStream;
  private screenRenderer: ScreenRenderer;
  private rasterizer: Rasterizer;
  private lastOutput = "";
  private lastWidth: number;

  constructor(stdout: NodeJS.WriteStream) {
    this.stdout = stdout;
    const width = stdout.columns || 80;
    this.screenRenderer = new ScreenRenderer(stdout, width, 1);
    this.rasterizer = new Rasterizer();
    this.lastWidth = width;
  }

  /**
   * 统一渲染入口 — Alternate Screen 模式
   *
   * 整个屏幕是一棵 Ink 组件树，liveStartRow 始终为 0。
   */
  handleRender(ink: any): void {
    if (ink.isUnmounted) return;

    const startTime = performance.now();
    const rootNode = ink.rootNode;

    if (!rootNode?.yogaNode) return;

    // 调用 inkRenderer 获取 Ink 内部状态
    const { output: inkOutput, outputHeight: inkOutputHeight } = inkRenderer(
      rootNode,
      ink.isScreenReaderEnabled,
    );

    const renderTime = performance.now() - startTime;
    ink.options?.onRender?.({ renderTime });

    // 光栅化整个组件树到 back buffer
    const width = rootNode.yogaNode.getComputedWidth();
    const height = rootNode.yogaNode.getComputedHeight();

    if (width <= 0 || height <= 0) return;

    // 确保 back buffer 尺寸匹配
    const back = this.screenRenderer.getBackBuffer();
    if (back.width !== width || back.height !== height) {
      back.resize(width, height);
    }
    back.clear();

    // 光栅化到 back buffer（跳过 Static 元素）
    this.rasterizer.rasterize(rootNode, back, { skipStaticElements: true });

    // Live 区域从第 0 行开始（整个屏幕都是 Ink 组件树）
    this.screenRenderer.setLiveStartRow(0);

    // 差分输出
    this.screenRenderer.flush();

    // 同步 Ink 内部状态
    this.lastOutput = inkOutput;
    ink.lastOutput = inkOutput;
    ink.lastOutputHeight = inkOutputHeight;
    ink.fullStaticOutput = "";
  }

  /**
   * 统一 resize 处理 — Alternate Screen 模式
   */
  handleResize(ink: any): void {
    const log = getLogger();
    const newWidth = this.stdout.columns || 80;

    log.info("TUI:RESIZE", `宽度: ${this.lastWidth} → ${newWidth}, rows=${this.stdout.rows}`);

    this.lastWidth = newWidth;
    ink.calculateLayout();

    // 清屏 + 全量重绘
    this.screenRenderer.clearScreen();
    this.handleRender(ink);
  }

  /** 恢复输出 */
  restoreOutput(): void {
    if (!this.lastOutput) return;
    this.screenRenderer.flush();
  }

  /** 清除 Live 区域 */
  clearLive(): void {
    this.screenRenderer.clearLive();
  }

  /** 获取 ScreenRenderer 实例 */
  getScreenRenderer(): ScreenRenderer {
    return this.screenRenderer;
  }

  /** 获取当前 Live 区域高度 */
  getLiveHeight(): number {
    return this.screenRenderer.getLiveHeight();
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
 */
export function patchInk(stdout: NodeJS.WriteStream): RenderController {
  const log = getLogger();
  const inkTyped = instances.get(stdout);
  if (!inkTyped) {
    throw new Error("无法获取 Ink 实例，patchInk 必须在 render() 之后调用");
  }
  const ink: any = inkTyped;

  const controller = new RenderController(stdout);

  // 0. 清除 Ink 首次渲染的输出
  if (ink.lastOutputHeight > 0) {
    stdout.write("\x1b[H\x1b[J");
  }

  // 1. 替换 onRender
  ink.onRender = () => controller.handleRender(ink);

  const maxFps = ink.options?.maxFps ?? 30;
  const renderThrottleMs =
    maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;
  const throttled = throttle(ink.onRender, renderThrottleMs, {
    leading: true,
    trailing: true,
  });
  ink.rootNode.onRender = throttled;
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
  ink.writeToStdout = (_data: string) => {};
  ink.writeToStderr = (data: string) => {
    if (ink.isUnmounted) return;
    process.stderr.write(data);
  };

  // 4. 安全替换 restoreLastOutput
  if ('restoreLastOutput' in ink) {
    ink.restoreLastOutput = () => controller.restoreOutput();
  }

  // 5. 替换 clear
  ink.clear = () => {
    controller.clearLive();
  };

  // 6. 替换 log 对象
  ink.log = createNoopLog(stdout);

  log.info("TUI:RENDER", "已 patch Ink 渲染层 → RenderController（VirtualizedList 模式）");

  // 7. 立即触发一次渲染
  controller.handleRender(ink);

  return controller;
}
