/**
 * 截断与换行（B9 / T2.1，契约 T2）。
 *
 * 换行用 Bun 内置 `Bun.wrapAnsi`（`hard: true` 硬折超长词，`trim` 由模式决定）：
 * 黑盒对拍 14 段语料 × 宽 1–14 与旧底座逐字节一致。上游 ink 用的 npm `wrap-ansi@10` 在 CJK、
 * ZWJ emoji、`\t` 上与旧底座不同（宽 1 时旧底座行首留空行，ZWJ 序列被拆开），以旧底座为准。
 *
 * 截断不用上游的 `cli-truncate`：它把省略号放进 SGR 里面（`ESC[31m re… ESC[39m`），并且会吞掉 `\t` / `\n`，
 * 旧底座是省略号在样式之外、零宽字符原样保留。规则（全部是对拍结果）：
 * - 宽度 < 1 → 空串；宽度 = 1 → 只有省略号；本来就放得下 → 原样返回。
 * - end：保留前 `columns - 1` 列 + `…`。
 * - start：`…` + 最后 `columns - 1` 列。
 * - middle：前 `floor(columns / 2)` 列 + `…` + 最后 `columns - floor(columns / 2) - 1` 列。
 * - 每一段如果因为宽字符多占了一列，就再少取一列（宽字符不劈半，宁可少一格）。
 */
import {sliceColumns} from './slice.js';
import {stringWidth} from './width.js';

export const ELLIPSIS = '…';

export type TruncatePosition = 'start' | 'middle' | 'end';

/** 取 [start, end) 列；结果比 `end - start` 宽（右边界压着宽字符）时收紧一列。 */
function sliceWithin(text: string, start: number, end: number): string {
	const slice = sliceColumns(text, start, end);
	return stringWidth(slice) > end - start
		? sliceColumns(text, start, end - 1)
		: slice;
}

export function truncate(
	text: string,
	columns: number,
	position: TruncatePosition,
): string {
	if (columns < 1) {
		return '';
	}

	if (columns === 1) {
		return ELLIPSIS;
	}

	const width = stringWidth(text);
	if (width <= columns) {
		return text;
	}

	if (position === 'start') {
		return ELLIPSIS + sliceWithin(text, width - columns + 1, width);
	}

	if (position === 'middle') {
		const head = Math.floor(columns / 2);
		return (
			sliceWithin(text, 0, head) +
			ELLIPSIS +
			sliceWithin(text, width - (columns - head) + 1, width)
		);
	}

	return sliceWithin(text, 0, columns - 1) + ELLIPSIS;
}

export type WrapMode =
	| 'wrap'
	| 'wrap-trim'
	| 'hard'
	| 'truncate'
	| 'truncate-end'
	| 'truncate-middle'
	| 'truncate-start';

const bunWrapAnsi = typeof Bun === 'undefined' ? undefined : Bun.wrapAnsi;

function wrapAnsi(
	text: string,
	columns: number,
	options: {trim: boolean; wordWrap: boolean},
): string {
	if (!bunWrapAnsi) {
		throw new Error('@sid-code/tui 的换行依赖 Bun.wrapAnsi（Bun ≥ 1.3）');
	}

	return bunWrapAnsi(text, columns, {hard: true, ...options});
}

/**
 * 按模式把文本排进 `columns` 列。未知模式原样返回（旧底座对 `end` / `middle` 这类历史值也是原样返回）。
 */
export function wrapText(
	text: string,
	columns: number,
	mode: WrapMode | (string & {}) = 'wrap',
): string {
	switch (mode) {
		case 'wrap': {
			return wrapAnsi(text, columns, {trim: false, wordWrap: true});
		}

		case 'wrap-trim': {
			return wrapAnsi(text, columns, {trim: true, wordWrap: true});
		}

		case 'hard': {
			return wrapAnsi(text, columns, {trim: false, wordWrap: false});
		}

		case 'truncate':
		case 'truncate-end': {
			return truncate(text, columns, 'end');
		}

		case 'truncate-middle': {
			return truncate(text, columns, 'middle');
		}

		case 'truncate-start': {
			return truncate(text, columns, 'start');
		}

		default: {
			return text;
		}
	}
}
