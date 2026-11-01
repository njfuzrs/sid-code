// sid-code（B9 / T3.1）：输出落到 cell 级屏幕缓冲（screen/），见 UPSTREAM-DIFF.md
import {sliceColumns} from './text/slice.js';
import {stringWidth} from './text/width.js';
import {Screen} from './screen/screen.js';
import {screenToString} from './screen/serialize.js';
import {type OutputTransformer} from './render-node-to-output.js';

/**
"Virtual" output class

Handles the positioning and saving of the output of each node in the tree. Also responsible for applying transformations to each character of the output.

Used to generate the final output of all nodes before writing it to actual output stream (e.g. stdout)
*/

type Options = {
	width: number;
	height: number;
};

export type Operation = WriteOperation | ClipOperation | UnclipOperation;

type WriteOperation = {
	type: 'write';
	x: number;
	y: number;
	text: string;
	transformers: OutputTransformer[];
	/** 第 i 行是否被自动换行折断（B9 / T6.2a，见 Screen.wrapEnd）；缺省 = 全是硬换行 */
	softWraps?: boolean[];
};

type ClipOperation = {
	type: 'clip';
	clip: Clip;
};

type Clip = {
	x1: number | undefined;
	x2: number | undefined;
	y1: number | undefined;
	y2: number | undefined;
};

type UnclipOperation = {
	type: 'unclip';
};

/**
 * sid-code（长会话按键延迟 PR3）：跨帧复用屏幕行的状态，由调用方（renderer，按根节点）持有。
 * `rows[y]` 是上一帧写到第 y 行的「(写操作 id, 当时栈顶裁剪框 id)」序列。
 */
export type ScreenReuse = {
	screen?: Screen;
	rows?: Array<number[] | undefined>;
};

/**
 * 写操作 / 裁剪框 → 稳定 id。blit 缓存 replay 且 `dy === 0` 时推进来的是**同一个对象**（见 `replay`），
 * 所以对象身份相同 = 文本、坐标、transformers、裁剪框全部相同。WeakMap：节点重渲后旧操作随缓存一起回收。
 */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function objectId(value: object): number {
	let id = objectIds.get(value);
	if (id === undefined) {
		id = nextObjectId++;
		objectIds.set(value, id);
	}

	return id;
}

const lineCounts = new WeakMap<WriteOperation, number>();
function lineCount(operation: WriteOperation): number {
	let count = lineCounts.get(operation);
	if (count === undefined) {
		count = 1;
		for (let i = operation.text.indexOf('\n'); i !== -1; i = operation.text.indexOf('\n', i + 1)) {
			count++;
		}

		lineCounts.set(operation, count);
	}

	return count;
}

function sameSequence(a: number[] | undefined, b: number[] | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}

	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
}

/** 测试 / 探针用：上一次带 reuse 的 getScreen 复用了多少行、重写了多少行 */
export const screenReuseStats = {reused: 0, written: 0};

class OutputCaches {
	widths = new Map<string, number>();
	blockWidths = new Map<string, number>();
	getStringWidth(text: string): number {
		let cached = this.widths.get(text);
		if (cached === undefined) {
			cached = stringWidth(text);
			this.widths.set(text, cached);
		}

		return cached;
	}

	getWidestLine(text: string): number {
		let cached = this.blockWidths.get(text);
		if (cached === undefined) {
			let lineWidth = 0;
			for (const line of text.split('\n')) {
				lineWidth = Math.max(lineWidth, this.getStringWidth(line));
			}

			cached = lineWidth;
			this.blockWidths.set(text, cached);
		}

		return cached;
	}
}

export default class Output {
	width: number;
	height: number;

	private readonly operations: Operation[] = [];
	private readonly caches: OutputCaches = new OutputCaches();

	constructor(options: Options) {
		const {width, height} = options;

		this.width = width;
		this.height = height;
	}

	write(
		x: number,
		y: number,
		text: string,
		options: {transformers: OutputTransformer[]; softWraps?: boolean[]},
	): void {
		const {transformers, softWraps} = options;

		if (!text) {
			return;
		}

		this.operations.push({
			type: 'write',
			x,
			y,
			text,
			transformers,
			...(softWraps?.includes(true) ? {softWraps} : {}),
		});
	}

