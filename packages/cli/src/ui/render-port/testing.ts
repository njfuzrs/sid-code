/**
 * 测试专用。render/lastFrame 走非 TTY 整帧输出，覆盖不到增量 diff（设计文档 §3 L1 的盲区）。
 * 实现在 `next/testing.ts`，见 README.md。
 */
export { render, renderSync, forgetRenderInstance, enableFrameThrottle } from "./next/testing.ts";
