/**
 * alt-screen 帧 diff（B9 / T6.1a，契约 R14）。纯函数，不碰流：同步包裹、隐藏光标由 ink.tsx 负责。
 *
 * 和主屏（main-screen.ts）的根本区别：alt-screen 没有 scrollback，所以用**绝对定位**——
 * 每帧从 `ESC[H` 出发，写完把光标停到视口最后一行行首（`ESC[{rows};1H`）。规则全部来自黑盒对拍旧底座：
 * - 只画视口内的行（超出视口的内容直接丢，不进 scrollback）；
 * - 前一帧缺省时按「对一块全空白屏」做 diff：默认空白不写，样式不同的空格照写；
 * - 第一个变化在第 0 行就直接从原点往右（`CUF`）；换行用 `\r` + `CUF(x)` + `CUD(dy)`；
 *   行内没变的单元用 `CUF` 跳过；所有变化段共用一支笔，最后才收笔（与主屏 diff 同一套写法）；
 * - 没有任何变化 → 一个字节都不写（连 `ESC[H` 都没有）；
 * - 视口变了（变宽、变窄、变高、变矮都算）→ 前面加 `ESC[2J`，整帧对空白重画。
 */
import {closePen, type Pen, serializeRowDiff} from '../screen/serialize.js';
import {CellWidth, Screen} from '../screen/screen.js';

const ESC = '\u001B';

const cursorDown = (n: number) => (n > 0 ? `${ESC}[${n}B` : '');
const cursorForward = (n: number) => (n > 0 ? `${ESC}[${n}C` : '');

function rowChanged(previous: Screen, next: Screen, y: number): number {
	const base = next.index(0, y);
	for (let x = 0, i = base; x < next.width; x++, i++) {
		if (
			previous.chars[i] !== next.chars[i] ||
			previous.styles[i] !== next.styles[i] ||
			previous.widths[i] !== next.widths[i] ||
			previous.links[i] !== next.links[i]
		) {
			return x;
		}
	}

	return -1;
}

/** 把一帧裁到视口高度（只留前 rows 行）；高度不超过视口时原样返回。 */
export function clipToViewport(screen: Screen, rows: number): Screen {
	if (screen.height <= rows) {
		return screen;
	}

	const clipped = new Screen(screen.width, rows, {
		styles: screen.stylePool,
		links: screen.hyperlinkPool,
	});
	const size = screen.width * rows;
	clipped.chars.set(screen.chars.subarray(0, size));
	clipped.widths.set(screen.widths.subarray(0, size));
	clipped.styles.set(screen.styles.subarray(0, size));
	clipped.links.set(screen.links.subarray(0, size));
	clipped.wrapEnd.set(screen.wrapEnd.subarray(0, rows));
	return clipped;
}

/**
 * 把一帧补到视口高度（多出来的行是默认空白）；已经够高时原样返回。
 * 选区用（B9 / T6.2b）：旧底座的 alt 屏幕恒为整个视口高，拖到内容以下的空行照样高亮（探针 m15 `below`）。
 */
export function padToViewport(screen: Screen, rows: number): Screen {
	if (screen.height >= rows) {
		return screen;
	}

	const padded = blankLike(new Screen(screen.width, rows, {
		styles: screen.stylePool,
		links: screen.hyperlinkPool,
	}));
	const size = screen.width * screen.height;
	padded.chars.set(screen.chars.subarray(0, size));
	padded.widths.set(screen.widths.subarray(0, size));
	padded.styles.set(screen.styles.subarray(0, size));
	padded.links.set(screen.links.subarray(0, size));
	padded.wrapEnd.set(screen.wrapEnd);
	return padded;
}

/** 同尺寸的全空白屏（前一帧缺省时的比较对象），与 next 共用样式池 / 链接池。 */
function blankLike(next: Screen): Screen {
	const blank = new Screen(next.width, next.height, {
		styles: next.stylePool,
		links: next.hyperlinkPool,
	});
	blank.widths.fill(CellWidth.Narrow);
	return blank;
}

/**
 * @param previous 上一帧（已裁到视口）；缺省 = 屏幕已被擦成空白（刚进 alt、SIGCONT、视口变化）
 * @param next 这一帧（已裁到视口）
 * @param viewportRows 视口行数，决定收尾时光标停在哪一行
 * @param erase 是否先擦屏（视口变化时由调用方判定）
 */
export function diffAltScreen(
	previous: Screen | undefined,
	next: Screen,
	viewportRows: number,
	erase = false,
): string {
	const base =
		previous &&
		previous.width === next.width &&
		previous.height === next.height
			? previous
			: blankLike(next);
	// 高度不同（内容变高 / 变矮）时按行比较：新帧多出来的行对空白比，少掉的行要写空格盖掉
	const prev = previous && previous !== base ? resize(previous, next) : base;

	let out = '';
	let cx = 0;
	let cy = 0;
	const pen: Pen = {style: 0, link: 0};
	for (let y = 0; y < next.height; y++) {
		const x = rowChanged(prev, next, y);
		if (x < 0) {
			continue;
		}

		if (y === cy) {
			out += cursorForward(x - cx);
		} else {
			out += '\r' + cursorForward(x) + cursorDown(y - cy);
		}

		out += serializeRowDiff(prev, next, y, x, undefined, pen);
		cy = y;
		cx = next.width;
	}

	if (out === '') {
		return erase ? `${ESC}[2J${ESC}[H${ESC}[${viewportRows};1H` : '';
	}

	out += closePen(next, pen);
	return (erase ? `${ESC}[2J` : '') + `${ESC}[H` + out + `${ESC}[${viewportRows};1H`;
}

/** 把上一帧补齐 / 截到和新帧同高（宽度不同的情况调用方已当作「前一帧缺省」处理）。 */
function resize(previous: Screen, next: Screen): Screen {
	if (previous.width !== next.width) {
		return blankLike(next);
	}

	const out = blankLike(next);
	const size = next.width * Math.min(previous.height, next.height);
	out.chars.set(previous.chars.subarray(0, size));
	out.widths.set(previous.widths.subarray(0, size));
	out.styles.set(previous.styles.subarray(0, size));
	out.links.set(previous.links.subarray(0, size));
	return out;
}
