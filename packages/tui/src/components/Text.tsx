import React, {createContext, useContext, type ReactNode} from 'react';
import {type ForegroundColorName} from 'chalk';
import {type LiteralUnion} from 'type-fest';
import type {Color} from '@sid-code/shared/types/color.ts';
import {applyTextStyles, type TextStyles} from '../colorize.js';
import {type Styles} from '../styles.js';
import {accessibilityContext} from './AccessibilityContext.js';
import {backgroundContext} from './BackgroundContext.js';

export type Props = {
	/**
	A label for the element for screen readers.
	*/
	readonly 'aria-label'?: string;

	/**
	Hide the element from screen readers.
	*/
	readonly 'aria-hidden'?: boolean;

	/**
	Change text color. Ink uses Chalk under the hood, so all its functionality is supported.
	*/
	readonly color?: LiteralUnion<ForegroundColorName, string>;

	/**
	Same as `color`, but for the background.
	*/
	readonly backgroundColor?: LiteralUnion<ForegroundColorName, string>;

	/**
	sid-code（B9 / T4.1）：暗色（SGR 2）。端口的名字是 `dim`，不是上游的 `dimColor`。
	*/
	readonly dim?: boolean;

	/**
	sid-code（B9 / T4.1）：保留这个名字只为类型兼容，**不产生任何样式**（对拍旧底座：`<Text dimColor>` 不出 SGR）。
	要变暗用 `dim`。
	*/
	readonly dimColor?: boolean;

	/**
	Make the text bold.
	*/
	readonly bold?: boolean;

	/**
	Make the text italic.
	*/
	readonly italic?: boolean;

	/**
	Make the text underlined.
	*/
	readonly underline?: boolean;

	/**
	Make the text crossed out with a line.
	*/
	readonly strikethrough?: boolean;

	/**
	Inverse background and foreground colors.
	*/
	readonly inverse?: boolean;

	/**
	This property tells Ink to wrap or truncate text if its width is larger than the container. If `wrap` is passed (the default), Ink will wrap text and split it into multiple lines. If `hard` is passed, Ink will fill each line to the full column width, breaking words as necessary. If `truncate-*` is passed, Ink will truncate text instead, resulting in one line of text with the rest cut off.
	*/
	readonly wrap?: Styles['textWrap'];

	readonly children?: ReactNode;
};

type InheritedStyle = Omit<TextStyles, 'color' | 'backgroundColor'> & {
	readonly color?: string;
	readonly backgroundColor?: string;
};

/**
 * sid-code（B9 / T4.1）：嵌套 `<Text>` 继承外层 Text 的样式，内层自己把合并后的整套样式编码一遍。
 * 对拍得出：`<Text inverse>a<Text underline>b</Text></Text>` 里 b 的样式顺序是 underline 在前、inverse 在后，
 * 只靠外层 transform 包住内层输出得不到这个顺序。外层的 transform 照旧包住全部内容（换行 / 截断之后才上样式）。
 */
const textStyleContext = createContext<InheritedStyle | undefined>(undefined);

/**
This component can display text and change its style to make it bold, underlined, italic, or strikethrough.

sid-code（B9 / T4.1）：样式叠加改走 `applyTextStyles`（由内到外 inverse → strikethrough → underline →
italic → bold → dim → 前景 → 背景），顺序对拍旧底座首帧字节。没有显式背景时继承外层 Box 的背景。
*/
export default function Text({
	color,
	backgroundColor,
	dim = false,
	bold = false,
	italic = false,
	underline = false,
	strikethrough = false,
	inverse = false,
	wrap = 'wrap',
	children,
	'aria-label': ariaLabel,
	'aria-hidden': ariaHidden = false,
}: Props) {
	const {isScreenReaderEnabled} = useContext(accessibilityContext);
	const inheritedBackgroundColor = useContext(backgroundContext);
	const outer = useContext(textStyleContext);
	const childrenOrAriaLabel =
		isScreenReaderEnabled && ariaLabel ? ariaLabel : children;

	if (childrenOrAriaLabel === undefined || childrenOrAriaLabel === null) {
		return null;
	}

	// 只有显式开的样式覆盖外层；布尔样式写 false 不会关掉外层开着的
	const style: InheritedStyle = {
		...outer,
		...(dim && {dim}),
		...(bold && {bold}),
		...(italic && {italic}),
		...(underline && {underline}),
		...(strikethrough && {strikethrough}),
		...(inverse && {inverse}),
		...(color !== undefined && {color}),
		...((backgroundColor ?? (outer ? undefined : inheritedBackgroundColor)) !==
			undefined && {
			backgroundColor: backgroundColor ?? inheritedBackgroundColor,
		}),
	};

	const transform = (children: string): string =>
		applyTextStyles(children, {
			...style,
			color: style.color as Color | undefined,
			backgroundColor: style.backgroundColor as Color | undefined,
		});

	if (isScreenReaderEnabled && ariaHidden) {
		return null;
	}

	return (
		<ink-text
			style={{flexGrow: 0, flexShrink: 1, flexDirection: 'row', textWrap: wrap}}
			internal_transform={transform}
		>
			<textStyleContext.Provider value={style}>
				{childrenOrAriaLabel}
			</textStyleContext.Provider>
		</ink-text>
	);
}
