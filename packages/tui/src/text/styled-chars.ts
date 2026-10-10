/**
 * 带样式字符序列的宽度与换行（B9 / T2.2，契约 T6）。TableRenderer 用它排表格单元格。
 *
 * 规则来自对旧底座的黑盒对拍（向量见 tests/fixtures/text-vectors.json 的 styledChars 段）：
 * - 字符宽度按 `stringWidth(char.value)` 算，不看 tokenizer 给的 `fullWidth`
 *   （它对天城文连字报窄，终端实占 2 格）。
 * - 分词：空格和 `\t` 算空白，其余（包括 `\n`、全角空格、不换行空格）都算词的一部分；
 *   相邻同类字符归成一段。
 * - 换行：
 *   - 行宽为 0 时遇到空白段，直接丢掉（行首不留空白）；
 *   - 空白段放不下：换行，并丢掉这段空白；
 *   - 词放得下就接在当前行；放不下但不超过整行宽度，就换到下一行；
 *   - 比整行还宽的词按字符硬折，先填满当前行的剩余空间。单个字符比整行还宽时独占一行。
 *   - 宽度 ≤ 0 时不换行，整段作为一行返回。最后一行总会输出，哪怕是空行。
 * - 返回的是输入里的同一批字符对象，不复制，样式随字符走。
 */
import {
	type StyledChar,
	styledCharsFromTokens,
	tokenize,
} from '@alcalzone/ansi-tokenize';
import {stringWidth} from './width.js';

export type {StyledChar};

export function toStyledCharacters(text: string): StyledChar[] {
	return styledCharsFromTokens(tokenize(text));
}

export function styledCharsWidth(chars: readonly StyledChar[]): number {
	let width = 0;
	for (const char of chars) {
		width += stringWidth(char.value);
	}

	return width;
}

const isBlank = (char: StyledChar): boolean =>
	char.value === ' ' || char.value === '\t';

export function wordBreakStyledChars(chars: readonly StyledChar[]): StyledChar[][] {
	const words: StyledChar[][] = [];
	let word: StyledChar[] = [];
	let wordIsBlank = false;
	for (const char of chars) {
		const blank = isBlank(char);
		if (word.length > 0 && blank !== wordIsBlank) {
			words.push(word);
			word = [];
		}

		word.push(char);
		wordIsBlank = blank;
	}

	if (word.length > 0) {
		words.push(word);
	}

	return words;
}

export function widestLineFromStyledChars(
	lines: ReadonlyArray<readonly StyledChar[]>,
): number {
	let widest = 0;
	for (const line of lines) {
		widest = Math.max(widest, styledCharsWidth(line));
	}

	return widest;
}

export function wrapStyledChars(
	chars: StyledChar[],
	columns: number,
): StyledChar[][] {
	if (columns <= 0) {
		return [chars];
	}

	const lines: StyledChar[][] = [];
	let line: StyledChar[] = [];
	let lineWidth = 0;
	const breakLine = () => {
		lines.push(line);
		line = [];
		lineWidth = 0;
	};

	const append = (part: readonly StyledChar[], width: number) => {
		line.push(...part);
		lineWidth += width;
	};

	for (const word of wordBreakStyledChars(chars)) {
		const width = styledCharsWidth(word);

		if (isBlank(word[0]!)) {
			if (lineWidth === 0) {
				continue;
			}

			if (lineWidth + width <= columns) {
				append(word, width);
			} else {
				breakLine();
			}

			continue;
		}

		if (lineWidth + width <= columns) {
			append(word, width);
		} else if (width <= columns) {
			breakLine();
			append(word, width);
		} else {
			for (const char of word) {
				const charWidth = stringWidth(char.value);
				if (lineWidth > 0 && lineWidth + charWidth > columns) {
					breakLine();
				}

				append([char], charWidth);
			}
		}
	}

	lines.push(line);
	return lines;
}
