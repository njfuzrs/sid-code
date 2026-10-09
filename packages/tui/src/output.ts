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
	getScreen(): Screen {
		const screen = new Screen(this.width, this.height);
		const clips: Clip[] = [];

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

					const end = screen.writeLine(x, y + index, line, 0, maxX);
					const row = y + index;
					// 只记软换行，硬换行的写入不清记录：并排两列时右列的硬换行文本写在同一行，
					// 旧底座复制左列折行时仍按左列拼接、不带右列（探针 `two-cols`）
					if (softWraps?.[index] && row >= 0 && row < screen.height) {
						screen.wrapEnd[row] = Math.min(end, maxX);
					}
				}
			}
		}

		return screen;
	}
}
