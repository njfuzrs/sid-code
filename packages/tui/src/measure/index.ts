/** 布局测量（B9 / T4.3，契约 L4）：getBoundingBox、轮询式 ResizeObserver。measureElement 用上游的 `../measure-element.ts`。 */
export {getBoundingBox, type BoundingBox} from './bounding-box.js';
export {
	ResizeObserver,
	type ContentRect,
	type ResizeObserverCallback,
	type ResizeObserverEntry,
} from './resize-observer.js';
