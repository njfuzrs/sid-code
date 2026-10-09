/**
 * `useAnimationFrame(intervalMs | null)` → `[ref, time]`（B9 / T3.2，离屏暂停 T3.4）。
 *
 * 订阅共享时钟（keepAlive），距上次更新满 `intervalMs` 时把 `time` 更新为 `clock.now()` 并重渲。
 * 传 `null` 时退订、`time` 停在最后一个值；初值为挂载时的 `clock.now()`（`null` 起步则为 0）。
 *
 * 离屏暂停（契约 P5，黑盒扫描旧底座 105 组位置得出）：`ref` 挂的 Box 整个滚进 scrollback 后不再订阅时钟，
 * 动画停在最后一帧，省掉「每 tick 重渲 + 出帧」。可见判定见 `isInViewport`。
 * 判定**只在这个组件重渲时做**，读的是上一次提交的布局：暂停之后时钟不再触发重渲，
 * 所以要等别的原因（父组件重渲等）让它重渲、且上一帧里它已回到视口内，才恢复。旧底座就是这样
 * （例如帧从 11 行收缩到 10 行的那次重渲仍判离屏，再下一次重渲才恢复；React.memo 包住的组件则一直停着）。
 */
import {useContext, useEffect, useRef, useState} from 'react';
import Yoga from 'yoga-layout';
import {ClockContext} from '../clock.js';
import {type DOMElement} from '../dom.js';
import StdoutContext from '../components/StdoutContext.js';
import {getWindowSize} from '../utils.js';

/**
 * 节点在主屏视口内吗：整帧 p 行、视口 H 行时，光标停在帧底下一行，视口里能看到的是帧的最后 H - 1 行，
 * 即第 p - H + 1 行起。帧不超过视口（p ≤ H）时一律可见。节点底边 y + h - 1 落在这一段里就算可见。
 * 节点不在树上、没有布局、`display: none` 时按可见算（不暂停）。
 */
export function isInViewport(node: DOMElement | null, rows: number): boolean {
	if (!node?.yogaNode) {
		return true;
	}

	let y = 0;
	let root: DOMElement = node;
	for (let cur: DOMElement | undefined = node; cur; cur = cur.parentNode) {
		if (!cur.yogaNode || cur.yogaNode.getDisplay() === Yoga.DISPLAY_NONE) {
			return true;
		}

		y += cur.yogaNode.getComputedTop();
		root = cur;
	}

	if (root.nodeName !== 'ink-root') {
		return true;
	}

	const p = root.yogaNode!.getComputedHeight();
	if (p <= rows) {
		return true;
	}

	const h = Math.max(1, node.yogaNode.getComputedHeight());
	return y + h - 1 >= p - rows + 1;
}

export default function useAnimationFrame(
	intervalMs: number | null = 16,
): [React.RefObject<DOMElement | null>, number] {
	const clock = useContext(ClockContext);
	const {stdout} = useContext(StdoutContext);
	const ref = useRef<DOMElement | null>(null);
	const [time, setTime] = useState(() =>
		intervalMs === null || !clock ? 0 : clock.now(),
	);
	// 渲染期读上一次提交的布局（见文件头）。首次渲染 ref 还没挂上，按可见算
	const visible = isInViewport(ref.current, getWindowSize(stdout).rows);
	const active = intervalMs !== null && visible;

	useEffect(() => {
		if (!active || !clock) {
			return;
		}

		let last = clock.now();
		return clock.subscribe(() => {
			const now = clock.now();
			if (now - last >= intervalMs) {
				last = now;
				setTime(now);
			}
		}, true);
	}, [clock, intervalMs, active]);

	return [ref, time];
}
