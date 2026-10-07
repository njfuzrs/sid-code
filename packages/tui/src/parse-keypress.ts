// sid-code（B9 / T5.1b，契约 I8）：一个输入单元 → `useInput` 收到的 `(input, key)`。
//
// 上游这里是 enquirer 派生的解析器加 kitty 解析，key 的字段集合和取值都与旧底座不同。
// 这里按契约 I8 重写：规则全部来自 `tests/fixtures/input-vectors.json`（旧底座黑盒向量）和
// xterm ctlseqs / kitty keyboard protocol 公开文档，没有读旧底座代码（设计文档 D-5）。
// 分词（一串 stdin 字节切成哪些单元）在 `input-parser.ts`。

// 字段集合 = 向量里 key 的字段（按字母序，与 input-vectors.json 一致）
export type Key = {
	backspace: boolean;
	ctrl: boolean;
	delete: boolean;
	downArrow: boolean;
	end: boolean;
	escape: boolean;
	fn: boolean;
	home: boolean;
	leftArrow: boolean;
	meta: boolean;
	pageDown: boolean;
	pageUp: boolean;
	return: boolean;
	rightArrow: boolean;
	shift: boolean;
	super: boolean;
	tab: boolean;
	upArrow: boolean;
	wheelDown: boolean;
	wheelUp: boolean;
};

type KeyName = Exclude<
	keyof Key,
	'ctrl' | 'shift' | 'meta' | 'super' | 'fn'
>;

export type DecodedInput = {
	readonly input: string;
	readonly key: Key;
};

const escape = '\u001B';

export const emptyKey = (): Key => ({
	backspace: false,
	ctrl: false,
	delete: false,
	downArrow: false,
	end: false,
	escape: false,
	fn: false,
	home: false,
	leftArrow: false,
	meta: false,
	pageDown: false,
	pageUp: false,
	return: false,
	rightArrow: false,
	shift: false,
	super: false,
	tab: false,
	upArrow: false,
	wheelDown: false,
	wheelUp: false,
});

const make = (
	input: string,
	flags: Partial<Key> = {},
	name?: KeyName,
): DecodedInput => {
	const key = {...emptyKey(), ...flags};
	if (name) key[name] = true;
	return {input, key};
};

// 修饰参数 = 1 + 位掩码（xterm 与 kitty 同口径）。只认 shift / alt / ctrl / super 四位，
// alt 报成 meta；hyper / meta / capsLock / numLock 位忽略。参数 0 时掩码是 -1，四位全亮。
const modifiers = (parameter: number): Partial<Key> => {
	const bits = parameter - 1;
	return {
		shift: Boolean(bits & 1),
		meta: Boolean(bits & 2),
		ctrl: Boolean(bits & 4),
		super: Boolean(bits & 8),
	};
};

const merge = (a: Partial<Key>, b: Partial<Key>): Partial<Key> => {
	const out: Partial<Key> = {...a};
	for (const [k, v] of Object.entries(b) as Array<[keyof Key, boolean]>) {
		if (v) out[k] = true;
	}

	return out;
};

/** 单字节 / 单字符 */
const decodeCharacter = (s: string): DecodedInput => {
	const code = s.codePointAt(0)!;
	if (s.length === 1 && code < 0x20) {
		if (s === '\r') return make('', {}, 'return');
		if (s === '\t') return make('', {}, 'tab');
		if (s === '\b') return make('', {}, 'backspace');
		if (s === '\n') return make('\n');
		if (s === escape) return make('', {meta: true}, 'escape');
		if (code === 0) return make('`', {ctrl: true});
		if (code === 0x1f) return make('_', {ctrl: true});
		if (code >= 0x1c) return make(s);
		return make(String.fromCharCode(code + 0x60), {ctrl: true});
	}

	if (s === '\u007F') return make('', {}, 'backspace');
	return make(s, {shift: s.length === 1 && s >= 'A' && s <= 'Z'});
};

