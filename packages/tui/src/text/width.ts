/**
 * 终端列宽（B9 / T2.1，契约 T1）。
 *
 * 用 Bun 内置的 `Bun.stringWidth`，并把东亚宽度为 Ambiguous 的字符按窄（1 列）算。
 * 依据是黑盒对拍：在 U+0000–U+10FFFF 全部码位（去掉代理区）上，这个组合与旧底座逐个一致；
 * npm `string-width@8.2.2` 有 478 个码位不一致，集中在天城文等印度系文字的元音附标
 * （如 `क्ष` 旧底座算 2、string-width 算 1）。终端给这类连字分配的是 2 格，算成 1 会让布局和光标错位。
 *
 * 非 Bun 运行时（理论上不会出现：产物是 bun 编译的单文件）回落到 string-width，接受上面那批差异。
 */
import stringWidthFallback from 'string-width';

const bunStringWidth =
	typeof Bun === 'undefined' ? undefined : Bun.stringWidth;

const OPTIONS = {ambiguousIsNarrow: true} as const;

export const stringWidth: (text: string) => number = bunStringWidth
	? text => bunStringWidth(text, OPTIONS)
	: text => stringWidthFallback(text, OPTIONS);

/** 多行文本里最宽一行的列宽。 */
export function widestLine(text: string): number {
	let max = 0;
	for (const line of text.split('\n')) {
		const w = stringWidth(line);
		if (w > max) {
			max = w;
		}
	}

	return max;
}
