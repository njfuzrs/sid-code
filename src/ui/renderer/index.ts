/**
 * 自研渲染器模块（方案 B: ScreenBuffer 游戏引擎）
 *
 * 用 ScreenRenderer（双缓冲 + 逐 cell 差分）+ Rasterizer（Yoga DOM → ScreenBuffer）
 * 替换 Ink 的整个输出管线，从根本上解决 resize 渲染问题。
 *
 * DiffRenderer 保留作为回退方案。
 */

export { DiffRenderer } from "./diff-renderer.ts";
export { ScreenBuffer } from "./screen-buffer.ts";
export { ScreenRenderer } from "./screen-renderer.ts";
export { Rasterizer } from "./rasterizer.ts";
export { RenderController, patchInk } from "./render-controller.ts";
export * from "./constants.ts";
export { resolveInkColor, parseCellStyle, writeStyledChars, writeAnsiText } from "./ansi-style-parser.ts";
