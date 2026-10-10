/**
 * 选区引擎纯逻辑（B9 / T6.2a，契约 M2）：拖选、双击选词、三击选行、取选中文本与高亮单元。
 *
 * 不读写终端、不持有定时器：鼠标事件（含时间戳）由调用方喂进来，屏幕缓冲由调用方传进来。
 * 规则全部来自对旧底座的黑盒探针（D-5，没读旧代码），每条下面注明探针用例名，
 * 期望值入库在 `tests/fixtures/selection-vectors.json`。
 *
 * 坐标一律 0 起、屏幕单元坐标。锚点 / 焦点**不夹到屏幕内**：旧底座拖到屏幕外（上方、下方、左右）时，
 * 复制出的文本按真实行数带空行（`drag-ybig` 29 行、`drag-y0` 首行为空），只有高亮被屏幕裁掉。
 *
 * 选区是屏幕坐标，不跟内容：重渲染后同一位置换了内容，复制出的就是新内容（`scroll-down-1`、
 * `content-change`）。旧底座另有 ScrollBox 滚动时的选区跟随，但 CLI 不用 ScrollBox、端口不提供
 * scrollTop（L3），滚动靠 spacer / 负 marginTop 即普通重渲染，所以这条在端口表面上不存在（T6.2c 判定）。
 */
import {CellWidth, type Screen} from './screen/screen.js';

/** 两次按下算连击的时间上限（毫秒，右开）：495ms 连上、505ms 断开（`dt-495` / `dt-505`） */
export const MULTI_CLICK_MS = 500;
/** 两次按下算连击的位置容差：横纵各 ±1 格，与上一次**按下**比（`dbl-tol-diag`、`tpl-tol2`） */
export const MULTI_CLICK_DISTANCE = 1;

export type SelectionMode = 'char' | 'word' | 'line';

export type Point = {x: number; y: number};

export type MouseAction = 'press' | 'drag' | 'release';

export type SelectionEvent = {action: MouseAction; x: number; y: number; time: number};

/** 一行里被高亮的单元（含两端，已裁到屏幕内） */
export type HighlightSpan = {y: number; x0: number; x1: number};

type Range = {start: Point; end: Point};

export type SelectionState = {
	mode: SelectionMode;
	/** 左键按住中（按下之后、松开之前） */
	pressed: boolean;
	/** 选区是否成立。字符模式按下后要等焦点离开锚点格才成立（`drag-zero-move`） */
	active: boolean;
	/** 字符模式的锚点格；词 / 行模式的锚点是 `anchorRange` */
	anchor: Point;
	anchorRange: Range | undefined;
	focus: Point;
	focusRange: Range | undefined;
	lastPress: {x: number; y: number; time: number} | undefined;
	clickCount: number;
};

export function createSelectionState(): SelectionState {
	return {
		mode: 'char',
		pressed: false,
		active: false,
		anchor: {x: 0, y: 0},
		anchorRange: undefined,
		focus: {x: 0, y: 0},
		focusRange: undefined,
		lastPress: undefined,
		clickCount: 0,
	};
}

/** 清掉选区，保留连击计数（`clear-then`；计数只由按下的时间与位置决定） */
export function clearSelection(state: SelectionState): void {
	state.active = false;
	state.pressed = false;
	state.anchorRange = undefined;
	state.focusRange = undefined;
}

export function hasSelection(state: SelectionState): boolean {
	return state.active;
}

const inScreen = (screen: Screen, x: number, y: number): boolean =>
	x >= 0 && y >= 0 && x < screen.width && y < screen.height;

const before = (a: Point, b: Point): boolean => a.y < b.y || (a.y === b.y && a.x < b.x);

// ── 词边界 ─────────────────────────────────────────────────────────────────
//
// 三类：空白、词字符、其余（标点 / 符号 / emoji）。同类相邻连成一个词，空白只和**同一个**空白字符连
// （NBSP、全角空格各自成段：`adj-nbsp-space`、`adj-ideo-space`；tab 展开成普通空格单元，`w4-3`）。
// 词字符：字母、数字、组合符号，加上 `_ - . / ~ + \`（`a.b_c`、`--c--`、`//e//`、`~a`、`d+e`、`m\n`）；
// CJK 表意文字、假名、谚文、全角字母数字、`ー` `々` 都是字母类（`中文abc中`、`ひらがなカタカナ`）。
// 标点不分具体字符，`!?!?`、`(@)`、`。!`、`!😀!` 各连成一段；`:` `'` `$` `@` 都是标点（`path/to/file.ts:12`
// 双击得 `path/to/file.ts`）。

const WORD_RE = /^[\p{L}\p{N}\p{M}_\-./~+\\]/u;
const SPACE_RE = /^\s/u;

