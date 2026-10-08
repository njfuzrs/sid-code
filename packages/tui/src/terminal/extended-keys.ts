/**
 * sid-code（B9 / T5.3a，契约 I4）：要不要开扩展键 —— kitty 键盘协议（`CSI >1u`）与 modifyOtherKeys（`CSI >4;2m`）。
 *
 * 规则来自对拍旧底座的黑盒探针（2026-10-08，约 1600 组环境变量组合），没有读旧代码（设计文档 D-5）：
 * 从上往下找第一条「认得出终端」的信号，认出的终端在 {@link EXTENDED_KEY_TERMINALS} 里才开。
 * - 只看环境变量，不看终端探查（`>0q` / DA1）的回复；
 * - 每个变量都按「非空」判断，空串等于没设；
 * - 进程里只判定一次（模块加载时），之后改环境变量不生效。
 */

type Env = Record<string, string | undefined>;

/** 认出这些终端时开扩展键（大小写敏感：`TERM_PROGRAM=Ghostty`、`TERM=wezterm` 都不算） */
const EXTENDED_KEY_TERMINALS: ReadonlySet<string> = new Set([
	'iTerm.app',
	'kitty',
	'WezTerm',
	'ghostty',
	'tmux',
	'windows-terminal',
]);

/** `__CFBundleIdentifier` 转小写后含其中任一子串，就当作 IDE 内置终端（不开） */
const IDE_BUNDLE_MARKERS = [
	'vscodium',
	'windsurf',
	'com.google.android.studio',
	'jetbrains',
	'pycharm',
	'intellij',
	'webstorm',
	'phpstorm',
	'rubymine',
	'clion',
	'goland',
	'rider',
	'datagrip',
	'appcode',
	'dataspell',
	'aqua',
	'fleet',
];

/** `VSCODE_GIT_ASKPASS_MAIN` 含其中任一子串（大小写敏感）就当作 VS Code 分支编辑器 */
const ASKPASS_EDITOR_MARKERS = ['cursor', 'windsurf', 'antigravity'];

/** 只要非空就认作某个（不开扩展键的）终端的变量，各自出现在优先级表里的位置见 {@link identifyTerminal} */
const NON_EXTENDED_PRESENCE_A = [
	'STY',
	'KONSOLE_VERSION',
	'GNOME_TERMINAL_SERVICE',
	'XTERM_VERSION',
	'VTE_VERSION',
	'TERMINATOR_UUID',
];
const NON_EXTENDED_PRESENCE_B = ['ALACRITTY_LOG', 'TILIX_ID'];
const NON_EXTENDED_PRESENCE_C = [
	'MSYSTEM',
	'ConEmuANSI',
	'ConEmuPID',
	'ConEmuTask',
	'WSL_DISTRO_NAME',
	'SSH_TTY',
	'SSH_CLIENT',
	'SSH_CONNECTION',
];

const has = (env: Env, name: string): boolean => Boolean(env[name]);
const firstPresent = (env: Env, names: readonly string[]): string | undefined =>
	names.find(name => has(env, name));

/**
 * 按优先级认终端，返回一个标签（白名单里的名字，或描述性的非白名单标签）；什么都认不出返回 undefined。
 * 优先级（探针逐对确认过前后关系）：
 * IDE 信号 → `TERM` 的 kitty / ghostty → `TERM_PROGRAM` → `TMUX` → 一组非白名单终端 →
 * `KITTY_WINDOW_ID` → 第二组 → `WT_SESSION` → 第三组（Windows 外壳 / SSH）→ `TERM` 原值
 */
export function identifyTerminal(env: Env): string | undefined {
	if (has(env, 'CURSOR_TRACE_ID')) return 'ide:cursor';
	const askpass = env['VSCODE_GIT_ASKPASS_MAIN'] ?? '';
	const editor = ASKPASS_EDITOR_MARKERS.find(marker => askpass.includes(marker));
	if (editor) return `ide:${editor}`;
	const bundle = (env['__CFBundleIdentifier'] ?? '').toLowerCase();
	const ide = IDE_BUNDLE_MARKERS.find(marker => bundle.includes(marker));
	if (ide) return `ide:${ide}`;
	if (has(env, 'VisualStudioVersion')) return 'ide:visualstudio';
	if (env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm') return 'ide:jetbrains';

	const term = env['TERM'] ?? '';
	if (term === 'xterm-ghostty') return 'ghostty';
	if (term.includes('kitty')) return 'kitty';
	if (env['TERM_PROGRAM']) return env['TERM_PROGRAM'];
	if (has(env, 'TMUX')) return 'tmux';

	const a = firstPresent(env, NON_EXTENDED_PRESENCE_A);
	if (a) return `env:${a}`;
	if (has(env, 'KITTY_WINDOW_ID')) return 'kitty';
	const b = firstPresent(env, NON_EXTENDED_PRESENCE_B);
	if (b) return `env:${b}`;
	if (has(env, 'WT_SESSION')) return 'windows-terminal';
	const c = firstPresent(env, NON_EXTENDED_PRESENCE_C);
	if (c) return `env:${c}`;
	return term || undefined;
}

export function detectExtendedKeys(env: Env): boolean {
	const terminal = identifyTerminal(env);
	return terminal !== undefined && EXTENDED_KEY_TERMINALS.has(terminal);
}

const extendedKeysAtLoad = detectExtendedKeys(process.env);

/** 本进程是否开扩展键（加载时判定一次） */
export function supportsExtendedKeys(): boolean {
	return extendedKeysAtLoad;
}

/** raw mode 打开时写：bracketed paste、focus reporting，各一次独立写入 */
export const enableInputModesSequences = ['\u001B[?2004h', '\u001B[?1004h'] as const;
/** 扩展键打开时追加：kitty 键盘、modifyOtherKeys，各一次独立写入 */
export const enableExtendedKeysSequences = ['\u001B[>1u', '\u001B[>4;2m'] as const;
/** raw mode 计数归零时写（不论扩展键开没开都写）：modifyOtherKeys、kitty、focus、bracketed paste 依次关 */
export const disableInputModesSequences = [
	'\u001B[>4m',
	'\u001B[<u',
	'\u001B[?1004l',
	'\u001B[?2004l',
] as const;
/** stdin 静默 > 5s 后的第一块输入：扩展键开着时整段重申一次（先弹栈再压栈） */
export const reassertExtendedKeysSequence = '\u001B[<u\u001B[>1u\u001B[>4;2m';
