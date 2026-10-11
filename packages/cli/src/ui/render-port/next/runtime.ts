/** next 实现：渲染入口与实例。render 走上游 ink。 */
import type { ReactNode } from "react";
import { render as upstreamRender, type RenderOptions } from "@sid-code/tui";
import upstreamInstances from "@sid-code/tui/instances.ts";
import upstreamDrainStdin from "@sid-code/tui/drain-stdin.ts";
import { setSuppressTerminalProbe as nextSetSuppressTerminalProbe } from "@sid-code/tui/terminal-probe.ts";
import type { RenderInstance } from "../runtime.ts";

/**
 * 端口的 render 是 async（旧底座在首帧前让出一个微任务），上游是同步。
 * 这里保留同一个微任务边界：CLI 调用点都按「await 之后才有首帧」写，契约测试也按这个时机断言。
 */
export async function render(node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) {
  await Promise.resolve();
  return upstreamRender(node, options);
}

export const drainStdin: (stdin?: NodeJS.ReadStream) => void = upstreamDrainStdin;
export const setSuppressTerminalProbe: (value: boolean) => void = nextSetSuppressTerminalProbe;

/**
 * ⚠️ 直接返回底座的 Ink 实例，**刻意不包一层 adapter**：RenderInstance 的方法都实现在实例上，
 * 少一个时契约 X7（`render-instance.test.tsx`）必须红、CLI 调 `?.forceRedraw()` 也要抛 TypeError，
 * 而不是被一个「方法存在但会抛」的 adapter 骗成全绿。
 */
export function getRenderInstance(
  stdout: NodeJS.WriteStream = process.stdout,
): RenderInstance | undefined {
  return upstreamInstances.get(stdout) as unknown as RenderInstance | undefined;
}
