/** 渲染入口与实例。加载它等于加载整套引擎，见 README.md。 */
import legacyInstances from "@sid-code/tui-renderer/instances.ts";

export { default as render } from "@sid-code/tui-renderer/root.ts";
export { drainStdin } from "@sid-code/tui-renderer/ink.tsx";
export { setSuppressTerminalProbe } from "@sid-code/tui-renderer/terminal.ts";

/**
 * 渲染实例上 CLI 与契约测试会调用的方法，即新底座必须提供的实例能力（B9 / T0.5 遗留）。
 *
 * 只列真实调用点用到的，不是旧底座 Ink 类的全部公开方法：
 * - CLI 生产代码：`forceRedraw`（Ctrl+L）、`enter/exitAlternateScreen`（外部编辑器 handoff）
 * - 契约测试：其余几个（选区 M2/M3/M5、SIGCONT R10、退出 X4）
 *
 * CI 没有 `tsc`，类型本身拦不住漂移，所以方法名同时列在 `RENDER_INSTANCE_METHODS`，
 * 由 `tests/render-port/render-instance.test.tsx` 在运行时逐个核对实例上真有这个函数。
 * 加方法要两处一起改（测试会检查两者一致）。
 */
export interface RenderInstance {
  /** 擦当前可视区并全量重绘（契约 R8） */
  forceRedraw(): void;
  /** 把终端让给外部程序：进 alt-screen、暂停渲染（契约 X5） */
  enterAlternateScreen(): void;
  /** 外部程序退出后收回终端并重绘 */
  exitAlternateScreen(): void;
  /** `<AlternateScreen>` 挂载时调用；决定 SIGCONT / 重申模式是否走 alt 分支（R10、I1c） */
  setAltScreenActive(active: boolean, mouseTracking?: boolean): void;
  /** 选区高亮背景色；不设则回退反色（M5） */
  setSelectionBgColor(color: string): void;
  /** 当前选区文本，不清选区（M2） */
  copySelectionNoClear(): string;
  clearTextSelection(): void;
  /** 信号退出路径：标记卸载、退出 raw mode，不写终端序列（X4） */
  detachForShutdown(): void;
}

export const RENDER_INSTANCE_METHODS = [
  "forceRedraw",
  "enterAlternateScreen",
  "exitAlternateScreen",
  "setAltScreenActive",
  "setSelectionBgColor",
  "copySelectionNoClear",
  "clearTextSelection",
  "detachForShutdown",
] as const satisfies readonly (keyof RenderInstance)[];

/** 按 stdout 取当前挂载的渲染实例；没挂载返回 undefined。CLI 拿实例一律走这里。 */
export function getRenderInstance(
  stdout: NodeJS.WriteStream = process.stdout,
): RenderInstance | undefined {
  return legacyInstances.get(stdout);
}
