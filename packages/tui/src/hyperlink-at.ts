/**
 * 超链接命中（B9 / T6.2b，契约 M4）：屏幕上 (x, y) 这一格对应的 url。
 *
 * 规则全部来自对旧底座 `getHyperlinkAt` 的黑盒探针（D-5，没读旧代码），探针结果备份在
 * `~/Backups/sid-code-t67-probe-results-20261008/T6.2b/`（m11–m14）：
 * - 先看这一格的 OSC 8 链接。宽字符右半格也命中（`wide-tail`）：`Screen.putId` 写宽字符时
 *   spacer 格带着同一个链接 id，所以不用像旧底座那样回头看左半格。
 * - 没有就在这一行里找纯文本 url（开了鼠标跟踪后终端自己的 Cmd+点击识别不再生效，所以底座补上）：
 *   - 只认小写的 `http://`、`https://`、`file://`（`ftp`、`mailto:`、`www.`、`HTTPS://` 都不认）；
 *     前面不要求词边界（`xhttps://a.test/a` 从第 1 列起算）；只有 scheme 也算（`http://`）。
 *   - 正文是 ASCII 可打印字符，遇到空白、`"` `'` `<` `>` `` ` ``、非 ASCII（含 CJK）就结束。
 *   - 尾部反复去掉 `. , ; : ! ?`，以及数量多于对应开括号的 `)` `]` `}`（`(a))` → `(a)`、`a)b)` → `a)b`）。
 * - 坐标在屏幕外返回 undefined。
 */
import type {Screen} from './screen/screen.js';

const URL_RE = /(?:https?|file):\/\/[!#-&(-;=?-_a-~]*/g;
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?']);
const PAIRS: Record<string, string> = {')': '(', ']': '[', '}': '{'};

const count = (s: string, ch: string): number => s.split(ch).length - 1;

function trimUrl(url: string): string {
	let out = url;
	for (;;) {
		const last = out.at(-1);
		if (last === undefined) return out;
		if (TRAILING_PUNCT.has(last)) {
			out = out.slice(0, -1);
			continue;
		}

		const open = PAIRS[last];
		if (open !== undefined && count(out, last) > count(out, open)) {
			out = out.slice(0, -1);
			continue;
		}

		return out;
	}
}

/** 这一行的文本，一格一个字符：非 ASCII（含宽字符两半格）一律换成 NUL，让下标等于列号且截断 url */
function rowText(screen: Screen, y: number): string {
	let text = '';
	for (let x = 0; x < screen.width; x++) {
		const ch = screen.charAt(screen.index(x, y));
		text += ch.length === 1 && ch.charCodeAt(0) < 0x80 ? ch : '\0';
	}

	return text;
}

export function plainTextUrlAt(screen: Screen, x: number, y: number): string | undefined {
	const text = rowText(screen, y);
	for (const m of text.matchAll(URL_RE)) {
		const url = trimUrl(m[0]);
		if (x >= m.index && x < m.index + url.length) return url;
	}

	return undefined;
}

export function hyperlinkAt(screen: Screen, x: number, y: number): string | undefined {
	if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined;
	const id = screen.links[screen.index(x, y)]!;
	return screen.hyperlinkPool.urlOf(id) ?? plainTextUrlAt(screen, x, y);
}
