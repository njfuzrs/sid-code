/**
 * 滚动量化(Scroll Quantum) — P2-1
 *
 * 问题:VirtualizedList 每次 scrollTop 变化都重算可见范围并触发 React 重渲染。
 * 鼠标滚轮高频触发时 React commit 次数过多。
 *
 * 方案:将"用于计算可见范围的 scrollTop"量化到固定 bin。只有跨越 bin 边界时
 * 可见范围才变化 → useMemo 依赖量化值而非原始 scrollTop → commit 次数骤降。
 * 视觉滚动仍由渲染层读取真实 scrollTop,保持平滑。
 *
 * 纯函数,完全可单测。
 */

/** 视口外额外挂载的缓冲行数 */
export const OVERSCAN_ROWS = 80;
/** 量化步长:overscan 的一半 —— 保证量化误差始终落在 overscan 缓冲内,可见范围不会"露馅" */
export const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1; // 40
/** 单次 commit 最多扩展的项目数,避免一次性挂载过多组件 */
export const SLIDE_STEP = 25;

export interface VisibleRange {
  start: number;
  end: number;
}

/** 将 scrollTop 对齐到最近的(向下取整)quantum 边界 */
export function quantize(scrollTop: number, quantum: number = SCROLL_QUANTUM): number {
  if (quantum <= 0) return scrollTop;
  // clamp 负值到 0:scrollTop 不应为负,防御异常输入
  const v = scrollTop < 0 ? 0 : scrollTop;
  return Math.floor(v / quantum) * quantum;
}

/**
 * 基于量化 scrollTop 计算可见范围(含 overscan)。
 * offsets[i] 为第 i 项的顶部像素偏移,offsets 长度 = totalItems + 1。
 */
export function computeQuantizedRange(
  scrollTop: number,
  viewportHeight: number,
  offsets: number[],
  totalItems: number,
  overscan: number = OVERSCAN_ROWS,
  quantum: number = SCROLL_QUANTUM,
): VisibleRange {
  if (totalItems <= 0) return { start: 0, end: 0 };

  const qTop = quantize(scrollTop, quantum);
  const top = Math.max(0, qTop - overscan);
  const bottom = qTop + viewportHeight + overscan;

  const start = findFirstVisible(offsets, top);
  const end = findLastVisible(offsets, bottom, totalItems);

  return {
    start: Math.max(0, start),
    end: Math.min(totalItems - 1, end),
  };
}

/** 找到第一个底部 > scrollTop 的项(即视口顶部所在项)。top 越过内容末尾时 clamp 到最后一项。 */
export function findFirstVisible(offsets: number[], top: number): number {
  const n = offsets.length - 1; // 项目数
  if (n <= 0) return 0;
  // offsets 升序,二分找第一个 offsets[i+1] > top;找不到(top 越过末尾)默认最后一项
  let lo = 0;
  let hi = n - 1;
  let ans = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] > top) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** 找到最后一个顶部 < bottom 的项 */
export function findLastVisible(offsets: number[], bottom: number, totalItems: number): number {
  let lo = 0;
  let hi = totalItems - 1;
  let ans = totalItems - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < bottom) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 滑动挂载:限制单次 commit 相对上一帧范围的扩展幅度,
 * 让大跳转分多帧逐步挂载,避免单帧 commit 过慢。
 */
export function slideRange(
  prev: VisibleRange,
  target: VisibleRange,
  step: number = SLIDE_STEP,
): VisibleRange {
  return {
    start: Math.max(target.start, prev.start - step),
    end: Math.min(target.end, prev.end + step),
  };
}
