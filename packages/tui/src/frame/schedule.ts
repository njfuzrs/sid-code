/**
 * 出帧调度开关（B9 / T3.2，契约 R2 / R13）。
 *
 * - 真实运行：同一 tick 内的多次提交在 microtask 里合并成一帧（leading），之后 16ms 内最多再补一帧（trailing）；
 * - 测试环境（`NODE_ENV=test`）：**每次提交同步出帧**，`lastFrame()` 在 rerender 之后立即可读——全仓几千个
 *   断言靠它。测帧调度本身的用例经端口 `enableFrameThrottle()` 打开真实调度，打开的就是这里的覆盖开关。
 *
 * 每次提交都重新判定（不在实例创建时定死），所以测试中途打开 / 恢复立即生效。
 */
export const FRAME_INTERVAL_MS = 16;

let throttleInTests = false;

/** 测试里打开真实调度，返回恢复函数（端口 `enableFrameThrottle` 用）。 */
export function enableFrameThrottleInTests(): () => void {
	const previous = throttleInTests;
	throttleInTests = true;
	return () => {
		throttleInTests = previous;
	};
}

export function framesAreSynchronous(): boolean {
	return process.env['NODE_ENV'] === 'test' && !throttleInTests;
}
