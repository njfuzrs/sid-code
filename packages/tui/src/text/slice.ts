/**
 * 按终端列切 ANSI 文本（B9 / T2.1，契约 T2 的基础操作）。
 *
 * 规则全部来自对旧底座输出的黑盒对拍（见 `tests/text-vectors.test.ts`）：
 * - 只取「起始列落在 [start, end) 内」的字符。宽字符起始列 < end 就算进来，哪怕右半格超出 end
 *   （调用方按需收紧，见 truncate.ts）；起始列 < start 的宽字符整个丢掉，不劈半。
 * - 零宽字符（组合附标、`\t`、`\n` 等）跟着它前面那个有宽度的字符走：前一个取了它就取，
 *   没取就丢。只有出现在第一个有宽字符之前的零宽字符按它所在的列判断。
 * - 样式：切片开头补上此刻生效的 SGR / 超链接；切片末尾把仍生效的样式关掉。
 *   最后一个取到的字符之后的控制序列：被 end 截断时不带出来（它们只影响后面被丢掉的字符）；
 *   列数没到 end 就走完字符串时原样带出。
 */
import {
	type AnsiCode,
	ansiCodesToString,
	reduceAnsiCodesIncremental,
	tokenize,
	undoAnsiCodes,
} from '@alcalzone/ansi-tokenize';
import {stringWidth} from './width.js';

/**
 * 合并样式状态。`reduceAnsiCodesIncremental` 会把超链接的关闭序列 `OSC 8 ;; ST` 当成一个仍生效的码留下
 * （它的 code 与 endCode 相同），切片末尾就会多关一次。code 与 endCode 相同的码只是关闭动作，这里丢掉。
 */
function reduce(active: AnsiCode[], next: AnsiCode[]): AnsiCode[] {
	return reduceAnsiCodesIncremental(active, next).filter(
		code => code.code !== code.endCode,
	);
}

export function sliceColumns(text: string, start: number, end: number): string {
	let active: AnsiCode[] = [];
	let pending: AnsiCode[] = [];
	let column = 0;
	let started = false;
	let previousTaken: boolean | undefined;
	let out = '';
	let activeAtEnd: AnsiCode[] = [];
	let crossedEnd = false;

	for (const token of tokenize(text)) {
		// 还没取到任何字符就已经到了 end：后面不会再取。停在这里（在吃下一个控制序列之前），
		// 空切片的收尾样式按此刻的状态算——这也是 slice(0, 0) 返回空串而 slice(1, 1) 可能返回关闭序列的原因
		if (!started && column >= end) {
			break;
		}

		if (token.type === 'ansi') {
			if (started) {
				pending.push(token);
			} else {
				active = reduce(active, [token]);
			}

			continue;
		}

		if (token.type === 'control') {
			continue;
		}

		const width = stringWidth(token.value);
		const take =
			width === 0
				? (previousTaken ?? (column >= start && column < end))
				: column >= start && column < end;

		if (take) {
			if (started) {
				out += ansiCodesToString(pending);
				activeAtEnd = reduce(activeAtEnd, pending);
			} else {
				out += ansiCodesToString(active);
				activeAtEnd = active;
				started = true;
			}

			pending = [];
			out += token.value;
		} else if (started && width > 0) {
			// 已开始后遇到第一个不取的有宽字符 = 越过了 end，后面不会再取
			crossedEnd = true;
			break;
		}

		if (width > 0) {
			previousTaken = take;
			column += width;
		}
	}

	// 一个字符都没取到：旧底座仍会输出「关掉此刻生效样式」的序列（视觉上无影响）。
	// 照做，是为了让差分测试能逐字节对拍，而不是给出一份需要解释的白名单。
	if (!started) {
		return ansiCodesToString(undoAnsiCodes(active));
	}

	// 列数没到 end 就走完了字符串：末尾的控制序列没有「后面被丢掉的字符」可言，原样带出。
	// 列数恰好到 end 也算截断（哪怕后面已经没有字符），这是对拍出来的旧行为。
	if (!crossedEnd && column < end) {
		out += ansiCodesToString(pending);
		activeAtEnd = reduce(activeAtEnd, pending);
	}

	return out + ansiCodesToString(undoAnsiCodes(activeAtEnd));
}
