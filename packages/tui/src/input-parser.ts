// sid-code（B9 / T5.1b，契约 I8）：把 stdin 字节切成输入单元。
//
// 与上游的差异（规则来自 `tests/fixtures/input-vectors.json`，见设计文档 D-5）：
// - 一段连续的普通字符：单个码位按按键解码，多于一个整段原样交出（`ab`、`\r\n`、`a\x7f` 都是一个事件），
//   上游会把 DEL / BS 拆成单独事件；
// - CSI 按 ECMA-48 切：参数 / 中间字节之后第一个 0x40–0x7E 就是终止符（`ESC [ [` 就是一个完整序列），
//   中途遇到 ESC 在 ESC 之前切断，遇到其它非法字节则吞到下一个 ESC 为止；
// - `ESC [ M` 之后再取 3 个字节（X10 鼠标），不够就等；
// - `ESC ESC`：第一个 ESC 单独成键，第二个重新开始解析；
// - bracketed paste 的内容与多字符文本一样，原样交出（`{text}` / `{paste}`），不经按键解码。

const escape = '\u001B';
const pasteStart = '\u001B[200~';
const pasteEnd = '\u001B[201~';

/** 字符串 = 交给按键解码的单元；`{text}` = 原样文本；`{paste}` = bracketed paste 内容 */
export type InputEvent =
	| string
	| {readonly text: string}
	| {readonly paste: string};

type ParsedInput = {
	readonly events: InputEvent[];
	readonly pending: string;
};

type ParsedSequence =
	| {
			readonly sequence: string;
			readonly nextIndex: number;
	  }
	| 'pending';

const isCsiParameterByte = (byte: number): boolean =>
	byte >= 0x30 && byte <= 0x3f;

const isCsiIntermediateByte = (byte: number): boolean =>
	byte >= 0x20 && byte <= 0x2f;

const isFinalByte = (byte: number): boolean => byte >= 0x40 && byte <= 0x7e;

const untilNextEscape = (input: string, startIndex: number, from: number) => {
	const end = input.indexOf(escape, from);
	const nextIndex = end === -1 ? input.length : end;
	return {sequence: input.slice(startIndex, nextIndex), nextIndex};
};

const parseCsiSequence = (
	input: string,
	startIndex: number,
): ParsedSequence => {
	for (let index = startIndex + 2; index < input.length; index++) {
		const byte = input.charCodeAt(index);
		if (isCsiParameterByte(byte) || isCsiIntermediateByte(byte)) continue;

		if (isFinalByte(byte)) {
			const sequence = input.slice(startIndex, index + 1);
			if (sequence !== '\u001B[M') return {sequence, nextIndex: index + 1};
			// X10 鼠标：终止符后面紧跟按键 / 列 / 行三个字节
			const nextIndex = index + 4;
			if (nextIndex > input.length) return 'pending';
			return {sequence: input.slice(startIndex, nextIndex), nextIndex};
		}

		if (input[index] === escape) {
			return {sequence: input.slice(startIndex, index), nextIndex: index};
		}

		return untilNextEscape(input, startIndex, index);
	}

	return 'pending';
};

const parseSs3Sequence = (
	input: string,
	startIndex: number,
): ParsedSequence | undefined => {
	for (let index = startIndex + 2; index < input.length; index++) {
		const byte = input.charCodeAt(index);
		if (byte >= 0x30 && byte <= 0x39) continue;
		if (isFinalByte(byte)) {
			return {sequence: input.slice(startIndex, index + 1), nextIndex: index + 1};
		}

		return undefined;
	}

	return 'pending';
};

const parseEscapeSequence = (
	input: string,
	escapeIndex: number,
): ParsedSequence => {
	if (escapeIndex === input.length - 1) return 'pending';

	const next = input[escapeIndex + 1]!;
	if (next === escape) {
		return {sequence: escape, nextIndex: escapeIndex + 1};
	}

	if (next === '[') return parseCsiSequence(input, escapeIndex);

	if (next === 'O') {
		const ss3 = parseSs3Sequence(input, escapeIndex);
		if (ss3) return ss3;
	}

	// ESC + 一个码位（Alt 组合）
	const codePoint = input.codePointAt(escapeIndex + 1)!;
	const nextIndex = escapeIndex + 1 + (codePoint > 0xff_ff ? 2 : 1);
	return {sequence: input.slice(escapeIndex, nextIndex), nextIndex};
};

const pushText = (text: string, events: InputEvent[]): void => {
	if (text.length === 0) return;
	const codePoint = text.codePointAt(0)!;
	const single = text.length === (codePoint > 0xff_ff ? 2 : 1);
	events.push(single ? text : {text});
};

const parseKeypresses = (input: string): ParsedInput => {
	const events: InputEvent[] = [];
	let index = 0;
	const pendingFrom = (pendingStartIndex: number): ParsedInput => ({
		events,
		pending: input.slice(pendingStartIndex),
	});

	while (index < input.length) {
		const escapeIndex = input.indexOf(escape, index);
		if (escapeIndex === -1) {
			pushText(input.slice(index), events);
			return {events, pending: ''};
		}

		pushText(input.slice(index, escapeIndex), events);

		const parsedEscapeSequence = parseEscapeSequence(input, escapeIndex);
		if (parsedEscapeSequence === 'pending') {
			return pendingFrom(escapeIndex);
		}

		if (parsedEscapeSequence.sequence === pasteStart) {
			const afterStart = parsedEscapeSequence.nextIndex;
			const endIndex = input.indexOf(pasteEnd, afterStart);
			if (endIndex === -1) {
				return pendingFrom(escapeIndex);
			}

			events.push({paste: input.slice(afterStart, endIndex)});
			index = endIndex + pasteEnd.length;
			continue;
		}

		events.push(parsedEscapeSequence.sequence);
		index = parsedEscapeSequence.nextIndex;
	}

	return {events, pending: ''};
};

export type InputParser = {
	push: (chunk: string) => InputEvent[];
	hasPendingEscape: () => boolean;
	flushPendingEscape: () => string | undefined;
	reset: () => void;
};

export const createInputParser = (): InputParser => {
	let pending = '';

	return {
		push(chunk) {
			const parsedInput = parseKeypresses(pending + chunk);
			pending = parsedInput.pending;
			return parsedInput.events;
		},
		hasPendingEscape() {
			// 粘贴没结束（或开始标记还没收齐）时不冲刷：等结束标记，期间的输入都算粘贴内容
			return (
				pending.startsWith(escape) &&
				!pending.startsWith(pasteStart) &&
				pending !== '\u001B[200'
			);
		},
		flushPendingEscape() {
			if (!pending.startsWith(escape)) {
				return undefined;
			}

			const pendingEscape = pending;
			pending = '';
			return pendingEscape;
		},
		reset() {
			pending = '';
		},
	};
};