/** ESC + 一个字符（Alt 组合） */
const decodeMeta = (c: string): DecodedInput | undefined => {
	if (c === '\\') return undefined; // ST 单独到达：丢弃
	if (c === '\b' || c === '\u007F') return make('', {meta: true}, 'backspace');
	if (c.length === 1 && c < ' ') return make(c);
	if (c === ' ' || (c >= '0' && c <= '9')) return make(c, {meta: true});
	if (c === 'b') return make('', {meta: true}, 'leftArrow');
	if (c === 'f') return make('', {meta: true}, 'rightArrow');
	if (c >= 'a' && c <= 'z') return make(c, {meta: true});
	if (c >= 'A' && c <= 'Z') return make(c, {meta: true, shift: true});
	return make(c);
};

// CSI 数字 ~ 的键名（数字不在表里的照样出事件，只是不带键名）
const tildeKeys: Record<number, KeyName> = {
	1: 'home',
	3: 'delete',
	4: 'end',
	5: 'pageUp',
	6: 'pageDown',
	7: 'home',
	8: 'end',
};

// CSI [1;m] 字母 的键名与附带修饰；小写 a–e 是 rxvt 的 Shift+方向
const letterKeys: Record<string, {name?: KeyName; flags?: Partial<Key>}> = {
	A: {name: 'upArrow'},
	B: {name: 'downArrow'},
	C: {name: 'rightArrow'},
	D: {name: 'leftArrow'},
	H: {name: 'home'},
	F: {name: 'end'},
	Z: {name: 'tab', flags: {shift: true}},
	a: {name: 'upArrow', flags: {shift: true}},
	b: {name: 'downArrow', flags: {shift: true}},
	c: {name: 'rightArrow', flags: {shift: true}},
	d: {name: 'leftArrow', flags: {shift: true}},
	e: {flags: {shift: true}},
};

// SS3 字母 → 键；j–y 是小键盘字符（final - 0x40）
const ss3Keys: Record<string, {name?: KeyName; flags?: Partial<Key>}> = {
	A: {name: 'upArrow'},
	B: {name: 'downArrow'},
	C: {name: 'rightArrow'},
	D: {name: 'leftArrow'},
	H: {name: 'home'},
	F: {name: 'end'},
	M: {name: 'return'},
	a: {name: 'upArrow', flags: {ctrl: true}},
	b: {name: 'downArrow', flags: {ctrl: true}},
	c: {name: 'rightArrow', flags: {ctrl: true}},
	d: {name: 'leftArrow', flags: {ctrl: true}},
	e: {flags: {ctrl: true}},
};

// kitty 私有区里只有这些小键盘码位产生字符（57414 kpenter 当回车）
const keypadText: Record<number, string> = {
	57409: '.',
	57410: '/',
	57411: '*',
	57412: '-',
	57413: '+',
	57415: '=',
};

/** kitty CSI u / xterm modifyOtherKeys：码位 + 修饰参数 */
const decodeCodepoint = (codepoint: number, parameter: number): DecodedInput => {
	const mods = modifiers(parameter);
	const named = (name: KeyName, text: string) =>
		make(mods.ctrl ? '' : text, mods, name);
	if (codepoint === 9) return named('tab', 'tab');
	if (codepoint === 13 || codepoint === 57414) return named('return', 'return');
	if (codepoint === 127) return named('backspace', 'backspace');
	if (codepoint === 27) return make('', {...mods, meta: true}, 'escape');
	if (codepoint >= 32 && codepoint <= 126) {
		return make(String.fromCharCode(codepoint).toLowerCase(), mods);
	}

	if (codepoint >= 57399 && codepoint <= 57408) {
		return make(String(codepoint - 57399), mods);
	}

	return make(keypadText[codepoint] ?? '', mods);
};

