/**
 * 自研渲染器模块
 *
 * 用 RenderController + DiffRenderer 替换 Ink 的 onRender() + log-update，
 * 将 6 条分散的渲染路径合并为 1 条，彻底解决 ghost lines 和渲染闪烁问题。
 */

export { DiffRenderer } from "./diff-renderer.ts";
export { RenderController, patchInk } from "./render-controller.ts";
