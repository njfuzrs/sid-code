/**
 * 闪烁检测 Hook
 *
 * 检测 UI 渲染高度超出终端高度的情况（闪烁）。
 * 当检测到闪烁时记录日志，帮助定位渲染 bug。
 *
 * 参考 gemini-cli useFlickerDetector.ts
 */

import { useEffect } from "react";
import { type DOMElement, measureElement } from "ink";
import { useUIState } from "../contexts/UIStateContext.tsx";
import { getLogger } from "../../debug/logger.ts";

/** 闪烁统计 */
let flickerCount = 0;

/**
 * 检测渲染闪烁（实际高度 > 终端高度）
 *
 * @param rootUiRef 根 UI 元素的 ref
 * @param terminalHeight 终端高度（行数）
 */
export function useFlickerDetector(
  rootUiRef: React.RefObject<DOMElement | null>,
  terminalHeight: number,
): void {
  const { constrainHeight } = useUIState();

  useEffect(() => {
    if (!rootUiRef.current) return;

    try {
      const measurement = measureElement(rootUiRef.current);
      if (measurement.height > terminalHeight) {
        // 不限制高度时，溢出是预期行为
        if (!constrainHeight) return;

        flickerCount++;
        const log = getLogger();
        log.warn(
          "UI:FLICKER",
          `检测到渲染闪烁 #${flickerCount}: 实际高度 ${measurement.height} > 终端高度 ${terminalHeight}`,
        );
      }
    } catch {
      // measureElement 可能在组件卸载后抛出异常，忽略
    }
  });
}

/** 获取闪烁计数（用于调试/统计） */
export function getFlickerCount(): number {
  return flickerCount;
}
