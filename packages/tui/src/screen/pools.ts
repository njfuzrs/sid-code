/**
 * 样式池与超链接池（B9 / T3.1，契约 R3）。
 *
 * 屏幕缓冲的每个单元只存两个整数 id（SGR 样式 id、超链接 id），不存 AnsiCode 数组：
 * - 帧 diff（T3.2）比的是 id，两帧之间同样式的单元 id 相同，比较是 O(1)；
 * - SGR 切换序列按 (from, to) 缓存，同一对样式只算一次 `diffAnsiCodes`。
 * 池是进程级共享的：跨帧比较 id 的前提是两帧用同一个池。id 0 恒为「无样式 / 无链接」。
 *
 * 规则来自黑盒对拍旧底座（tests/fixtures/screen-vectors.json）：
 * - 相邻单元之间的 SGR 切换 = `diffAnsiCodes(前, 后)`，与 ansi-tokenize 的归并口径一致；
 * - 超链接：参数为空且以 BEL 结尾的 `OSC 8 ;; url BEL` 改写为 `OSC 8 ; id=<hash> ; url`，
 *   终止符按终端（kitty 用 ST），hash 是 url 的 Java 式字符串 hash 按无符号 36 进制。
 *   同一 url 的两段链接 id 相同，终端据此把它们当成同一个链接（悬停一起高亮）。
 *   其余链接码不改写，当作 SGR 样式的一部分（见 `classifyHyperlink`）。
 */
import {
	type AnsiCode,
	ansiCodesToString,
	diffAnsiCodes,
} from '@alcalzone/ansi-tokenize';

const ESC = '\x1b';
const BEL = '\x07';
const LINK_PREFIX = `${ESC}]8;`;

export function isHyperlinkCode(code: AnsiCode): boolean {
	return code.code.startsWith(LINK_PREFIX);
}

export class StylePool {
	/** 下标即 id；0 号是空样式 */
	private readonly table: AnsiCode[][] = [[]];
	private readonly lookup = new Map<string, number>();
	private readonly transitions = new Map<number, string>();

	/** 已归并的 SGR 码列表 → id。空列表恒为 0。 */
	intern(codes: AnsiCode[]): number {
		if (codes.length === 0) {
			return 0;
		}

		const key = codes.map(c => `${c.code}\0${c.endCode}`).join('\0');
		const known = this.lookup.get(key);
		if (known !== undefined) {
			return known;
		}

		this.lookup.set(key, this.table.length);
		this.table.push(codes);
		return this.table.length - 1;
	}

	codesOf(id: number): AnsiCode[] {
		return this.table[id] ?? [];
	}

	/** 从样式 from 切到 to 所需的最少 SGR 序列（相同时为空串）。 */
	transition(from: number, to: number): string {
		if (from === to) {
			return '';
		}

		// 样式数远小于 2^21，拼成一个整数做键
		const key = from * 2_097_152 + to;
		let seq = this.transitions.get(key);
		if (seq === undefined) {
			seq = ansiCodesToString(diffAnsiCodes(this.codesOf(from), this.codesOf(to)));
			this.transitions.set(key, seq);
		}

		return seq;
	}

	get size(): number {
		return this.table.length;
	}
}

/** url 的 Java 式 hash（UTF-16 码元，32 位溢出）按无符号 36 进制。 */
export function hyperlinkId(url: string): string {
	let h = 0;
	for (let i = 0; i < url.length; i++) {
		h = (Math.imul(h, 31) + url.charCodeAt(i)) | 0;
	}

	return (h >>> 0).toString(36);
}

/**
 * 一个超链接码归哪一类：
 * - `drop`：只是关闭动作（`OSC 8 ;;` 无 url，code 与 endCode 相同）；
 * - `link`：可改写的普通链接（参数为空、BEL 结尾、url 非空），进超链接池，单元上记链接 id；
 * - `style`：其余（带参数 / 已带 id / ST 结尾），**原样留在 SGR 样式里**，随 `diffAnsiCodes` 开关。
 *   旧底座就是这么分的，所以「改写链接 ↔ 原样链接」切换时会出现先开后关之类的顺序，对拍向量钉住了它。
 */
export function classifyHyperlink(
	code: AnsiCode,
): 'drop' | 'link' | 'style' {
	if (code.code === code.endCode) {
		return 'drop';
	}

	const body = code.code.slice(LINK_PREFIX.length);
	if (!body.endsWith(BEL)) {
		return 'style';
	}

	const sep = body.indexOf(';');
	if (sep !== 0) {
		return 'style';
	}

	return body.length - 1 > 1 ? 'link' : 'drop';
}

export class HyperlinkPool {
	/** 下标即 id；0 号是「无链接」 */
	private readonly urls: string[] = [''];
	private readonly byCode = new Map<string, number>();

	/** 可改写的链接码（`classifyHyperlink` 为 `link`）→ id。 */
	intern(code: AnsiCode): number {
		const known = this.byCode.get(code.code);
		if (known !== undefined) {
			return known;
		}

		// `ESC ] 8 ; ; <url> BEL`
		this.urls.push(code.code.slice(LINK_PREFIX.length + 1, -1));
		this.byCode.set(code.code, this.urls.length - 1);
		return this.urls.length - 1;
	}

	open(id: number, terminator: string): string {
		const url = this.urls[id]!;
		return `${LINK_PREFIX}id=${hyperlinkId(url)};${url}${terminator}`;
	}

	close(terminator: string): string {
		return `${LINK_PREFIX};${terminator}`;
	}
}

export const stylePool = new StylePool();
export const hyperlinkPool = new HyperlinkPool();
