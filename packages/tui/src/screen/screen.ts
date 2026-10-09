/**
 * cell 级屏幕缓冲（B9 / T3.1，契约 R3 / R9 / T4）。
 *
 * 取代上游 `output.ts` 里的 `StyledChar[][]`：每个单元是「一个字形簇 + 列宽 + 样式 id + 超链接 id」，
 * 平铺在四个数组里。T3.2 的帧 diff 逐单元比较这四个值，不需要再去比较字符串。
 *
 * 写入规则（黑盒对拍旧底座，向量见 tests/fixtures/screen-vectors.json）：
 * - 一行 ANSI 文本先按 ansi-tokenize 切成字形簇（组合附标、ZWJ、VS16 跟着基字符），样式**不跨行**：
 *   调用方按 `\n` 拆行后逐行写，每行从无样式开始；
 * - 列宽为 0 的簇（零宽空格、行首孤立附标、控制字符）丢弃；`\t` 不写单元，只把列推进到下一个
 *   **屏幕绝对列**的 8 的倍数；
 * - 簇必须整个落在 [minX, maxX) 内（maxX 取裁剪框右边界或屏幕宽），压在边界上的宽字符整个丢掉，不劈半；
 * - 覆盖写入时，被劈开的宽字符剩下的那半格还原成默认空白（无样式、无链接），
 *   所以屏幕上永远没有孤立的 spacer（契约 T4）；
 * - 需要软件 bidi 的终端，一行先按视觉顺序重排再落格（契约 T3，见 text/bidi.ts）。
 */
import {
	type AnsiCode,
	styledCharsFromTokens,
	tokenize,
} from '@alcalzone/ansi-tokenize';
import {reorderBidi} from '../text/bidi.js';
import {stringWidth} from '../text/width.js';
import {
	classifyHyperlink,
	hyperlinkPool,
	isHyperlinkCode,
	type HyperlinkPool,
	stylePool,
	type StylePool,
} from './pools.js';

/** 单元列宽：0 = 宽字符右半格（spacer），1 = 窄，2 = 宽字符左半格。 */
export const enum CellWidth {
	Spacer = 0,
	Narrow = 1,
	Wide = 2,
}

const TAB_STOP = 8;

type Run = {value: string; char: number; width: number; style: number; link: number};

/**
 * 字形簇 → 整数 id（B9 / T3.4，契约 P3）。单元里存 id 而不是字符串：整屏是平铺的 `Uint32Array`，
 * 分配是一次 memset、帧 diff 比整数。id 只是字符串驻留，与样式无关，所以进程级共享一张表即可。
 * 0 号恒为空格（默认空白），1 号恒为空串（宽字符的 spacer）。
 */
const charTable: string[] = [' ', ''];
const charIds = new Map<string, number>([
	[' ', 0],
	['', 1],
]);

export function internChar(value: string): number {
	let id = charIds.get(value);
	if (id === undefined) {
		id = charTable.length;
		charTable.push(value);
		charIds.set(value, id);
	}

	return id;
}

const SPACER_CHAR = 1;

/** 一行 ANSI 文本 → 字形簇序列（带样式 / 链接 id）。同一行文本反复出现（每帧都写），结果缓存。 */
const runCache = new Map<string, Run[]>();
const RUN_CACHE_LIMIT = 10_000;

function toRuns(line: string, styles: StylePool, links: HyperlinkPool): Run[] {
	const shared = styles === stylePool && links === hyperlinkPool;
	if (shared) {
		const cached = runCache.get(line);
		if (cached) {
			return cached;
		}
	}

	const chars = reorderBidi(styledCharsFromTokens(tokenize(line)));
	const runs: Run[] = [];
	let lastCodes: AnsiCode[] | undefined;
	let lastStyle = 0;
	let lastLink = 0;
	for (const char of chars) {
		// styledCharsFromTokens 对同一段样式下的字符复用同一个数组，按引用跳过重复的拆分
		if (char.styles !== lastCodes) {
			lastCodes = char.styles;
			const sgr: AnsiCode[] = [];
			lastLink = 0;
			for (const code of char.styles) {
				const kind = isHyperlinkCode(code) ? classifyHyperlink(code) : 'style';
				if (kind === 'link') {
					lastLink = links.intern(code);
				} else if (kind === 'style') {
					sgr.push(code);
				}
			}

			lastStyle = styles.intern(sgr);
		}

		runs.push({
			value: char.value,
			char: internChar(char.value),
			width: char.value === '\t' ? -1 : stringWidth(char.value),
			style: lastStyle,
			link: lastLink,
		});
	}

	if (shared) {
		if (runCache.size >= RUN_CACHE_LIMIT) {
			runCache.clear();
		}

		runCache.set(line, runs);
	}

	return runs;
}

