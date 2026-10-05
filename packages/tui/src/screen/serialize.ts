/**
 * 屏幕缓冲 → 终端字节（B9 / T3.1，契约 R3 / R9）。
 *
 * `serializeRow` 是帧输出的最小单位：假设光标在该行的 `from` 列、当前无样式无链接，
 * 产出把 [from, to) 画出来的字节，结尾把样式和链接都关掉。T3.2 的增量输出按行（或行内一段）调用它。
 *
 * 规则（黑盒对拍旧底座，向量见 tests/fixtures/screen-vectors.json）：
 * - 默认空白单元不写，攒起来在下一个要写的单元前用一次 `CSI n C` 跳过；样式和链接**保持不动**
 *   （所以两个粗体字之间隔着普通空格时，粗体不关再开）。行尾的默认空白直接丢掉；
 * - 切换顺序：先链接、后 SGR；行尾先关 SGR、后关链接。链接从 A 换到 B 时直接打开 B，不先关 A；
 * - SGR 切换 = 样式池的 `transition`（ansi-tokenize `diffAnsiCodes` 口径）；
 * - 宽度补偿（R9）：含 U+FE0F 的宽字形簇（`❤️`、`1️⃣`、`🏳️‍🌈`…）终端之间对它算 1 格还是 2 格不一致。
 *   先在右半格写一个空格，再回到左半格写字符，最后把光标钉到下一格：
 *   `CHA(x+2) ' ' CHA(x+1) 字符 CHA(x+3)`（CHA 列号从 1 起）。这样不论终端算几格，后面的字都不会错位。
 *   收尾的 `CHA(x+3)` 惰性输出：紧跟着的是另一个同样式的补偿字符时省掉（它自己以 CHA 开头），
 *   否则在下一段输出之前（含行尾）补上。
 */
import {oscTerminator} from '../terminal/osc.js';
import {CellWidth, type Screen} from './screen.js';

const ESC = '\x1b';
const VS16 = '️';

/** 超链接终止符跟 OSC 工具同一个判定（kitty 用 ST），模块加载时定一次。 */
const terminator = oscTerminator(process.env);

const cursorForward = (n: number) => `${ESC}[${n}C`;
const cursorColumn = (column0: number) => `${ESC}[${column0 + 1}G`;

export function needsWidthCompensation(value: string, width: number): boolean {
	return width === CellWidth.Wide && value.includes(VS16);
}

export function serializeRow(
	screen: Screen,
	y: number,
	from = 0,
	to: number = screen.width,
): string {
	return serializeCells(screen, y, from, to, i => screen.isBlank(i));
}

/**
 * 帧间增量（B9 / T3.2，契约 R3）：假设光标在 `from` 列、当前无样式无链接，只写与 `previous` 不同的单元。
 *
 * 和 `serializeRow` 同一套写法，区别只在「哪些单元可以跳过」：首帧跳过默认空白，增量帧跳过**没变**的单元。
 * 所以变成默认空白的单元照样写一个空格（旧内容要盖掉），没变的非空白单元用 `CSI n C` 跳过、样式不关。
 * 两帧宽度必须相同（宽度变了走 full reset，见 frame/main-screen.ts）。
 */
export function serializeRowDiff(
	previous: Screen,
	screen: Screen,
	y: number,
	from = 0,
	to: number = screen.width,
): string {
	return serializeCells(screen, y, from, to, i => cellEquals(previous, screen, i));
}

/** 两帧同一下标的单元是否完全相同（字形簇 + 列宽 + 样式 + 链接）。要求两帧共用同一对池。 */
export function cellEquals(a: Screen, b: Screen, i: number): boolean {
	return (
		a.chars[i] === b.chars[i] &&
		a.widths[i] === b.widths[i] &&
		a.styles[i] === b.styles[i] &&
		a.links[i] === b.links[i]
	);
}

function serializeCells(
	screen: Screen,
	y: number,
	from: number,
	to: number,
	skipCell: (index: number) => boolean,
): string {
	const {stylePool, hyperlinkPool} = screen;
	let out = '';
	let style = 0;
	let link = 0;
	let skip = 0;
	// 宽度补偿的收尾 CHA：下一个写出的是另一个补偿字符（它自己以 CHA 开头）时省掉，其余情况先补上
	let pendingColumn = '';

	for (let x = from; x < to; x++) {
		const i = screen.index(x, y);
		const w = screen.widths[i]!;
		if (w === CellWidth.Spacer) {
			continue;
		}

		if (skipCell(i)) {
			// 跳过的是没变的宽字符时光标要前移两格（spacer 不单独计数）；首帧跳过的默认空白都是窄的
			skip += w === CellWidth.Wide ? 2 : 1;
			continue;
		}

		const value = screen.chars[i]!;
		const cellLink = screen.links[i]!;
		const cellStyle = screen.styles[i]!;
		const compensate = needsWidthCompensation(value, w);
		if (
			pendingColumn &&
			!(compensate && skip === 0 && cellLink === link && cellStyle === style)
		) {
			out += pendingColumn;
		}

		pendingColumn = '';

		if (skip > 0) {
			out += cursorForward(skip);
			skip = 0;
		}

		if (cellLink !== link) {
			out +=
				cellLink === 0
					? hyperlinkPool.close(terminator)
					: hyperlinkPool.open(cellLink, terminator);
			link = cellLink;
		}

		out += stylePool.transition(style, cellStyle);
		style = cellStyle;

		if (compensate) {
			out += `${cursorColumn(x + 1)} ${cursorColumn(x)}${value}`;
			pendingColumn = cursorColumn(x + 2);
		} else {
			out += value;
		}
	}

	out += pendingColumn;
	out += stylePool.transition(style, 0);
	if (link !== 0) {
		out += hyperlinkPool.close(terminator);
	}

	return out;
}

/** 整屏首帧：每行之后接 `\r\n`（主屏从光标所在行开始往下画，旧行自然进 scrollback）。 */
export function serializeScreen(screen: Screen): string {
	let out = '';
	for (let y = 0; y < screen.height; y++) {
		out += serializeRow(screen, y) + '\r\n';
	}

	return out;
}

/**
 * 纯文本形态（`renderToString`、非 TTY 整帧输出用）：空白写成空格、不做宽度补偿，
 * 每行去掉行尾默认空白，行间用 `\n`。与上游 `output.get()` 的返回口径一致。
 */
export function screenToString(screen: Screen): string {
	const {stylePool, hyperlinkPool} = screen;
	const lines: string[] = [];
	for (let y = 0; y < screen.height; y++) {
		let end = screen.width;
		while (end > 0 && screen.isBlank(screen.index(end - 1, y))) {
			end--;
		}

		let out = '';
		let style = 0;
		let link = 0;
		for (let x = 0; x < end; x++) {
			const i = screen.index(x, y);
			if (screen.widths[i] === CellWidth.Spacer) {
				continue;
			}

			const cellLink = screen.links[i]!;
			if (cellLink !== link) {
				out +=
					cellLink === 0
						? hyperlinkPool.close(terminator)
						: hyperlinkPool.open(cellLink, terminator);
				link = cellLink;
			}

			out += stylePool.transition(style, screen.styles[i]!);
			style = screen.styles[i]!;
			out += screen.chars[i];
		}

		out += stylePool.transition(style, 0);
		if (link !== 0) {
			out += hyperlinkPool.close(terminator);
		}

		lines.push(out);
	}

	return lines.join('\n');
}
