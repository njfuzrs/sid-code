/** next 实现：渲染入口与实例。render 走上游 ink，其余待实现。 */
import type { ReactNode } from "react";
import { render as upstreamRender, type RenderOptions } from "@sid-code/tui";
import upstreamInstances from "@sid-code/tui/instances.ts";
import upstreamDrainStdin from "@sid-code/tui/drain-stdin.ts";
import type { RenderInstance } from "../runtime.ts";
import { notImplementedFn } from "./not-implemented.ts";

/**
 * 端口的 render 是 async（legacy 在首帧前让出一个微任务，见旧底座 root.ts 注释），上游是同步。
 * 这里保留同一个微任务边界，让两套底座首帧时机一致。
 */
export async function render(node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) {
  await Promise.resolve();
  return upstreamRender(node, options);
}

export const drainStdin: (stdin?: NodeJS.ReadStream) => void = upstreamDrainStdin;
export const setSuppressTerminalProbe = notImplementedFn("setSuppressTerminalProbe", "T5.2");

/**
 * ⚠️ 直接返回上游 Ink 实例，**刻意不包一层 adapter**：上游 Ink 没有 RenderInstance 的 8 个方法，
 * 这时契约 X7 在 next 上必须红，CLI 调 `?.forceRedraw()` 也要抛 TypeError，而不是被一个
 * 「方法存在但会抛」的 adapter 骗成 X7 全绿。方法由 T3.3 / T6.1 / T6.2 / T7.1 在实例上逐个补齐。
 */
export function getRenderInstance(
  stdout: NodeJS.WriteStream = process.stdout,
): RenderInstance | undefined {
  return upstreamInstances.get(stdout) as unknown as RenderInstance | undefined;
}
