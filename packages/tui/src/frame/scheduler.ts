/**
 * 帧调度器（B9 / T3.2，契约 R2 / R13）。
 *
 * 黑盒对拍旧底座得到的口径：
 * - 第一次请求排进 microtask（同一 tick 内的同步提交合并）→ leading 帧；
 * - leading 帧之后开一个 16ms 窗口；从 leading 排队起到窗口结束，只要又来过请求，窗口结束时补**一个** trailing 帧，
 *   并开下一个窗口。所以同一 tick 里连提交 5 次 = leading 1 帧 + trailing 1 帧；
 * - 测试环境（`framesAreSynchronous()`）每次请求同步出帧。
 *
 * 提供 `flush` / `cancel`，ink.tsx 卸载、挂起、等待刷新时按 lodash throttle 的口径调用。
 */
import {FRAME_INTERVAL_MS, framesAreSynchronous} from './schedule.js';

export class FrameScheduler {
	private queued = false;
	private trailing = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	// microtask 无法取消：flush / cancel 之后旧的 microtask 靠代号失效
	private generation = 0;

	constructor(private readonly run: () => void) {}

	request(): void {
		if (framesAreSynchronous()) {
			this.run();
			return;
		}

		if (this.queued || this.timer) {
			this.trailing = true;
			return;
		}

		this.queued = true;
		const generation = this.generation;
		queueMicrotask(() => {
			if (generation !== this.generation || !this.queued) {
				return;
			}

			this.queued = false;
			this.fire();
		});
	}

	get pending(): boolean {
		return this.queued || this.trailing;
	}

	/** 有待出的帧就立刻出，并清掉窗口。 */
	flush(): void {
		const hadPending = this.pending;
		this.cancel();
		if (hadPending) {
			this.run();
		}
	}

	cancel(): void {
		this.generation++;
		this.queued = false;
		this.trailing = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private fire(): void {
		this.run();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.trailing) {
				this.trailing = false;
				this.fire();
			}
		}, FRAME_INTERVAL_MS);
	}
}