function charClass(value: string): string {
	if (value === '' || value === ' ') return 'ws: ';
	if (SPACE_RE.test(value)) return `ws:${value}`;
	if (WORD_RE.test(value)) return 'word';
	return 'punct';
}

/** 单元所属簇的起点列（spacer 归它左边的宽字符） */
function headX(screen: Screen, x: number, y: number): number {
	if (x > 0 && screen.widths[screen.index(x, y)] === CellWidth.Spacer) return x - 1;
	return x;
}

/** 簇的最后一个单元（宽字符含 spacer） */
function tailX(screen: Screen, x: number, y: number): number {
	if (x + 1 < screen.width && screen.widths[screen.index(x, y)] === CellWidth.Wide) return x + 1;
	return x;
}

/** (x, y) 所在的词；屏幕外返回 undefined */
export function wordRangeAt(screen: Screen, x: number, y: number): Range | undefined {
	if (!inScreen(screen, x, y)) return undefined;
	const head = headX(screen, x, y);
	const cls = charClass(screen.charAt(screen.index(head, y)));
	let left = head;
	while (left > 0) {
		const prev = headX(screen, left - 1, y);
		if (charClass(screen.charAt(screen.index(prev, y))) !== cls) break;
		left = prev;
	}

	let right = tailX(screen, head, y);
	while (right + 1 < screen.width) {
		const next = right + 1;
		if (charClass(screen.charAt(screen.index(next, y))) !== cls) break;
		right = tailX(screen, next, y);
	}

	return {start: {x: left, y}, end: {x: right, y}};
}

function lineRangeAt(screen: Screen, y: number): Range {
	return {start: {x: 0, y}, end: {x: screen.width - 1, y}};
}

// ── 事件 ───────────────────────────────────────────────────────────────────

/**
 * 喂一个左键事件。中键 / 右键 / 无键移动 / 滚轮由调用方过滤掉，不进这里
 * （它们既不建选区也不清选区：`right-after-sel`、`middle-after-sel`、`wheel-during`）。
 * 修饰键不影响（`shift-drag`、`alt-press`、`ctrl-press`）。
 */
export function applySelectionEvent(
	state: SelectionState,
	screen: Screen,
	event: SelectionEvent,
): void {
	const {x, y} = event;
	if (event.action === 'press') {
		const last = state.lastPress;
		const chained =
			last !== undefined &&
			event.time - last.time < MULTI_CLICK_MS &&
			Math.abs(x - last.x) <= MULTI_CLICK_DISTANCE &&
			Math.abs(y - last.y) <= MULTI_CLICK_DISTANCE;
		// 拖动不打断连击（`drag-cancels-count`：单击、按下拖动、再单击 = 三击）
		state.clickCount = chained ? state.clickCount + 1 : 1;
		state.lastPress = {x, y, time: event.time};
		state.pressed = true;
		state.anchorRange = undefined;
		state.focusRange = undefined;
		state.anchor = {x, y};
		state.focus = {x, y};

		if (state.clickCount === 1) {
			// 单击当场清掉旧选区（`new-press-clears`）；选区要等拖离锚点格才成立
			state.mode = 'char';
			state.active = false;
			return;
		}

		// 四击、五击仍是选行（`quad`、`five`、`six`）
		state.mode = state.clickCount === 2 ? 'word' : 'line';
		// 屏幕外的双击 / 三击什么都不选（`dbl-at-y11`、`dbl-x-beyond`、`tpl-y-beyond`）
		if (!inScreen(screen, x, y)) {
			state.active = false;
			return;
		}

		state.anchorRange = state.mode === 'word' ? wordRangeAt(screen, x, y) : lineRangeAt(screen, y);
		state.focusRange = state.anchorRange;
		state.active = true;
		return;
	}

	if (event.action === 'release') {
		// 松开的坐标不算数（`release-elsewhere`），选区保留
		state.pressed = false;
		return;
	}

	// drag：松开之后的拖动事件不延伸选区（`drag-after-release`）
	if (!state.pressed) return;
	state.focus = {x, y};

	if (state.mode === 'char') {
		// 没离开过锚点格之前，停在锚点格的拖动不建选区（`drag-zero-move`）；离开过再回来就选中锚点这一格
		// （`drag-then-back-to-start`）
		if (!state.active && x === state.anchor.x && y === state.anchor.y) return;
		state.active = true;
		return;
	}

	if (!state.anchorRange) return;
	if (state.mode === 'word') {
		// 焦点在屏幕外时就是那一格本身（`dbl-drag-y0`、`dbl-drag-oob`）
		state.focusRange = wordRangeAt(screen, x, y) ?? {start: {x, y}, end: {x, y}};
		return;
	}

	// 选行时焦点行夹到屏幕内（`tpl-drag-oob` 只到最后一行，对比选词的 `dbl-drag-oob` 带出屏外的空行）
	const row = Math.min(Math.max(y, 0), screen.height - 1);
	state.focusRange = lineRangeAt(screen, row);
}