	clip(clip: Clip) {
		this.operations.push({
			type: 'clip',
			clip,
		});
	}

	unclip() {
		this.operations.push({
			type: 'unclip',
		});
	}

	/**
	 * sid-code（B9 / T3.4，契约 P3）：脏区缓存用的三个操作。`mark` 记下当前位置，`since` 取出之后追加的操作，
	 * `replay` 把一段缓存的操作原样追加，纵向平移 `dy` 行（横向不平移：tab 对齐的是屏幕绝对列）。
	 */
	mark(): number {
		return this.operations.length;
	}

	since(mark: number): Operation[] {
		return this.operations.slice(mark);
	}

	replay(operations: readonly Operation[], dy: number): void {
		if (dy === 0) {
			for (const operation of operations) {
				this.operations.push(operation);
			}

			return;
		}

		for (const operation of operations) {
			if (operation.type === 'write') {
				this.operations.push({...operation, y: operation.y + dy});
			} else if (operation.type === 'clip') {
				const {clip} = operation;
				this.operations.push({
					type: 'clip',
					clip: {
						...clip,
						y1: clip.y1 === undefined ? undefined : clip.y1 + dy,
						y2: clip.y2 === undefined ? undefined : clip.y2 + dy,
					},
				});
			} else {
				this.operations.push(operation);
			}
		}
	}

	get(screen: Screen = this.getScreen()): {output: string; height: number} {
		return {
			output: screenToString(screen),
			height: this.height,
		};
	}

	/**
	 * sid-code（B9 / T3.1）：操作序列落到 cell 级屏幕缓冲。上游在这里拼 `StyledChar[][]` 再转字符串；
	 * 这里落到 `Screen`，帧 diff（T3.2）直接比单元，`get()` 只是它的纯文本形态。
	 * 裁剪规则保持上游：先按列切文本、左边被裁时整段移到裁剪框左边界；右边界交给 Screen
	 * （压在边界上的宽字符整个丢掉，契约 T4）。
	 */
	getScreen(reuse?: ScreenReuse): Screen {
		const screen = new Screen(this.width, this.height);
		const clips: Clip[] = [];
		const reused = reuse ? this.reuseRows(screen, reuse) : undefined;

		for (const operation of this.operations) {
			if (operation.type === 'clip') {
				clips.push(operation.clip);
			}

			if (operation.type === 'unclip') {
				clips.pop();
			}

			if (operation.type === 'write') {
				const {text, transformers} = operation;
				let {x, y} = operation;
				let lines = text.split('\n');
				let softWraps = operation.softWraps;
				let maxX = screen.width;

				const clip = clips.at(-1);

				// 落点的每一行都已从上一帧整行拷过来：整个操作跳过（split / 裁剪 / transformer / tokenize 全省）
				if (reused) {
					const rows = lineCount(operation);
					let all = true;
					for (let row = Math.max(0, y); row < Math.min(screen.height, y + rows); row++) {
						if (!reused[row]) {
							all = false;
							break;
						}
					}

					if (all) {
						continue;
					}
				}

				if (clip) {
					const clipHorizontally =
						typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number';

					const clipVertically =
						typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number';

					// If text is positioned outside of clipping area altogether,
					// skip to the next operation to avoid unnecessary calculations
					if (clipHorizontally) {
						const width = this.caches.getWidestLine(text);

						if (x + width < clip.x1! || x > clip.x2!) {
							continue;
						}
					}

					if (clipVertically) {
						const height = lines.length;

						if (y + height < clip.y1! || y > clip.y2!) {
							continue;
						}
					}

					if (clipHorizontally) {
						lines = lines.map(line => {
							const from = x < clip.x1! ? clip.x1! - x : 0;
							const width = this.caches.getStringWidth(line);
							const to = x + width > clip.x2! ? clip.x2! - x : width;

							// sid-code：不裁就原样返回。工具标题行都包在 `overflow="hidden" height={1}` 里，
							// 每行都处在横向 clip 中但一列都不裁；sliceColumns 仍会整行 tokenize + 逐字符
							// stringWidth，长会话 blit replay 每帧上千行，实测占按键延迟一半以上（p50 46→19ms）。
							if (from === 0 && to >= width) return line;

							return sliceColumns(line, from, to);
						});

						if (x < clip.x1!) {
							x = clip.x1!;
						}

						maxX = Math.min(maxX, clip.x2!);
					}

					if (clipVertically) {
						const from = y < clip.y1! ? clip.y1! - y : 0;
						const height = lines.length;
						const to = y + height > clip.y2! ? clip.y2! - y : height;

						lines = lines.slice(from, to);
						softWraps = softWraps?.slice(from, to);

						if (y < clip.y1!) {
							y = clip.y1!;
						}
					}
				}

				for (let [index, line] of lines.entries()) {
					for (const transformer of transformers) {
						line = transformer(line, index);
					}

					const row = y + index;
					if (reused?.[row]) {
						continue;
					}

					const end = screen.writeLine(x, row, line, 0, maxX);
					// 只记软换行，硬换行的写入不清记录：并排两列时右列的硬换行文本写在同一行，
					// 基线复制左列折行时仍按左列拼接、不带右列（探针 `two-cols`）
					if (softWraps?.[index] && row >= 0 && row < screen.height) {
						screen.wrapEnd[row] = Math.min(end, maxX);
					}
				}
			}
		}

		return screen;
	}

