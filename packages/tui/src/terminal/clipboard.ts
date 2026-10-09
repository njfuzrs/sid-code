/**
 * 复制到剪贴板（B9 / T2.3，契约 O7 / M3）。
 *
 * `setClipboard(text)` 返回一条 OSC 52 序列（调用方负责写进终端），同时尽量把内容送进系统剪贴板。
 * 规则来自黑盒对拍旧底座（差分测试见 packages/cli/tests/render-port/contracts-termio.test.ts）：
 * - 序列：`osc(52, 'c', base64(utf8(text)))`。
 * - 系统剪贴板（发出去不等结果，失败静默）。`SSH_CONNECTION` 非空时跳过，因为远端机器的剪贴板不是用户的：
 *   - darwin：`pbcopy`；
 *   - win32：`clip`；
 *   - linux（含 WSL）：依次试 `wl-copy`、`xclip -selection clipboard`、`xsel --clipboard --input`。
 *     记住第一个成功的，之后只用它（它后来失败也不再换）；三个都失败就记成「没有」，之后不再尝试；
 *   - 其他平台：不做。
 * - tmux（`TMUX` 非空）：另外**等待** `tmux load-buffer -w -`，最多 2 秒。`LC_TERMINAL` 恰好是 `iTerm2` 时不带 `-w`。
 *   成功就返回 tmux 透传包裹后的序列（里层固定用 BEL 终止，kitty 也一样），失败、超时或没有 tmux
 *   就返回未包裹的序列（终止符按终端选）。
 *   只在 screen（`STY`）里时不包裹。
 */
import {BEL, OSC, osc, wrapForMultiplexer} from './osc.js';

type Env = Record<string, string | undefined>;

/** 跑一个命令，把 input 写进它的 stdin；退出码 0 为成功。拿不到命令、超时都算失败，不抛。 */
export type CommandRunner = (
	command: string,
	args: string[],
	input: string,
	timeoutMs?: number,
) => Promise<boolean>;

export const runCommand: CommandRunner = async (
	command,
	args,
	input,
	timeoutMs,
) => {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn([command, ...args], {
			stdin: new TextEncoder().encode(input),
			stdout: 'ignore',
			stderr: 'ignore',
		});
	} catch {
		return false;
	}

	if (timeoutMs === undefined) {
		return (await child.exited) === 0;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timeout'>(resolve => {
		timer = setTimeout(() => {
			resolve('timeout');
		}, timeoutMs);
	});
	const result = await Promise.race([child.exited, timedOut]);
	clearTimeout(timer);
	if (result === 'timeout') {
		child.kill();
		return false;
	}

	return result === 0;
};

type Tool = readonly [command: string, args: string[]];

const LINUX_TOOLS: readonly Tool[] = [
	['wl-copy', []],
	['xclip', ['-selection', 'clipboard']],
	['xsel', ['--clipboard', '--input']],
];

const TMUX_TIMEOUT_MS = 2000;

export type ClipboardDeps = {
	run?: CommandRunner;
	env?: () => Env;
	platform?: () => NodeJS.Platform;
};

/** 造一个 setClipboard。每个实例有自己的 linux 工具缓存；测试注入 run / env / platform。 */
export function createSetClipboard({
	run = runCommand,
	env = () => process.env,
	platform = () => process.platform,
}: ClipboardDeps = {}): (text: string) => Promise<string> {
	let linuxTool: Promise<Tool | undefined> | undefined;

	const copyNative = (text: string, os: NodeJS.Platform) => {
		if (os === 'darwin') {
			void run('pbcopy', [], text);
		} else if (os === 'win32') {
			void run('clip', [], text);
		} else if (os === 'linux') {
			if (linuxTool) {
				void linuxTool.then(async tool =>
					tool ? run(tool[0], tool[1], text) : undefined,
				);
				return;
			}

			// 第一次：边试边复制，第一个成功的那次已经把内容送进去了
			linuxTool = (async () => {
				for (const tool of LINUX_TOOLS) {
					// 顺序试探是这条规则本身，不能并发（前一个成功就不再试后面的）
					if (await run(tool[0], tool[1], text)) {
						return tool;
					}
				}

				return undefined;
			})();
		}
	};

	return async (text: string): Promise<string> => {
		const vars = env();
		const payload = Buffer.from(text, 'utf8').toString('base64');
		const sequence = osc(OSC.CLIPBOARD, 'c', payload);

		if (!vars['SSH_CONNECTION']) {
			copyNative(text, platform());
		}

		if (!vars['TMUX']) {
			return sequence;
		}

		const args =
			vars['LC_TERMINAL'] === 'iTerm2'
				? ['load-buffer', '-']
				: ['load-buffer', '-w', '-'];
		const loaded = await run('tmux', args, text, TMUX_TIMEOUT_MS);
		// 透传给 tmux 的那份固定用 BEL 终止，哪怕外层是 kitty（对拍得出；未包裹的那份仍按终端选终止符）
		return loaded
			? wrapForMultiplexer(`\x1b]${OSC.CLIPBOARD};c;${payload}${BEL}`, vars)
			: sequence;
	};
}

export const setClipboard = createSetClipboard();
