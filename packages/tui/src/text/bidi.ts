/**
 * 软件 bidi 重排（B9 / T2.1，契约 T3）。
 *
 * 大多数终端自己做 bidi，这里什么都不做；只有不做 bidi 的终端才由我们按 Unicode UAX #9 把
 * 一行字符重排成视觉顺序。哪些终端需要是对拍旧底座得出的：
 * - `process.platform === 'win32'`（conhost / Windows Terminal）；
 * - 设置了 `WT_SESSION`（**有这个变量就算，空串也算**；覆盖 WSL 里的 Windows Terminal）；
 * - `TERM_PROGRAM === 'vscode'`（xterm.js）。
 * 其余（macOS / Linux 原生终端、iTerm2 等）原样返回。判定只做一次。
 *
 * 重排单位是调用方给的「字符簇」（一个可见字符及其组合附标），簇内部不拆，所以附标始终跟着基字符。
 * 段落方向用 `auto`（第一个强方向字符决定），括号不做镜像——都与旧底座一致。
 */
import bidiFactory from 'bidi-js';

type Bidi = ReturnType<typeof bidiFactory>;

let bidi: Bidi | undefined;
let needed: boolean | undefined;

/** 当前终端是否需要我们做 bidi。导出给测试；生产代码直接调 `reorderBidi`。 */
export function terminalNeedsSoftwareBidi(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		platform === 'win32' ||
		env['WT_SESSION'] !== undefined ||
		env['TERM_PROGRAM'] === 'vscode'
	);
}

// 只判断「有没有可能需要重排」：没有 RTL 强字符的行（绝大多数）跳过整套 UAX #9 计算
const RTL_CHARACTER =
	/[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/**
 * 按视觉顺序重排一行字符簇。不需要软件 bidi、空行、或行内没有 RTL 字符时返回**同一个数组**。
 */
export function reorderBidi<T extends {value: string}>(characters: T[]): T[] {
	needed ??= terminalNeedsSoftwareBidi();
	if (!needed || characters.length === 0) {
		return characters;
	}

	const text = characters.map(c => c.value).join('');
	if (!RTL_CHARACTER.test(text)) {
		return characters;
	}

	bidi ??= bidiFactory();
	const levels = bidi.getEmbeddingLevels(text, 'auto');
	const segments = bidi.getReorderSegments(text, levels);
	if (segments.length === 0) {
		return characters;
	}

	// bidi-js 按 UTF-16 下标给出翻转区间；换算成簇下标（簇起点所在的 UTF-16 下标 → 簇序号）
	const clusterAt = new Int32Array(text.length);
	let offset = 0;
	for (const [index, c] of characters.entries()) {
		clusterAt.fill(index, offset, offset + c.value.length);
		offset += c.value.length;
	}

	const result = [...characters];
	for (const [start, end] of segments) {
		reverse(result, clusterAt[start]!, clusterAt[end]!);
	}

	return result;
}

function reverse<T>(array: T[], start: number, end: number): void {
	while (start < end) {
		const t = array[start]!;
		array[start] = array[end]!;
		array[end] = t;
		start++;
		end--;
	}
}

/** 测试用：清掉判定缓存，让下一次调用按当前环境重新判定。 */
export function resetBidiDetectionForTesting(): void {
	needed = undefined;
}
