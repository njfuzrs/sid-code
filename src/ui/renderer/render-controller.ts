/**
 * 统一渲染控制器
 *
 * 替代 Ink 的 onRender() + log-update，将 6 条分散的渲染路径合并为 1 条。
 * 通过 patchInk() 入口函数 monkey-patch Ink 实例，接管所有渲染逻辑。
 */

import { createRequire } from "node:module";
import { DiffRenderer } from "./diff-renderer.ts";
import { getLogger } from "../../debug/logger.ts";

const require = createRequire(import.meta.url);

// 复用 Ink 的 renderer（Yoga 布局 → 字符串输出）
const inkRenderer: (
  node: any,
  isScreenReaderEnabled: boolean,
) => { output: string; outputHeight: number; staticOutput: string } =
  require("ink/build/renderer.js").default;

// 复用 Ink 的同步输出工具
const { shouldSynchronize, bsu, esu } = require("ink/build/write-synchronized.js");

// Ink 内部 instances WeakMap
const instances: WeakMap<NodeJS.WriteStream, any> =
  require("ink/build/instances.js").default;

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

    const { output, outputHeight, staticOutput } = inkRenderer(
      ink.rootNode,
      ink.isScreenReaderEnabled,
    );

    // 触发 onRender 回调（性能监控等）
    ink.options?.onRender?.({ renderTime: 0 });

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

  // 1. 替换 onRender — 核心：统一所有渲染路径
  ink.onRender = () => controller.handleRender(ink);

  // 重新绑定 rootNode 的回调
  if (ink.throttledOnRender) {
    // throttle 模式：重建 throttle 包装
    ink.throttledOnRender.cancel?.();
    const { throttle } = require("es-toolkit/compat");
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

  // 2. 替换 resized
  ink.resized = () => controller.handleResize(ink);

  // 3. 替换 writeToStdout / writeToStderr
  ink.writeToStdout = (data: string) => {
    if (ink.isUnmounted) return;
    controller.handleExternalWrite(data);
  };
  ink.writeToStderr = (data: string) => {
    if (ink.isUnmounted) return;
    process.stderr.write(data);
  };

  // 4. 替换 restoreLastOutput
  ink.restoreLastOutput = () => controller.restoreOutput();

  // 5. 替换 clear（Ink 的 clear() 方法在 unmount 时调用）
  ink.clear = () => {
    controller.getDiffRenderer().clear();
  };

  log.info("TUI:RENDER", "已 patch Ink 渲染层 → RenderController");
  return controller;
}
