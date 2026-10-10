/**
 * 终端是否支持 OSC 8 超链接（B9 / T2.3，契约 O4）。
 *
 * 先信 npm `supports-hyperlinks` 对 stdout 的判定（它在模块加载时读一次环境）；它说不支持时，
 * 再按我们自己确认过的终端名单补判：`TERM_PROGRAM` 或 `LC_TERMINAL`（tmux 里 TERM_PROGRAM 是 tmux，
 * 外层终端名在 LC_TERMINAL）精确命中名单，或 `TERM` 含小写 `kitty`。规则来自黑盒对拍旧底座。
 */
import supportsHyperlinksLibrary from 'supports-hyperlinks';

type Env = Record<string, string | undefined>;

/** 库不认识、但实测支持 OSC 8 的终端（大小写敏感，按各终端自报的名字）。 */
export const ADDITIONAL_HYPERLINK_TERMINALS: readonly string[] = [
	'iTerm.app',
	'iTerm2',
	'kitty',
	'ghostty',
	'alacritty',
	'Hyper',
];

export type SupportsHyperlinksOptions = {
	env?: Env;
	stdoutSupported?: boolean;
};

export function supportsHyperlinks({
	env = process.env,
	stdoutSupported = supportsHyperlinksLibrary.stdout,
}: SupportsHyperlinksOptions = {}): boolean {
	if (stdoutSupported) {
		return true;
	}

	const known = (name: string | undefined) =>
		name !== undefined && ADDITIONAL_HYPERLINK_TERMINALS.includes(name);
	return (
		known(env['TERM_PROGRAM']) ||
		known(env['LC_TERMINAL']) ||
		Boolean(env['TERM']?.includes('kitty'))
	);
}
