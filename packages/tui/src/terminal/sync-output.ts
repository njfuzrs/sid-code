/**
 * 终端是否支持 DEC 2026 同步输出（B9 / T6.1a，契约 R14）。
 *
 * 只影响 **alt-screen** 帧要不要包 `?2026h … ?2026l`；主屏帧一律包（R1，与旧底座一致）。
 * 判定规则来自黑盒对拍旧底座（`env -i` 逐个变量起子进程看 alt 帧有没有包裹），大小写敏感：
 * - `TMUX` 非空 → 不支持（tmux 不透传 2026，压过下面所有条件）；`STY`（screen）不影响；
 * - `TERM_PROGRAM` 精确等于 iTerm.app / vscode / WezTerm / ghostty / WarpTerminal / alacritty / contour；
 * - `KITTY_WINDOW_ID` / `WT_SESSION` / `ZED_TERM` 非空；
 * - `VTE_VERSION` 按 `parseInt` 取值 ≥ 6800（`6800x` 算，`abc` 不算）；
 * - `TERM` 含 `kitty` 或 `alacritty`、以 `foot` 开头、或恰好是 `xterm-ghostty`。
 * 其余（Apple Terminal、tmux、Hyper、kitty 写成 `TERM_PROGRAM=kitty`…）都不支持。
 */
type Env = Record<string, string | undefined>;

const SYNC_TERM_PROGRAMS = new Set([
	'iTerm.app',
	'vscode',
	'WezTerm',
	'ghostty',
	'WarpTerminal',
	'alacritty',
	'contour',
]);

export function supportsSynchronizedOutput(env: Env = process.env): boolean {
	if (env['TMUX']) {
		return false;
	}

	if (env['TERM_PROGRAM'] && SYNC_TERM_PROGRAMS.has(env['TERM_PROGRAM'])) {
		return true;
	}

	if (env['KITTY_WINDOW_ID'] || env['WT_SESSION'] || env['ZED_TERM']) {
		return true;
	}

	const vte = Number.parseInt(env['VTE_VERSION'] ?? '', 10);
	if (vte >= 6800) {
		return true;
	}

	const term = env['TERM'] ?? '';
	return (
		term.includes('kitty') ||
		term.includes('alacritty') ||
		term.startsWith('foot') ||
		term === 'xterm-ghostty'
	);
}
