/** legacy 实现：渲染入口与实例。加载它等于加载整套旧引擎，见 ../README.md。 */
import type { RenderInstance } from "../runtime.ts";
import legacyInstances from "@sid-code/tui-renderer/instances.ts";

export { default as render } from "@sid-code/tui-renderer/root.ts";
export { drainStdin } from "@sid-code/tui-renderer/ink.tsx";
export { setSuppressTerminalProbe } from "@sid-code/tui-renderer/terminal.ts";

/** 按 stdout 取当前挂载的渲染实例；没挂载返回 undefined。CLI 拿实例一律走这里。 */
export function getRenderInstance(
  stdout: NodeJS.WriteStream = process.stdout,
): RenderInstance | undefined {
  return legacyInstances.get(stdout);
}
