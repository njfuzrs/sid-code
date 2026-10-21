/**
 * 主屏帧 diff（B9 / T3.2，契约 R3–R6）。
 *
 * 输入是前后两帧的 cell 级屏幕缓冲（T3.1）与视口行数，输出这一帧要写的字节（不含同步输出包裹）。
 * 纯函数，不碰流：调度、同步包裹、隐藏光标由 ink.tsx 负责。
 *
 * 光标约定：一帧写完后光标停在内容**下一行的行首**（每行都以 `\r\n` 结尾），所以前一帧高 p 行时，
 * 光标在第 p 行；内容超出视口时，上面的行已经滚进终端 scrollback，再也改不到了。
 *
 * 规则全部来自黑盒对拍冻结行为基线的 TTY 字节（向量见 tests/fixtures/frame-vectors.json）：
 * - **只比两帧都有的行**（前 min(p, n) 行），逐单元比较；一行里第一个变化的单元前用
 *   `\r` + `CUF(x)` + 竖向移动（`CUU` / `CUD`）定位，然后只写变化的单元（`serializeRowDiff`）；
 *   各变化段共用一支笔：段间移光标不关样式 / 链接，最后一段之后才收笔（收缩时在回到第 n 行之后）；
 *   最后一个变化行之后用 `\r\n` + `\n`×k 回到底部。没有任何变化 → 一个字节都不写；
 * - **纯增长**（R4）：新增的行按首帧口径逐行追加，旧行自然进 scrollback；
 * - **收缩**（不触发 full reset 时）：`eraseLines(p - n)` 擦掉底部，`CUU 1` 回到第 n 行，
 *   再用整行宽的空格把 p - n 行盖一遍（`\r` + `CUD 1` 逐行），最后回到第 n 行；
 *   有变化的行在擦除之后、空格之前写，竖向移动以第 n 行为基准；
 * - **溢出后收缩补空行**（sid-code 有意偏离冻结基线）：前一帧已溢出视口（p ≥ H）而新帧变矮时，
 *   不走上面的「擦底部」——滚进 scrollback 的行拉不回来，擦掉底部只会让整帧上移、在 footer 下面留
 *   p - n 行空白（主屏 History 在帧里，帧高几乎恒超视口，动态区每收缩一次就漏一次）。改为在新帧里
 *   补 p - n 行空行把高度撑回 p，补在历史区下沿（调用方传 historyEnd；不传才按内容猜，见 padInsertRow），
 *   底部的输入框 / 状态栏原地不动；之后内容增长会原地覆盖这些空行。实际画上去的帧经 `screen` 返回，
 *   调用方必须拿它做下一帧的 previous；
 * - **full reset**（`ESC[2J ESC[3J ESC[H` + 整帧重画）在下面三种情况发生：
 *   ① 宽度变了（R7 的帧层部分；视口变矮与 resize 事件合并在 ink.tsx，见 `resetMainScreen`）；
 *   ② 有变化的行已经滚出视口：行号 y < p - H + 1（R5，原因 offscreen）；
 *   ③ 收缩时 p - n > H - 1（新的底部落在视口之上），或前一帧已占满视口（p ≥ H）而新帧 n ≤ H（R6）。
 */
import ansiEscapes from 'ansi-escapes';
import {closePen, type Pen, serializeRow, serializeRowDiff} from '../screen/serialize.js';
import {Screen} from '../screen/screen.js';

const ESC = '\u001B';
const CLEAR_TERMINAL = `${ESC}[2J${ESC}[3J${ESC}[H`;

const cursorUp = (n: number) => (n > 0 ? `${ESC}[${n}A` : '');
const cursorDown = (n: number) => (n > 0 ? `${ESC}[${n}B` : '');
const cursorForward = (n: number) => (n > 0 ? `${ESC}[${n}C` : '');

/** 一次 full reset 的记录（基线 onFrame 事件里叫 flickers，字段名照旧）。 */
export type FrameFlicker = {
	desiredHeight: number;
	availableHeight: number;
	reason: 'offscreen' | 'resize';
};

export type FrameDiff = {
	/** 本帧要写的字节；空串 = 不写（连同步输出包裹也不要） */
	bytes: string;
	flicker?: FrameFlicker;
	/** 实际画到终端上的帧，与传入的 next 不同（溢出后收缩补了空行）时才给；调用方拿它做下一帧的 previous */
	screen?: Screen;
};

