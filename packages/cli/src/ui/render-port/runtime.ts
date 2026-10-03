/** 渲染入口与实例。加载它等于加载整套引擎，见 README.md。 */
export { default as render } from "@sid-code/tui-renderer/root.ts";
export { default as inkInstances } from "@sid-code/tui-renderer/instances.ts";
export { drainStdin } from "@sid-code/tui-renderer/ink.tsx";
export { setSuppressTerminalProbe } from "@sid-code/tui-renderer/terminal.ts";
