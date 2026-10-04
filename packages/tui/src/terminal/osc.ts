/**
 * OSC 序列与终端多路复用器包裹（B9 / T2.3，契约 O6）。
 *
 * 规则来自黑盒对拍旧底座（经端口在 legacy / next 子进程里差分，见
 * packages/cli/tests/render-port/contracts-termio.test.ts）：
 * - 终止符：kitty 用 ST（`ESC \`），其余用 BEL。判定 kitty 的条件是 `TERM` 含小写 `kitty`、
 *   `TERM_PROGRAM === 'kitty'`，或 `KITTY_WINDOW_ID` 非空。**模块加载时判定一次**，之后改环境变量不影响。
 * - 多路复用器包裹在**调用时**读环境：`TMUX` 非空 → tmux DCS 透传（内部每个 ESC 写两次）；
 *   否则 `STY` 非空 → screen DCS；都没有 → 原样。两者都设时 tmux 优先。
 */
const ESC = '\x1b';

export const BEL = '\x07';
export const ST = `${ESC}\\`;

/** OSC 编号（xterm / iTerm2 / kitty / ghostty 各家文档里的标准值）。按用途分组，不按数值排。 */
export const OSC = {
	// 窗口与图标标题
	SET_TITLE_AND_ICON: 0,
	SET_ICON: 1,
	SET_TITLE: 2,
	// 工作目录、超链接、剪贴板
	SET_CWD: 7,
	HYPERLINK: 8,
	CLIPBOARD: 52,
	// 调色板与动态颜色，及其复位
	SET_COLOR: 4,
	RESET_COLOR: 104,
	SET_FG_COLOR: 10,
	RESET_FG_COLOR: 110,
	SET_BG_COLOR: 11,
	RESET_BG_COLOR: 111,
	SET_CURSOR_COLOR: 12,
	RESET_CURSOR_COLOR: 112,
	// shell 集成
	SEMANTIC_PROMPT: 133,
	// 各终端私有扩展
	ITERM2: 9,
	KITTY: 99,
	GHOSTTY: 777,
	TAB_STATUS: 21_337,
} as const;

type Env = Record<string, string | undefined>;

/** 当前终端该用哪个 OSC 终止符。导出给测试；生产代码用 `osc()`。 */
export function oscTerminator(env: Env): string {
	const kitty =
		Boolean(env['TERM']?.includes('kitty')) ||
		env['TERM_PROGRAM'] === 'kitty' ||
		Boolean(env['KITTY_WINDOW_ID']);
	return kitty ? ST : BEL;
}

const terminator = oscTerminator(process.env);

/** 拼一条 OSC 序列：`ESC ]` + 各段以 `;` 相连 + 终止符。 */
export function osc(...parts: Array<string | number>): string {
	return `${ESC}]${parts.join(';')}${terminator}`;
}

/** 让控制序列穿过 tmux / screen 到达外层终端。不在多路复用器里时原样返回。 */
export function wrapForMultiplexer(
	sequence: string,
	env: Env = process.env,
): string {
	if (env['TMUX']) {
		return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
	}

	if (env['STY']) {
		return `${ESC}P${sequence}${ST}`;
	}

	return sequence;
}