const sgrMouseRe = /^\u001B\[<(\d+);\d+;\d+[Mm]$/;
const csiTildeRe = /^\u001B\[(\d*)(?:;(\d+))?([~^$])$/;
const csiLetterRe = /^\u001B\[(?:1;)?(\d+)?([A-Za-z])$/;
const kittyRe = /^\u001B\[(\d+)(?:;(\d+))?u$/;
const modifyOtherKeysRe = /^\u001B\[27;(\d+);(\d+)~$/;
const ss3Re = /^\u001BO(\d*)(.)$/;

/** 鼠标按键字节：只有滚轮出事件（上 / 下），左右滚轮出空事件；其余按键由调用方决定丢弃还是出空事件 */
const wheel = (button: number): DecodedInput | 'other' => {
	if (!(button & 64)) return 'other';
	if ((button & 3) === 0) return make('', {}, 'wheelUp');
	if ((button & 3) === 1) return make('', {}, 'wheelDown');
	return make('');
};

/** CSI 序列（以 ESC [ 开头） */
const decodeCsi = (s: string): DecodedInput | undefined => {
	if (s === '\u001B[I' || s === '\u001B[O') return undefined; // 焦点报告

	if (s.startsWith('\u001B[M')) {
		// X10 鼠标：3 个字节不齐（被冲刷出来的半截）也出一个空事件
		if (s.length < 6) return make('');
		const decoded = wheel(s.charCodeAt(3) - 32);
		return decoded === 'other' ? make('') : decoded;
	}

	let m = sgrMouseRe.exec(s);
	if (m) {
		const decoded = wheel(Number(m[1]));
		return decoded === 'other' ? undefined : decoded;
	}

	m = modifyOtherKeysRe.exec(s);
	if (m) return decodeCodepoint(Number(m[2]), Number(m[1]));

	m = kittyRe.exec(s);
	if (m) return decodeCodepoint(Number(m[1]), m[2] ? Number(m[2]) : 1);
	// 带事件类型 / 关联文本 / 备用键的 CSI u：出空事件
	if (s.endsWith('u') && /^\u001B\[[\d;:]+u$/.test(s)) return make('');

	m = csiTildeRe.exec(s);
	if (m) {
		const name = tildeKeys[Number(m[1])];
		let flags = modifiers(m[2] ? Number(m[2]) : 1);
		if (m[3] === '$') flags = merge(flags, {shift: true});
		if (m[3] === '^') flags = merge(flags, {ctrl: true});
		return make('', flags, name);
	}

	m = csiLetterRe.exec(s);
	if (m) {
		const entry = letterKeys[m[2]!] ?? {};
		const flags = merge(modifiers(m[1] ? Number(m[1]) : 1), entry.flags ?? {});
		return make('', flags, entry.name);
	}

	return undefined;
};

/**
把一个输入单元（`input-parser.ts` 切出来的）解成 `(input, key)`；返回 undefined 表示这个单元不出事件
（焦点报告、非滚轮的 SGR 鼠标、单独的 ST）。
*/
const decodeKeypress = (s: string): DecodedInput | undefined => {
	if (!s.startsWith(escape) || s.length === 1) return decodeCharacter(s);

	if (s[1] === '[' && s.length > 2) {
		const csi = decodeCsi(s);
		if (csi !== undefined || /^\u001B\[(?:[IO]|<\d+;\d+;\d+[Mm])$/.test(s)) {
			return csi;
		}

		// 不认识的 CSI（含被冲刷出来的半截）：去掉 ESC 原样交出
		return make(s.slice(1));
	}

	if (s[1] === 'O' && s.length > 2) {
		const m = ss3Re.exec(s);
		if (!m) return make(s.slice(1));
		const final = m[2]!;
		if (final >= 'j' && final <= 'y') {
			return make(String.fromCharCode(final.charCodeAt(0) - 0x40));
		}

		const entry = ss3Keys[final] ?? {};
		const flags = merge(m[1] ? modifiers(Number(m[1])) : {}, entry.flags ?? {});
		return make('', flags, entry.name);
	}

	return decodeMeta(s.slice(1));
};

/**
不经按键解码的原样文本（一块里连续多个普通字符、bracketed paste 的内容）：
只去掉一个前导 ESC，单个大写字母补 shift。
*/
export const rawInput = (text: string): DecodedInput => {
	const input = text.startsWith(escape) ? text.slice(1) : text;
	return make(input, {shift: input.length === 1 && input >= 'A' && input <= 'Z'});
};

export default decodeKeypress;
