/**
 * sid-code（B9 / T7.1a，契约 E1 / E2）：裸 `process.stderr.write` 护栏。
 *
 * 渲染期间任何直写 stderr 的字节都会落在 TUI 画面上（stdout / stderr 在终端里是同一块屏幕），
 * 所以挂载时把全局 `process.stderr.write` 换成一个吞字节的拦截器。规则全部来自旧底座黑盒探针（D-5）：
 *
 * - **无条件安装**：与 TTY、`patchConsole`、`debug` 选项、stdout 是哪个流都无关；
 *   只换全局 `process.stderr`，不碰 `options.stderr`（自定义 stderr 原样直写）。
 * - **吞掉**：不写底层流、不擦屏、不重绘（alt-screen 下也不重绘，下一帧照常增量 diff），恒返回 `true`；
 *   回调（第二或第三个参数里的函数）**同步、无参**调用。
 * - **转文本**：字符串原样（忽略 encoding 参数），其余一律 `Buffer.from(chunk).toString()`（UTF-8）。
 *   非法 chunk（对象 / null / undefined）由 `Buffer.from` 抛 TypeError —— 回调先调、错误再抛。
 * - **debug 日志**：`SID_CODE_DEBUG` 在**模块加载时**恰为 `1` 或 `true` 才写
 *   `console.error("[ink] [stderr] " + 文本, {level: "warn"})`，其余取值（含 `TRUE`、` 1`）都不写。
 *   走 `console.error` 而不是 stderr：CLI 的 console 护栏会把它转进 logger。
 * - **重入守卫（E2）**：日志路径里再写 stderr（logger → stderr）时直接交给原始 write，不再拦截；
 *   日志抛错时守卫照样复位，错误向上抛。
 * - **卸载**：只有 `process.stderr.write` 仍是自己时才还原成安装时看到的那个，
 *   别人后来换掉的不动（多个实例按挂载 / 卸载顺序各自还原，乱序卸载会留下前一个拦截器，与旧底座相同）。
 */
import process from 'node:process';
import {Buffer} from 'node:buffer';

const debugValue = process.env['SID_CODE_DEBUG'];
const debugEnabled = debugValue === '1' || debugValue === 'true';

type Write = NodeJS.WriteStream['write'];

/** 安装拦截器，返回还原函数（幂等：已被别人换掉时什么也不做） */
export function patchStderr(stream: NodeJS.WriteStream = process.stderr): () => void {
	const original = stream.write;
	let inside = false;

	function intercept(
		chunk: unknown,
		encodingOrCallback?: unknown,
		callback?: unknown,
	): boolean {
		if (inside) {
			return (original as (...args: unknown[]) => boolean).call(
				stream,
				chunk,
				encodingOrCallback,
				callback,
			);
		}

		const done =
			typeof encodingOrCallback === 'function'
				? encodingOrCallback
				: typeof callback === 'function'
					? callback
					: undefined;

		inside = true;
		try {
			const text =
				typeof chunk === 'string'
					? chunk
					: Buffer.from(chunk as Uint8Array).toString();
			if (debugEnabled) {
				console.error(`[ink] [stderr] ${text}`, {level: 'warn'});
			}
		} finally {
			inside = false;
			(done as (() => void) | undefined)?.();
		}

		return true;
	}

	stream.write = intercept as Write;

	return () => {
		if (stream.write === (intercept as Write)) {
			stream.write = original;
		}
	};
}
