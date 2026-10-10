// sid-code（B9 / T4.1，契约 T5）：新写。上游没有等价物（只有 Transform）。
// 规则全部来自对拍旧底座首帧字节（tests/fixtures/screen-vectors.json 的 `Ansi *` 条目），没有读旧代码。
import React, {memo} from 'react';
import type {Color} from '@sid-code/shared/types/color.ts';
import {tokenizeAnsi} from '../ansi-tokenizer.js';
import {applyTextStyles} from '../colorize.js';
import {supportsHyperlinks} from '../terminal/hyperlinks.js';
import Text from './Text.js';

export type Props = {
	readonly children: string;
	/** 整段变暗。暗与粗体互斥：开了它，原文里的粗体一律丢掉。 */
	readonly dimColor?: boolean;
};

type SpanStyle = {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
	color?: string;
	backgroundColor?: string;
	hyperlink?: string;
};

type Span = {text: string; style: SpanStyle};

const NAMES = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
] as const;

/**
 * 解析 38 / 48 后面的扩展颜色。返回颜色与吃掉的参数个数；参数不够时返回 undefined，
 * 调用方只跳过 38 / 48 本身，后面的参数照常当独立的 SGR 码解析（对拍得出：`38;2;1` 里的 2、1 会变成暗、粗体）。
 */
const readExtendedColor = (
	params: number[],
	at: number,
): {color: string; used: number} | undefined => {
	const mode = params[at + 1];
	if (mode === 5 && params.length > at + 2) {
		return {color: `ansi256(${params[at + 2]})`, used: 2};
	}

	if (mode === 2 && params.length > at + 4) {
		const [r, g, b] = params.slice(at + 2, at + 5);
		return {color: `rgb(${r},${g},${b})`, used: 4};
	}

	return undefined;
};

/**
 * 一条 SGR 的参数串拆成数字序列。冒号子参数：`4:n` 是下划线变体（n = 0 关，其余开），
 * 记成内部码 -24 / 4；`38:5:n`、`38:2:[cs]:r:g:b` 展平成分号形式（色彩空间那一格丢掉）。
 */
const parseParams = (parameterString: string): number[] => {
	if (parameterString === '') {
		return [0];
	}

	const out: number[] = [];
	for (const param of parameterString.split(';')) {
		if (!param.includes(':')) {
			out.push(param === '' ? 0 : Number(param));
			continue;
		}

		const sub = param.split(':');
		const head = Number(sub[0]);
		if (head === 4) {
			out.push(Number(sub[1] || 0) === 0 ? -24 : 4);
			continue;
		}

		if ((head === 38 || head === 48) && sub[1] === '2' && sub.length >= 6) {
			out.push(head, 2, ...sub.slice(-3).map(Number));
			continue;
		}

		out.push(...sub.map(x => Number(x || 0)));
	}

	return out;
};

const applySgr = (style: SpanStyle, parameterString: string): SpanStyle => {
	const params = parseParams(parameterString);
	let next: SpanStyle = {...style};
	for (let i = 0; i < params.length; i++) {
		const code = params[i]!;
		if (code === 0) {
			next = {hyperlink: next.hyperlink};
		} else if (code === 1) {
			next.bold = true;
		} else if (code === 2) {
			next.dim = true;
		} else if (code === 3) {
			next.italic = true;
		} else if (code === 4 || code === 21) {
			next.underline = true;
		} else if (code === 7) {
			next.inverse = true;
		} else if (code === 9) {
			next.strikethrough = true;
		} else if (code === 22) {
			next.bold = false;
			next.dim = false;
		} else if (code === 23) {
			next.italic = false;
		} else if (code === 24 || code === -24) {
			next.underline = false;
		} else if (code === 27) {
			next.inverse = false;
		} else if (code === 29) {
			next.strikethrough = false;
		} else if (code >= 30 && code <= 37) {
			next.color = `ansi:${NAMES[code - 30]}`;
		} else if (code >= 90 && code <= 97) {
			next.color = `ansi:${NAMES[code - 90]}Bright`;
		} else if (code === 39) {
			next.color = undefined;
		} else if (code >= 40 && code <= 47) {
			next.backgroundColor = `ansi:${NAMES[code - 40]}`;
		} else if (code >= 100 && code <= 107) {
			next.backgroundColor = `ansi:${NAMES[code - 100]}Bright`;
		} else if (code === 49) {
			next.backgroundColor = undefined;
		} else if (code === 38 || code === 48) {
			const ext = readExtendedColor(params, i);
			if (ext) {
				if (code === 38) next.color = ext.color;
				else next.backgroundColor = ext.color;
				i += ext.used;
			}
		}
		// 其余（闪烁 5、隐藏 8、上划线 53 …）旧底座一律丢弃
	}

	return next;
};

/** OSC 8：`ESC ] 8 ; params ; url (BEL | ST)`。返回 url（空串 = 关闭链接），不是 OSC 8 返回 undefined。 */
const parseHyperlink = (value: string): string | undefined => {
	const body = value
		.replace(/^(\u001B\]|\u009D)/, '')
		.replace(/(\u0007|\u001B\\|\u009C)$/, '');
	if (!body.startsWith('8;')) {
		return undefined;
	}

	const rest = body.slice(2);
	const sep = rest.indexOf(';');
	return sep < 0 ? '' : rest.slice(sep + 1);
};

/** ANSI 文本 → 带样式的片段。非 SGR 的控制序列、非链接的 OSC 全部丢掉。 */
export const parseAnsiSpans = (input: string): Span[] => {
	const spans: Span[] = [];
	let style: SpanStyle = {};
	for (const token of tokenizeAnsi(input)) {
		if (token.type === 'text') {
			const last = spans[spans.length - 1];
			if (last && last.style === style) last.text += token.value;
			else spans.push({text: token.value, style});
		} else if (
			token.type === 'csi' &&
			token.finalCharacter === 'm' &&
			token.intermediateString === ''
		) {
			style = applySgr(style, token.parameterString);
		} else if (token.type === 'osc') {
			const url = parseHyperlink(token.value);
			if (url !== undefined) style = {...style, hyperlink: url || undefined};
		}
	}

	return spans;
};

const encodeSpan = (span: Span, forceDim: boolean, links: boolean): string => {
	const {style} = span;
	const dim = forceDim || Boolean(style.dim);
	// 暗与粗体互斥：旧底座里只要暗开着，粗体就不出 SGR
	const styled = applyTextStyles(span.text, {
		dim,
		bold: !dim && style.bold,
		italic: style.italic,
		underline: style.underline,
		strikethrough: style.strikethrough,
		inverse: style.inverse,
		color: style.color as Color | undefined,
		backgroundColor: style.backgroundColor as Color | undefined,
	});
	// 链接只在终端支持时保留，并统一写成可改写的 `OSC 8 ;; url BEL`（原来带的 id / 参数不保留）
	return links && style.hyperlink
		? `\u001B]8;;${style.hyperlink}\u0007${styled}\u001B]8;;\u0007`
		: styled;
};

/**
 * 把一段 ANSI 文本渲染成一个 `<Text>`：先解析成片段，再按 Text 的样式叠加顺序重新编码。
 * 所以输入里的 SGR 写法不同（复合、冒号、reset）而样式相同时，输出字节相同。
 */
function Ansi({children, dimColor = false}: Props) {
	if (!children) {
		return null;
	}

	const links = supportsHyperlinks();
	const encoded = parseAnsiSpans(children)
		.map(span => encodeSpan(span, dimColor, links))
		.join('');
	return <Text>{encoded}</Text>;
}

export default memo(Ansi);
