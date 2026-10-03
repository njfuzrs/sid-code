/** 测试专用。render/lastFrame 走非 TTY 整帧输出，覆盖不到增量 diff（设计文档 §3 L1 的盲区）。 */
export { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
export { renderSync } from "@sid-code/tui-renderer/root.ts";