	/**
	 * sid-code（长会话按键延迟 PR3）：视口之上的历史行复用上一帧的屏幕缓冲。
	 *
	 * 长会话每帧把整份历史（ce7：14,000 条操作 / 6,970 行）重新落进一块新缓冲，而按键只改输入框那几行。
	 * 一行的单元完全由「按顺序写到这一行的操作 + 每次写入时的栈顶裁剪框」决定（writeLine 只写本行，
	 * 宽字符劈半的清理也不跨行），所以这条序列与上一帧逐项相同的行，直接把上一帧那一行的四块 typed array
	 * 与 wrapEnd 拷过来，不再执行操作。
	 *
	 * 判据只认对象身份，不认内容：节点重渲 / 纵向平移（replay dy≠0）都会产生新对象，那些行一律重写。
	 * 按操作的全部行数登记（不扣纵向裁剪），多登记只会让判据更严，不会误判可复用。
	 * 前提：transformer 是纯函数（同一个函数对象对同一输入恒给同一输出）；Text 的样式 transformer 随重渲换新闭包。
	 *
	 * 不能改成按内容 hash 比：hash 碰撞 = scrollback 里某块历史静默不刷新，测试很难撞到。
	 */
	private reuseRows(screen: Screen, reuse: ScreenReuse): boolean[] | undefined {
		const rows: Array<number[] | undefined> = new Array(screen.height);
		const clips: Clip[] = [];
		for (const operation of this.operations) {
			if (operation.type === 'clip') {
				clips.push(operation.clip);
			} else if (operation.type === 'unclip') {
				clips.pop();
			} else {
				const id = objectId(operation);
				const clip = clips.at(-1);
				const clipId = clip ? objectId(clip) : 0;
				const end = Math.min(screen.height, operation.y + lineCount(operation));
				for (let row = Math.max(0, operation.y); row < end; row++) {
					(rows[row] ??= []).push(id, clipId);
				}
			}
		}

		const previous = reuse.screen;
		const previousRows = reuse.rows;
		reuse.screen = screen;
		reuse.rows = rows;
		screenReuseStats.reused = 0;
		screenReuseStats.written = 0;
		if (!previous || !previousRows || previous.width !== screen.width) {
			return undefined;
		}

		const width = screen.width;
		const reused: boolean[] = new Array(screen.height).fill(false);
		const limit = Math.min(screen.height, previous.height);
		for (let row = 0; row < screen.height; row++) {
			const sequence = rows[row];
			if (sequence === undefined) {
				continue;
			}

			if (row < limit && sameSequence(sequence, previousRows[row])) {
				const start = row * width;
				const stop = start + width;
				screen.chars.set(previous.chars.subarray(start, stop), start);
				screen.widths.set(previous.widths.subarray(start, stop), start);
				screen.styles.set(previous.styles.subarray(start, stop), start);
				screen.links.set(previous.links.subarray(start, stop), start);
				screen.wrapEnd[row] = previous.wrapEnd[row]!;
				reused[row] = true;
				screenReuseStats.reused++;
			} else {
				screenReuseStats.written++;
			}
		}

		return reused;
	}
}