export class Screen {
	readonly width: number;
	readonly height: number;
	/** 每个单元的字形簇 id（`internChar`）；0 = 空格，spacer 为空串的 id。取字符串用 `charAt` */
	readonly chars: Uint32Array;
	readonly widths: Uint8Array;
	readonly styles: Uint32Array;
	readonly links: Uint32Array;
	/**
	 * 软换行记录（B9 / T6.2a，选区复制用）：`wrapEnd[y] >= 0` 表示第 y 行是被自动换行折断的，
	 * 内容接着写在第 y+1 行，值是第 y 行内容结束的列（右开）。-1 = 硬换行或没有文本。
	 * 复制时软换行的两行直接拼接、不插 `\n`，且第 y 行只取到这一列（之后写进同一行的别的文本不算，
	 * 旧底座实测：并排两列时左列折行，复制左列首行不带右列内容）。
	 */
	readonly wrapEnd: Int32Array;
	readonly stylePool: StylePool;
	readonly hyperlinkPool: HyperlinkPool;

	constructor(
		width: number,
		height: number,
		pools: {styles?: StylePool; links?: HyperlinkPool} = {},
	) {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
		const size = this.width * this.height;
		this.chars = new Uint32Array(size);
		this.widths = new Uint8Array(size).fill(CellWidth.Narrow);
		this.styles = new Uint32Array(size);
		this.links = new Uint32Array(size);
		this.wrapEnd = new Int32Array(this.height).fill(-1);
		this.stylePool = pools.styles ?? stylePool;
		this.hyperlinkPool = pools.links ?? hyperlinkPool;
	}

	index(x: number, y: number): number {
		return y * this.width + x;
	}

	/** 单元的字形簇字符串（spacer 为空串） */
	charAt(index: number): string {
		return charTable[this.chars[index]!]!;
	}

	/**
	 * 在 (x, y) 写一行 ANSI 文本（不含 `\n`）。`minX` / `maxX` 是裁剪框的左右边界（右开），
	 * 缺省为整行。返回写完后的列。
	 */
	writeLine(
		x: number,
		y: number,
		line: string,
		minX = 0,
		maxX = this.width,
	): number {
		if (y < 0 || y >= this.height || line === '') {
			return x;
		}

		const left = Math.max(0, minX);
		const right = Math.min(this.width, maxX);
		let col = x;
		for (const run of toRuns(line, this.stylePool, this.hyperlinkPool)) {
			if (run.width < 0) {
				col = (Math.floor(col / TAB_STOP) + 1) * TAB_STOP;
				continue;
			}

			if (run.width === 0) {
				continue;
			}

			if (col < left) {
				col += run.width;
				continue;
			}

			if (col + run.width > right) {
				break;
			}

			this.putId(col, y, run.char, run.width, run.style, run.link);
			col += run.width;
		}

		return col;
	}

	/** 写一个簇。宽度只能是 1 或 2（终端没有更宽的单元）。 */
	put(
		x: number,
		y: number,
		value: string,
		width: number,
		style: number,
		link: number,
	): void {
		this.putId(x, y, internChar(value), width, style, link);
	}

	private putId(
		x: number,
		y: number,
		char: number,
		width: number,
		style: number,
		link: number,
	): void {
		const w = width >= 2 ? 2 : 1;
		const start = this.index(x, y);
		const end = start + w; // 右开
		const rowStart = this.index(0, y);
		const rowEnd = rowStart + this.width;

		// 劈开的宽字符：spacer 被覆盖 → 清它的左半格；左半格被覆盖而 spacer 在范围外 → 清 spacer
		if (this.widths[start] === CellWidth.Spacer && start - 1 >= rowStart) {
			this.clear(start - 1);
		}

		const last = end - 1;
		if (this.widths[last] === CellWidth.Wide && last + 1 < rowEnd) {
			this.clear(last + 1);
		}

		this.chars[start] = char;
		this.widths[start] = w === 2 ? CellWidth.Wide : CellWidth.Narrow;
		this.styles[start] = style;
		this.links[start] = link;
		if (w === 2) {
			this.chars[start + 1] = SPACER_CHAR;
			this.widths[start + 1] = CellWidth.Spacer;
			this.styles[start + 1] = style;
			this.links[start + 1] = link;
		}
	}

	private clear(index: number): void {
		this.chars[index] = 0;
		this.widths[index] = CellWidth.Narrow;
		this.styles[index] = 0;
		this.links[index] = 0;
	}

	/** 是否「默认空白」：空格、无样式、无链接。序列化时用光标前移跳过，不写字节。 */
	isBlank(index: number): boolean {
		return (
			this.chars[index] === 0 &&
			this.styles[index] === 0 &&
			this.links[index] === 0
		);
	}
}