// ── 读出 ───────────────────────────────────────────────────────────────────

/** 选区的首尾单元（含两端）；没有选区返回 undefined */
export function selectionRange(state: SelectionState, screen: Screen): Range | undefined {
	if (!state.active) return undefined;

	if (state.mode === 'char') {
		const [a, b] = before(state.focus, state.anchor)
			? [state.focus, state.anchor]
			: [state.anchor, state.focus];
		const start = {...a};
		const end = {...b};
		// 起点落在宽字符右半格 → 不含这个字，从下一格开始；终点落在宽字符左半格 → 含整个字
		// （`wide-back`、`drag-wide-right-cells`、`wide-end-left`、`drag-to-left-of-wide`）
		if (inScreen(screen, start.x, start.y) && screen.widths[screen.index(start.x, start.y)] === CellWidth.Spacer) {
			start.x += 1;
		}

		if (inScreen(screen, end.x, end.y) && screen.widths[screen.index(end.x, end.y)] === CellWidth.Wide) {
			end.x += 1;
		}

		return {start, end};
	}

	const anchor = state.anchorRange!;
	const focus = state.focusRange ?? anchor;
	// 往回拖保留锚点词 / 行的尾端，往后拖保留它的首端（`dbl-drag-back`、`tpl-drag-up`）
	return before(focus.start, anchor.start)
		? {start: focus.start, end: anchor.end}
		: {start: anchor.start, end: focus.end};
}

/** 高亮单元：首行从起点到行尾、中间整行、末行从行首到终点，裁到屏幕内 */
export function selectionHighlight(state: SelectionState, screen: Screen): HighlightSpan[] {
	const range = selectionRange(state, screen);
	if (!range) return [];
	const spans: HighlightSpan[] = [];
	const lastX = screen.width - 1;
	for (let y = Math.max(range.start.y, 0); y <= Math.min(range.end.y, screen.height - 1); y++) {
		const x0 = Math.max(y === range.start.y ? range.start.x : 0, 0);
		const x1 = Math.min(y === range.end.y ? range.end.x : lastX, lastX);
		if (x0 <= x1) spans.push({y, x0, x1});
	}

	return spans;
}

/**
 * 选中文本。每行取选中的单元拼起来：
 * - 硬换行（或没有文本）的行去掉行尾空白，行与行之间用 `\n`（`trailing-spaces`、`dbl-drag-space`、`border`）；
 * - 软换行的行只取到它的内容结束列、不去空白，与下一行直接拼接
 *   （`drag-wrap-3`、`sw-multispace`、`sw12-0-11`、`two-cols`，见 `Screen.wrapEnd`）；
 * - 屏幕外的行是空行（`drag-ybig`）。
 */
export function selectionText(state: SelectionState, screen: Screen): string {
	const range = selectionRange(state, screen);
	if (!range) return '';
	let text = '';
	for (let y = range.start.y; y <= range.end.y; y++) {
		const inRows = y >= 0 && y < screen.height;
		const wrapEnd = inRows ? screen.wrapEnd[y]! : -1;
		const soft = wrapEnd >= 0;
		let x0 = Math.max(y === range.start.y ? range.start.x : 0, 0);
		let x1 = Math.min(y === range.end.y ? range.end.x : screen.width - 1, screen.width - 1);
		if (soft) x1 = Math.min(x1, wrapEnd - 1);
		let segment = '';
		if (inRows) {
			for (let x = x0; x <= x1; x++) segment += screen.charAt(screen.index(x, y));
		}

		if (soft) {
			text += segment;
			continue;
		}

		text += segment.trimEnd();
		if (y < range.end.y) text += '\n';
		x0 = 0;
	}

	return text;
}

// ── 鼠标字节 ───────────────────────────────────────────────────────────────

const SGR_MOUSE_RE = /^\u001B\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * 把一条 SGR 鼠标序列翻成左键选区事件；不是左键（中 / 右键、无键移动、滚轮）或不是 SGR 返回 undefined。
 * X10 编码不认（`x10-drag`：旧底座同样不建选区）。坐标转成 0 起，可以是 -1（终端报 0 时，`drag-y0`）。
 */
export function decodeSelectionMouse(
	sequence: string,
	time: number,
): SelectionEvent | undefined {
	const m = SGR_MOUSE_RE.exec(sequence);
	if (!m) return undefined;
	const button = Number(m[1]);
	if (button & 64) return undefined; // 滚轮
	if ((button & 3) !== 0) return undefined; // 中键 / 右键 / 无键移动（35）
	const x = Number(m[2]) - 1;
	const y = Number(m[3]) - 1;
	if (m[4] === 'm') return {action: 'release', x, y, time};
	return {action: button & 32 ? 'drag' : 'press', x, y, time};
}
