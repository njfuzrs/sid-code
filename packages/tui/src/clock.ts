/**
 * 共享动画时钟（B9 / T3.2）：`ClockContext` 与 `useAnimationFrame` 的时间源。
 *
 * 行为来自黑盒探测旧底座：
 * - `now()` 是自第一次读时钟起的毫秒数（首帧渲染时读到 0）；
 * - `subscribe(cb, keepAlive)`：只有存在 keepAlive 订阅者时才按 `tickInterval`（默认 16ms）走，
 *   每一跳通知**全部**订阅者；只剩非 keepAlive 订阅者时时钟停下，它们也不再收到通知；
 * - 计时器 `unref`，不会因为时钟挂着而让进程不退出。
 */
import {createContext} from 'react';
import {FRAME_INTERVAL_MS} from './frame/schedule.js';

export type Clock = {
	subscribe: (callback: () => void, keepAlive: boolean) => () => void;
	now: () => number;
	setTickInterval: (ms: number) => void;
	/** 卸载时停表（不在端口面上） */
	stop: () => void;
};

export function createClock(): Clock {
	let start: number | undefined;
	const subscribers = new Map<() => void, boolean>();
	let interval = FRAME_INTERVAL_MS;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;

	const keepAliveCount = () => {
		let n = 0;
		for (const keepAlive of subscribers.values()) {
			if (keepAlive) {
				n++;
			}
		}

		return n;
	};

	const tick = () => {
		for (const callback of [...subscribers.keys()]) {
			callback();
		}
	};

	const sync = () => {
		const shouldRun = !stopped && keepAliveCount() > 0;
		if (shouldRun && !timer) {
			timer = setInterval(tick, interval);
			timer.unref?.();
		} else if (!shouldRun && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	return {
		subscribe(callback, keepAlive) {
			subscribers.set(callback, keepAlive);
			sync();
			return () => {
				subscribers.delete(callback);
				sync();
			};
		},
		now() {
			start ??= performance.now();
			return Math.round(performance.now() - start);
		},
		setTickInterval(ms) {
			interval = ms;
			if (timer) {
				clearInterval(timer);
				timer = undefined;
				sync();
			}
		},
		stop() {
			stopped = true;
			subscribers.clear();
			sync();
		},
	};
}

export const ClockContext = createContext<Clock | null>(null);
ClockContext.displayName = 'ClockContext';
