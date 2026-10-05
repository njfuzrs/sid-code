/**
 * `useAnimationFrame(intervalMs | null)` → `[ref, time]`（B9 / T3.2）。
 *
 * 订阅共享时钟（keepAlive），距上次更新满 `intervalMs` 时把 `time` 更新为 `clock.now()` 并重渲。
 * 传 `null` 时退订、`time` 停在最后一个值；初值为挂载时的 `clock.now()`（`null` 起步则为 0）。
 * `ref` 挂在要动画的 Box 上；旧底座按它判断是否在视口内（离屏暂停），新底座暂不做离屏暂停，留给 T3.4。
 */
import {useContext, useEffect, useRef, useState} from 'react';
import {ClockContext} from '../clock.js';
import {type DOMElement} from '../dom.js';

export default function useAnimationFrame(
	intervalMs: number | null = 16,
): [React.RefObject<DOMElement | null>, number] {
	const clock = useContext(ClockContext);
	const ref = useRef<DOMElement | null>(null);
	const [time, setTime] = useState(() =>
		intervalMs === null || !clock ? 0 : clock.now(),
	);

	useEffect(() => {
		if (intervalMs === null || !clock) {
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
	}, [clock, intervalMs]);

	return [ref, time];
}
