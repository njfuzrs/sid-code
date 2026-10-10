/** next 实现：布局测量（B9 / T4.3，契约 L4）。 */
import { getBoundingBox, measureElement as upstreamMeasure, ResizeObserver } from "@sid-code/tui";
import type { DOMElement } from "@sid-code/tui";

/**
 * 上游 measureElement 多返回 x / y（布局树坐标），端口面只有宽高（legacy 的形状）。
 * 位置要用 getBoundingBox。空参数照样抛 TypeError（legacy 同），已移除的节点得 0×0。
 */
export function measureElement(node: DOMElement): { width: number; height: number } {
  const { width, height } = upstreamMeasure(node);
  return { width, height };
}

export { getBoundingBox, ResizeObserver };
