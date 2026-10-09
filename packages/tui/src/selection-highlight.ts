/**
 * 选区高亮落到屏幕缓冲（B9 / T6.2b，契约 M5）。
 *
 * 规则来自对旧底座的黑盒探针（D-5，没读旧代码），结果备份在
 * `~/Backups/sid-code-t67-probe-results-20261008/T6.2b/m9-legacy.txt`：
 * - 设了颜色：每个选中单元**去掉原有背景色和反显 7**，再加上选区背景色；前景、粗体、下划线、链接照留
 *   （`ab` 红字仍是红字，`ef` 反显被去掉，`cd` 的蓝底换成选区色）。
 * - 没设颜色、或颜色认不出（`bogus`，colorize 原样返回）：每个选中单元加反显 7（已经反显的不变）。
 * - 空白单元也涂（多行选区首行涂到行尾、中间整行）。
 * 返回新屏幕，不改传入的那一帧（帧 diff 要拿它和下一帧比）。
 */
import {type AnsiCode, tokenize} from '@alcalzone/ansi-tokenize';
import colorize from './colorize.js';
import {Screen} from './screen/screen.js';
import type {HighlightSpan} from './selection.js';

const INVERSE: AnsiCode = {type: 'ansi', code: '\u001B[7m', endCode: '\u001B[27m'};
const BG_END = '\u001B[49m';

/** 选区色对应的背景 SGR；认不出返回 undefined（回退反显） */
export function selectionBgCode(color: string | undefined): AnsiCode | undefined {
	if (!color) return undefined;
	const token = tokenize(colorize(' ', color, 'background')).find(
		(t): t is AnsiCode => t.type === 'ansi' && t.endCode === BG_END,
	);
	return token;
}

export function applySelectionHighlight(
	screen: Screen,
	spans: HighlightSpan[],
	color: string | undefined,
): Screen {
	if (spans.length === 0) return screen;
	const out = new Screen(screen.width, screen.height, {
		styles: screen.stylePool,
		links: screen.hyperlinkPool,
	});
	out.chars.set(screen.chars);
	out.widths.set(screen.widths);
	out.styles.set(screen.styles);
	out.links.set(screen.links);
	out.wrapEnd.set(screen.wrapEnd);

	const bg = selectionBgCode(color);
	const pool = screen.stylePool;
	const cache = new Map<number, number>();
	const restyle = (id: number): number => {
		let next = cache.get(id);
		if (next === undefined) {
			const codes = pool.codesOf(id);
			next = bg
				? pool.intern([
						...codes.filter(c => c.endCode !== BG_END && c.endCode !== INVERSE.endCode),
						bg,
					])
				: codes.some(c => c.endCode === INVERSE.endCode)
					? id
					: pool.intern([...codes, INVERSE]);
			cache.set(id, next);
		}

		return next;
	};

	for (const {y, x0, x1} of spans) {
		for (let x = x0; x <= x1; x++) {
			const i = out.index(x, y);
			out.styles[i] = restyle(out.styles[i]!);
		}
	}

	return out;
}
