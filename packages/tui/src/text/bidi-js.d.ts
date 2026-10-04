// bidi-js@1.0.3 没有自带类型，DefinitelyTyped 也没有。按它 README 的 API 说明只声明本包用到的两个函数。
declare module 'bidi-js' {
	type EmbeddingLevels = {
		levels: Uint8Array;
		paragraphs: Array<{start: number; end: number; level: number}>;
	};

	type Bidi = {
		getEmbeddingLevels(
			text: string,
			direction?: 'ltr' | 'rtl' | 'auto',
		): EmbeddingLevels;
		/** 返回需要依次翻转的闭区间 `[start, end]`（UTF-16 下标）。 */
		getReorderSegments(
			text: string,
			levels: EmbeddingLevels,
			lineStart?: number,
			lineEnd?: number,
		): Array<[number, number]>;
	};

	export default function bidiFactory(): Bidi;
}
