/**
 * 主屏帧 diff（B9 / T3.2，契约 R3–R6）。
 *
 * 输入是前后两帧的 cell 级屏幕缓冲（T3.1）与视口行数，输出这一帧要写的字节（不含同步输出包裹）。
 * 纯函数，不碰流：调度、同步包裹、隐藏光标由 ink.tsx 负责。
 *
 * 光标约定：一帧写完后光标停在内容**下一行的行首**（每行都以 `\r\n` 结尾），所以前一帧高 p 行时，
 * 光标在第 p 行；内容超出视口时，上面的行已经滚进终端 scrollback，再也改不到了。
 *
 * 规则全部来自黑盒对拍旧底座的 TTY 字节（向量见 tests/fixtures/frame-vectors.json）：
 * - **只比两帧都有的行**（前 min(p, n) 行），逐单元比较；一行里第一个变化的单元前用
 *   `\r` + `CUF(x)` + 竖向移动（`CUU` / `CUD`）定位，然后只写变化的单元（`serializeRowDiff`）；
 *   最后一个变化行之后用 `\r\n` + `\n`×k 回到底部。没有任何变化 → 一个字节都不写；
 * - **纯增长**（R4）：新增的行按首帧口径逐行追加，旧行自然进 scrollback；
 * - **收缩**（不触发 full reset 时）：`eraseLines(p - n)` 擦掉底部，`CUU 1` 回到第 n 行，
 *   再用整行宽的空格把 p - n 行盖一遍（`\r` + `CUD 1` 逐行），最后回到第 n 行；
 *   有变化的行在擦除之后、空格之前写，竖向移动以第 n 行为基准；
 * - **full reset**（`ESC[2J ESC[3J ESC[H` + 整帧重画）在下面三种情况发生：
 *   ① 宽度变了（R7 的帧层部分；resize 事件合并等归 T3.3）；
 *   ② 有变化的行已经滚出视口：行号 y < p - H + 1（R5，原因 offscreen）；
 *   ③ 收缩时 p - n > H - 1（新的底部落在视口之上），或前一帧已占满视口（p ≥ H）而新帧 n ≤ H（R6）。
 */
import ansiEscapes from 'ansi-escapes';
import {cellEquals, serializeRow, serializeRowDiff} from '../screen/serialize.js';
import {type Screen} from '../screen/screen.js';

const ESC = '\u001B';
const CLEAR_TERMINAL = `${ESC}[2J${ESC}[3J${ESC}[H`;

const cursorUp = (n: number) => (n > 0 ? `${ESC}[${n}A` : '');
const cursorDown = (n: number) => (n > 0 ? `${ESC}[${n}B` : '');
const cursorForward = (n: number) => (n > 0 ? `${ESC}[${n}C` : '');

/** 一次 full reset 的记录（旧底座 onFrame 事件里叫 flickers，字段名照旧）。 */
export type FrameFlicker = {
	desiredHeight: number;
	availableHeight: number;
	reason: 'offscreen' | 'resize';
};

export type FrameDiff = {
	/** 本帧要写的字节；空串 = 不写（连同步输出包裹也不要） */
	bytes: string;
	flicker?: FrameFlicker;
};

/** 整帧：每行之后 `\r\n`。首帧、full reset、追加新行都用它。 */
function rows(screen: Screen, from: number, to: number): string {
	let out = '';
	for (let y = from; y < to; y++) {
		out += serializeRow(screen, y) + '\r\n';
	}

	return out;
}

/** 第 y 行第一个变化的单元（宽字符的 spacer 跟着左半格走，不单独算）；没变化返回 -1。 */
function firstChangedColumn(previous: Screen, next: Screen, y: number): number {
	const base = next.index(0, y);
	for (let x = 0; x < next.width; x++) {
		if (!cellEquals(previous, next, base + x)) {
			return x;
		}
	}

	return -1;
}

export function diffMainScreen(
	previous: Screen | undefined,
	next: Screen,
	viewportRows: number,
): FrameDiff {
	const n = next.height;
	if (!previous || previous.height === 0) {
		return {bytes: rows(next, 0, n)};
	}

	const p = previous.height;
	const fullReset = (reason: FrameFlicker['reason']): FrameDiff => ({
		bytes: CLEAR_TERMINAL + rows(next, 0, n),
		flicker: {desiredHeight: n, availableHeight: viewportRows, reason},
	});

	if (previous.width !== next.width) {
		return fullReset('resize');
	}

	const shared = Math.min(p, n);
	const changed: Array<{y: number; x: number}> = [];
	for (let y = 0; y < shared; y++) {
		const x = firstChangedColumn(previous, next, y);
		if (x >= 0) {
			changed.push({y, x});
		}
	}

	// ② 变化落在已滚进 scrollback 的行上：光标最多能上移到视口顶，即第 p - (H - 1) 行
	const firstVisible = p - viewportRows + 1;
	if (changed.length > 0 && changed[0]!.y < firstVisible) {
		return fullReset('offscreen');
	}

	const shrinking = n < p;
	// ③ 收缩：新的底部落到视口之上，或从「占满视口」收缩到「不超过视口」
	if (
		shrinking &&
		(p - n > viewportRows - 1 || (p >= viewportRows && n <= viewportRows))
	) {
		return fullReset('offscreen');
	}

	let out = '';
	// 竖向移动的基准行：收缩时擦完底部光标在第 n 行，否则在第 p 行
	let cursorRow = p;
	if (shrinking) {
		out += ansiEscapes.eraseLines(p - n) + cursorUp(1);
		cursorRow = n;
	}

	for (const {y, x} of changed) {
		out += '\r' + cursorForward(x);
		out += y < cursorRow ? cursorUp(cursorRow - y) : cursorDown(y - cursorRow);
		out += serializeRowDiff(previous, next, y, x);
		cursorRow = y;
	}

	if (shrinking) {
		if (changed.length > 0) {
			out += '\r' + cursorDown(n - cursorRow);
		}

		const blank = ' '.repeat(previous.width);
		const count = p - n;
		for (let i = 0; i < count; i++) {
			out += blank + '\r' + (i < count - 1 ? cursorDown(1) : '');
		}

		out += cursorUp(count - 1);
		return {bytes: out};
	}

	if (changed.length > 0) {
		out += '\r\n' + '\n'.repeat(p - cursorRow - 1);
	}

	out += rows(next, p, n);
	return {bytes: out};
}

/**
 * 擦掉当前帧（光标在第 p 行），回到第 0 行行首。外部写入（patchConsole / writeToStdout）
 * 之前用，写完再按首帧重画。只擦视口内的部分：已进 scrollback 的行擦不到。
 */
export function eraseMainScreen(previous: Screen | undefined): string {
	if (!previous || previous.height === 0) {
		return '';
	}

	return ansiEscapes.eraseLines(previous.height + 1);
}