/** 整帧：每行之后 `\r\n`。首帧、full reset、追加新行都用它。 */
function rows(screen: Screen, from: number, to: number): string {
	let out = '';
	for (let y = from; y < to; y++) {
		out += serializeRow(screen, y) + '\r\n';
	}

	return out;
}

/**
 * 第 y 行第一个变化的单元（宽字符的 spacer 跟着左半格走，不单独算）；没变化返回 -1。
 * 四个平铺数组直接比（B9 / T3.4）：每帧要扫两帧共有的全部行，函数调用开销随历史长度线性涨。
 */
function firstChangedColumn(previous: Screen, next: Screen, y: number): number {
	const base = next.index(0, y);
	const {chars: ac, widths: aw, styles: as, links: al} = previous;
	const {chars: bc, widths: bw, styles: bs, links: bl} = next;
	for (let x = 0, i = base; x < next.width; x++, i++) {
		if (ac[i] !== bc[i] || as[i] !== bs[i] || aw[i] !== bw[i] || al[i] !== bl[i]) {
			return x;
		}
	}

	return -1;
}

/** previous 第 py 行与 next 第 ny 行逐单元相同 */
function rowsEqual(previous: Screen, py: number, next: Screen, ny: number): boolean {
	const a = previous.index(0, py);
	const b = next.index(0, ny);
	for (let x = 0; x < next.width; x++) {
		const i = a + x;
		const j = b + x;
		if (
			previous.chars[i] !== next.chars[j] ||
			previous.styles[i] !== next.styles[j] ||
			previous.widths[i] !== next.widths[j] ||
			previous.links[i] !== next.links[j]
		) {
			return false;
		}
	}

	return true;
}

/**
 * 溢出后收缩的插入点。
 *
 * 知道历史区（History）下沿、且下沿在视口内时插在它下面：空行落在历史区与动态区之间，动态区整体贴底，
 * 任何组件内部都不会被插进空行。
 *
 * 不知道下沿（没用 History 的调用方），或下沿已滚出视口，才退回按两帧内容猜（guessInsertRow）。
 * 这个猜法在真实 TUI 里两头都会切错组件（2026-10-22 复现）：状态栏计费同帧变了 → 公共尾部只剩最后一行，
 * 空行插进状态栏两行之间；输入框变矮 → 公共尾部从输入框下边框起算，空行插进输入框里面。帧层看不到组件边界，猜不对。
 */
function padInsertRow(
	previous: Screen,
	next: Screen,
	viewportRows: number,
	historyEnd: number | undefined,
): number {
	const p = previous.height;
	const n = next.height;
	const firstVisible = Math.max(0, p - viewportRows + 1);
	if (historyEnd !== undefined && historyEnd >= firstVisible) {
		return Math.min(n, historyEnd);
	}

	// 下沿已滚出视口（动态区比视口高，比如长流式正文）：插在下沿会动到 scrollback 里的行而 full reset，
	// 夹到视口顶行又会把空行插进正文中间（2026-10-22 实测）。只能退回按内容猜，再夹到视口内
	return Math.max(guessInsertRow(previous, next), firstVisible);
}

/** 不知道组件边界时按两帧内容猜插入点：公共尾部之前，没有公共尾部就插在第一个变化行 */
function guessInsertRow(previous: Screen, next: Screen): number {
	const p = previous.height;
	const n = next.height;
	let prefix = 0;
	while (prefix < n && rowsEqual(previous, prefix, next, prefix)) {
		prefix++;
	}

	let suffix = 0;
	while (prefix + suffix < n && rowsEqual(previous, p - 1 - suffix, next, n - 1 - suffix)) {
		suffix++;
	}

	return suffix > 0 ? n - suffix : prefix;
}

/** 溢出后收缩：在 next 的第 at 行前插 p - n 行空行，高度撑回 p（插入点见 padInsertRow） */
function padShrunkFrame(previous: Screen, next: Screen, at: number): Screen {
	const p = previous.height;
	const n = next.height;
	const count = p - n;
	const padded = new Screen(next.width, p, {styles: next.stylePool, links: next.hyperlinkPool});
	const head = at * next.width;
	const shift = count * next.width;
	for (const key of ['chars', 'widths', 'styles', 'links'] as const) {
		const from = next[key];
		const to = padded[key];
		to.set(from.subarray(0, head), 0);
		to.set(from.subarray(head), head + shift);
	}

	padded.wrapEnd.set(next.wrapEnd.subarray(0, at), 0);
	padded.wrapEnd.set(next.wrapEnd.subarray(at), at + count);
	return padded;
}

