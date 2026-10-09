// sid-code（B9 / T2.2）：整文件改写，语义对齐旧底座（契约 T6 / 端口 text.ts），见 UPSTREAM-DIFF.md。
// 与上游的差别：颜色名必须带 `ansi:` 前缀（端口 Color 类型就是这么定义的，裸名 `red` 原样返回）；
// 新增 applyColor / applyTextStyles；按终端修正 chalk 的颜色级别。
import chalk, {type BackgroundColorName, type ForegroundColorName} from 'chalk';
import type {Color} from '@sid-code/shared/types/color.ts';

export type ColorType = 'foreground' | 'background';

/**
 * 布尔样式，按叠加顺序从内到外排列。顺序决定字节序列：嵌套时 chalk 会在内层关闭处重开外层样式，
 * 差分测试按字节比较，所以顺序是契约的一部分（对拍旧底座得出）。类型与叠加循环都从这张表派生。
 */
const STYLE_LAYERS = [
	'inverse',
	'strikethrough',
	'underline',
	'italic',
	'bold',
	'dim',
] as const satisfies ReadonlyArray<keyof typeof chalk>;

type StyleFlag = (typeof STYLE_LAYERS)[number];

/** 端口 `applyTextStyles` 的入参：六个布尔样式，加前景 / 背景色（叠在所有布尔样式外面，背景最外）。 */
export type TextStyles = {readonly [Flag in StyleFlag]?: boolean} & {
	readonly color?: Color;
	readonly backgroundColor?: Color;
};

type Level = typeof chalk.level;

/**
 * 按终端修正 chalk 自动探测出的颜色级别（对拍旧底座的规则）：
 * 1. `TERM_PROGRAM === 'vscode'`（区分大小写）且探测为 256 色 → 升到真彩。xterm.js 支持真彩，
 *    但 supports-color 在它里面常只报 256 色。
 * 2. 设置了非空的 `TMUX`、级别为真彩 → 降到 256 色。tmux 默认不透传真彩，
 *    透传出去的 24 位色会被它近似成错的颜色。用户确认自己的 tmux 开了透传时，
 *    设置 `SID_CODE_TMUX_TRUECOLOR`（任意非空值，`0` 也算）跳过这一步。
 * 两条按顺序执行：VS Code 里跑 tmux 时先升后降，结果是 256 色。
 *
 * 旧变量名 `CLAUDE_CODE_TMUX_TRUECOLOR` 仍然认（D125：新底座改名），T9 删除旧底座时一并去掉。
 */
export function adjustColorLevel(level: Level, env: NodeJS.ProcessEnv): Level {
	let adjusted = level;
	if (env['TERM_PROGRAM'] === 'vscode' && adjusted === 2) {
		adjusted = 3;
	}

	const truecolorOptIn = Boolean(
		env['SID_CODE_TMUX_TRUECOLOR'] ?? env['CLAUDE_CODE_TMUX_TRUECOLOR'],
	);
	if (env['TMUX'] && adjusted === 3 && !truecolorOptIn) {
		adjusted = 2;
	}

	return adjusted;
}

// chalk 是全进程单例（CLI 的 markdown 渲染用的也是它），所以这里改的是整个进程的颜色级别，与旧底座一致
chalk.level = adjustColorLevel(chalk.level, process.env);

const ANSI_PREFIX = 'ansi:';

// 只认这 16 个名字。chalk 上还有 gray / grey / bold 之类的属性，`ansi:gray` 不算颜色，原样返回
const NAMED_COLORS: ReadonlySet<string> = new Set<ForegroundColorName>([
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'blackBright',
	'redBright',
	'greenBright',
	'yellowBright',
	'blueBright',
	'magentaBright',
	'cyanBright',
	'whiteBright',
]);

const rgbRegex = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/;
const ansiRegex = /^ansi256\(\s?(\d+)\s?\)$/;

/**
 * 给文本上前景 / 背景色。认 `ansi:<16 色名>`、`#hex`、`ansi256(n)`、`rgb(r,g,b)`；
 * 空值与认不出的写法原样返回。实际输出由 chalk 按当前颜色级别降级（级别 0 时一律原样）。
 */
export const colorize = (
	str: string,
	color: string | undefined,
	type: ColorType,
): string => {
	if (!color) {
		return str;
	}

	if (color.startsWith(ANSI_PREFIX)) {
		const name = color.slice(ANSI_PREFIX.length);
		if (!NAMED_COLORS.has(name)) {
			return str;
		}

		if (type === 'foreground') {
			return chalk[name as ForegroundColorName](str);
		}

		const methodName = `bg${
			name[0]!.toUpperCase() + name.slice(1)
		}` as BackgroundColorName;

		return chalk[methodName](str);
	}

	if (color.startsWith('#')) {
		return type === 'foreground'
			? chalk.hex(color)(str)
			: chalk.bgHex(color)(str);
	}

	if (color.startsWith('ansi256')) {
		const matches = ansiRegex.exec(color);

		if (!matches) {
			return str;
		}

		const value = Number(matches[1]);

		return type === 'foreground'
			? chalk.ansi256(value)(str)
			: chalk.bgAnsi256(value)(str);
	}

	if (color.startsWith('rgb')) {
		const matches = rgbRegex.exec(color);

		if (!matches) {
			return str;
		}

		const firstValue = Number(matches[1]);
		const secondValue = Number(matches[2]);
		const thirdValue = Number(matches[3]);

		return type === 'foreground'
			? chalk.rgb(firstValue, secondValue, thirdValue)(str)
			: chalk.bgRgb(firstValue, secondValue, thirdValue)(str);
	}

	return str;
};

export default colorize;

/** 端口面的简写：只上前景色。 */
export const applyColor = (text: string, color?: Color): string =>
	colorize(text, color, 'foreground');

/** 颜色层叠在所有布尔样式外面：先前景，背景最外。 */
const COLOR_LAYERS = [
	['color', 'foreground'],
	['backgroundColor', 'background'],
] as const satisfies ReadonlyArray<readonly [keyof TextStyles, ColorType]>;

/** 套上一层布尔样式；该层没开就原样返回。 */
const layerStyle = (input: string, flag: StyleFlag, style: TextStyles) =>
	style[flag] ? chalk[flag](input) : input;

/** 叠加文本样式：先按 STYLE_LAYERS 由内到外套布尔样式，再按 COLOR_LAYERS 套颜色。 */
export function applyTextStyles(input: string, style: TextStyles): string {
	let styled = input;
	for (const flag of STYLE_LAYERS) styled = layerStyle(styled, flag, style);
	for (const [key, type] of COLOR_LAYERS) styled = colorize(styled, style[key], type);
	return styled;
}
