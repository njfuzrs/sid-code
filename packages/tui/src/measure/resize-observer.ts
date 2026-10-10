// sid-code（B9 / T4.3，契约 L4）：新写。规则来自黑盒对拍旧底座（时序探针见 packages/cli/tests/render-port/contracts-layout-text.test.tsx），没有读旧代码。
import {type DOMElement} from '../dom.js';

/** 与旧底座同形：只有尺寸，位置恒为 0 */
export type ContentRect = {
	width: number;
	height: number;
	x: number;
	y: number;
	top: number;
	left: number;
	right: number;
	bottom: number;
};

export type ResizeObserverEntry = {target: DOMElement; contentRect: ContentRect};

export type ResizeObserverCallback = (
	entries: ResizeObserverEntry[],
	observer: ResizeObserver,
) => void;

type Size = {width: number; height: number};

/** 轮询周期。对拍：每个观察者一个 16ms 定时器，尺寸变化后 2–18ms 内回调 */
const POLL_INTERVAL_MS = 16;

// 已移除的节点没有 yoga 节点，按 0×0 报一次；参数为空时读 `.yogaNode` 抛 TypeError，与旧底座一致
const sizeOf = (node: DOMElement): Size => {
	const {yogaNode} = node;
	return yogaNode
		? {width: yogaNode.getComputedWidth(), height: yogaNode.getComputedHeight()}
		: {width: 0, height: 0};
};

const entryOf = (target: DOMElement, {width, height}: Size): ResizeObserverEntry => ({
	target,
	contentRect: {width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height},
});

/**
 * 轮询式尺寸观察，形似 DOM 的 ResizeObserver（VirtualizedList / MaxSizedBox 用它测容器与项高度）。
 *
 * 对拍得出的时序（契约 L4）：
 * - `observe` 之后在微任务里单独报一次（排在调用方随后排的微任务之前）当前尺寸（尺寸为 0 也报），每次 observe 调用各自一次回调；
 *   同一 tick 里又 `unobserve` 了就不报；已在观察的目标重复 observe 什么都不做；
 * - 之后每 16ms 轮询，只比宽高（只挪位置不回调），同一轮里变了的目标合成**一次**回调；
 * - 节点被移除后报一次 0×0；
 * - 定时器 `unref`，忘了 disconnect 不会拖住进程退出。
 *
 * 首帧回调拿到的就是首次布局的尺寸；「首帧高度为 0」只发生在调用方挂载时内容还没进树的情况，
 * 所以进历史区（scrollback）的内容不能靠它同步裁剪（见 ui/CLAUDE.md 的 Static 安全铁律）。
 */
export class ResizeObserver {
	readonly #callback: ResizeObserverCallback;
	readonly #targets = new Map<DOMElement, Size>();
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(callback: ResizeObserverCallback) {
		this.#callback = callback;
	}

	observe(target: DOMElement): void {
		if (this.#targets.has(target)) {
			return;
		}

		const size = sizeOf(target);
		this.#targets.set(target, size);
		queueMicrotask(() => {
			if (this.#targets.has(target)) {
				this.#callback([entryOf(target, size)], this);
			}
		});
		this.#start();
	}

	unobserve(target: DOMElement): void {
		this.#targets.delete(target);
		if (this.#targets.size === 0) {
			this.#stop();
		}
	}

	disconnect(): void {
		this.#targets.clear();
		this.#stop();
	}

	#start(): void {
		if (this.#timer) {
			return;
		}

		this.#timer = setInterval(this.#poll, POLL_INTERVAL_MS);
		this.#timer.unref?.();
	}

	#stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	readonly #poll = (): void => {
		const entries: ResizeObserverEntry[] = [];
		for (const [target, last] of this.#targets) {
			const size = sizeOf(target);
			if (size.width !== last.width || size.height !== last.height) {
				this.#targets.set(target, size);
				entries.push(entryOf(target, size));
			}
		}

		if (entries.length > 0) {
			this.#callback(entries, this);
		}
	};
}