/**
 * full reset：清屏 + 清 scrollback + 回原点，再按首帧口径画整帧。
 * R7（B9 / T3.3）的视口变化判定在 ink.tsx 出帧时做（它要比较的是上一帧出帧时的视口，不是上一帧的屏幕），
 * 判定成立就直接用这里，与前一帧是否存在、是否为空无关（基线空帧变宽也照样清屏）。
 */
export function resetMainScreen(
	next: Screen,
	viewportRows: number,
	reason: FrameFlicker['reason'],
): FrameDiff {
	return {
		bytes: CLEAR_TERMINAL + rows(next, 0, next.height),
		flicker: {desiredHeight: next.height, availableHeight: viewportRows, reason},
	};
}

export function diffMainScreen(
	previous: Screen | undefined,
	target: Screen,
	viewportRows: number,
	/** 新帧里历史区（History）下沿的行号；只用于溢出后收缩选插入点，缺省按内容猜 */
	historyEnd?: number,
): FrameDiff {
	let next = target;
	let n = next.height;
	if (!previous || previous.height === 0) {
		return {bytes: rows(next, 0, n)};
	}

	const p = previous.height;
	// full reset 一律画原始帧（不带补的空行）：清屏之后没有 scrollback 的约束，整帧从头画即可
	const fullReset = (reason: FrameFlicker['reason']): FrameDiff =>
		resetMainScreen(target, viewportRows, reason);

	if (previous.width !== next.width) {
		return fullReset('resize');
	}

	// ③ 收缩：新的底部落到视口之上，或从「占满视口」收缩到「不超过视口」
	if (
		n < p &&
		(p - n > viewportRows - 1 || (p >= viewportRows && n <= viewportRows))
	) {
		return fullReset('offscreen');
	}

	// 溢出后收缩：补空行撑回原高，footer 原地不动（见文件头）
	const padded = n < p && p >= viewportRows;
	if (padded) {
		next = padShrunkFrame(
			previous,
			next,
			padInsertRow(previous, next, viewportRows, historyEnd),
		);
		n = p;
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

	let out = '';
	// 竖向移动的基准行：收缩时擦完底部光标在第 n 行，否则在第 p 行
	let cursorRow = p;
	if (shrinking) {
		// 1 行收缩到空帧：基线只回行首再上移，不擦行（擦除由下面的空格覆盖完成）。B9 / T3.3 对拍补上
		out += (p === 1 && n === 0 ? '\r' : ansiEscapes.eraseLines(p - n)) + cursorUp(1);
		cursorRow = n;
	}

	// 一支笔跨所有变化段（B9 / T4.2）：段与段之间只移光标，样式和链接不关，最后一段写完才收笔
	const pen: Pen = {style: 0, link: 0};
	for (const {y, x} of changed) {
		out += '\r' + cursorForward(x);
		out += y < cursorRow ? cursorUp(cursorRow - y) : cursorDown(y - cursorRow);
		out += serializeRowDiff(previous, next, y, x, undefined, pen);
		cursorRow = y;
	}

	if (shrinking) {
		if (changed.length > 0) {
			// 收缩：光标回到第 n 行之后才收笔，再用空格盖掉多出的行
			out += '\r' + cursorDown(n - cursorRow) + closePen(next, pen);
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
		out += closePen(next, pen) + '\r\n' + '\n'.repeat(p - cursorRow - 1);
	}

	out += rows(next, p, n);
	return padded ? {bytes: out, screen: next} : {bytes: out};
}

/**
 * SIGCONT 之后的第一帧（B9 / T3.3，契约 R10 主屏部分）：前一帧已作废（别的程序可能动过屏幕），
 * 但基线并不清屏，而是**从光标处按首帧口径往下写**，只是把「前面没变的行」省成一个 `\r\n`：
 * 第一个变化行之前（只看两帧都有的行）每行写 `\r\n`，从第一个变化行起逐行写整行。
 * 只在新帧不比前一帧矮、宽度相同时适用；否则调用方按首帧整帧画。规则来自黑盒对拍。
 */
export function redrawAfterSuspend(stale: Screen, next: Screen): string | undefined {
	if (next.height < stale.height || next.width !== stale.width) {
		return undefined;
	}

	let first = stale.height;
	for (let y = 0; y < stale.height; y++) {
		if (firstChangedColumn(stale, next, y) >= 0) {
			first = y;
			break;
		}
	}

	return '\r\n'.repeat(first) + rows(next, first, next.height);
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
