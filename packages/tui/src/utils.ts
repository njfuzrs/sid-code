import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import tty from 'node:tty';

type WindowSize = {columns: number; rows: number};

const defaultSize: WindowSize = {columns: 80, rows: 24};

/**
兜底尺寸在同一进程里只算一次（P14）。

`stdout.columns`/`rows` 为 0 时（PTY 0×0、stdout 不是 TTY）`getWindowSize` 会被渲染路径
每帧调用多次（`ink.tsx` 里十几个调用点）。此前每次调用都走 `terminal-size` 的兜底：
macOS 上它 `openSync('/dev/tty')` 之后既不 close 也不 destroy —— 每帧泄漏 1 个 fd
（实测 200 次 3→205）；打不开 `/dev/tty` 时每次起两个 `tput` 子进程（实测 2.4–3.5 ms/次）。

兜底结果只由进程环境决定（`/dev/tty` 尺寸、`COLUMNS`/`LINES`、有没有控制终端），算一次就是常量。
真实 resize 之后 `stdout.columns`/`rows` 会自己更新，走快路径，不依赖这里的缓存。
*/
let fallbackSize: WindowSize | undefined;

/** 与上游 `terminal-size` 同口径：没有控制终端时命令会给 80×24，当成「没拿到」。 */
const toWindowSize = (columns: number, rows: number): WindowSize | undefined =>
	columns === defaultSize.columns && rows === defaultSize.rows
		? undefined
		: {columns, rows};

/**
读 `/dev/tty` 的尺寸；打不开、或尺寸为 0 时返回 undefined。

与上游的差别只有一处：**fd 必须收回来**。上游 `terminal-size` 的 devTty 只 open 不 close，
正是 P14 的泄漏源；这里 WriteStream 接管了 fd 就 destroy（它会关），构造失败时裸 fd 自己关。
*/
const readDevTty = (): WindowSize | undefined => {
	let fd: number | undefined;
	let stream: tty.WriteStream | undefined;

	try {
		// darwin 用 `O_EVTONLY`：只取终端属性、不要求读写权限（上游同口径）。
		// 它是 darwin 专有常量，Node 的类型定义里没有，只能自己取。
		const flags =
			process.platform === 'darwin'
				? ((fs.constants as unknown as {O_EVTONLY?: number}).O_EVTONLY ?? 0) |
					fs.constants.O_NONBLOCK
				: fs.constants.O_NONBLOCK;

		fd = fs.openSync('/dev/tty', flags);
		stream = new tty.WriteStream(fd);

		const {columns, rows} = stream;
		return columns && rows ? {columns, rows} : undefined;
	} catch {
		return undefined;
	} finally {
		if (stream) {
			stream.destroy();
		} else if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
};

/**
跑一条尺寸命令并解析出数字。

`timeout` 是必须的：这条路径在渲染前同步执行，`tput` 卡住会把整个 TUI 挂起。
*/
const runSizeCommand = (command: string, args: string[]): number[] | undefined => {
	try {
		const output = execFileSync(command, args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 500,
			env: {TERM: 'dumb', ...process.env},
		});

		const values = output
			.trim()
			.split(/\s+/)
			.map(value => Number.parseInt(value, 10));

		return values.every(value => Number.isFinite(value) && value > 0)
			? values
			: undefined;
	} catch {
		return undefined;
	}
};

/** `tput cols` / `tput lines`。 */
const readTput = (): WindowSize | undefined => {
	const columns = runSizeCommand('tput', ['cols']);
	const rows = columns && runSizeCommand('tput', ['lines']);

	if (!columns || !rows) {
		return undefined;
	}

	return toWindowSize(columns[0]!, rows[0]!);
};

/** Linux 的 `resize -u`（输出 `COLUMNS LINES` 两行）。 */
const readResize = (): WindowSize | undefined => {
	const values = runSizeCommand('resize', ['-u']);
	return values && values.length >= 2
		? toWindowSize(values[0]!, values[1]!)
		: undefined;
};

/** `$COLUMNS` / `$LINES`（上游 `terminal-size` 的第二优先级）。 */
const readEnv = (): WindowSize | undefined => {
	const columns = Number(process.env.COLUMNS);
	const rows = Number(process.env.LINES);

	return Number.isFinite(columns) &&
		columns > 0 &&
		Number.isFinite(rows) &&
		rows > 0
		? {columns, rows}
		: undefined;
};

/**
与上游 `terminal-size` 相同的优先级：stderr → 环境变量 → 平台各自的能力。
自己重写而不是继续用它，唯一原因就是它的 devTty 泄漏 fd（见 `fallbackSize` 的注释）。
*/
const computeFallbackSize = (): WindowSize => {
	if (process.stderr.columns && process.stderr.rows) {
		return {columns: process.stderr.columns, rows: process.stderr.rows};
	}

	const envSize = readEnv();
	if (envSize) {
		return envSize;
	}

	let size: WindowSize | undefined;
	if (process.platform === 'win32') {
		size = readTput();
	} else if (process.platform === 'darwin') {
		size = readDevTty() ?? readTput();
	} else {
		size = readDevTty() ?? readTput() ?? readResize();
	}

	return size ?? defaultSize;
};

/**
Get the effective terminal dimensions from the given stdout stream.

`stdout.columns`/`rows` 为 0 或 undefined 时（非 TTY、PTY 0×0）走兜底；
兜底在每个进程里只计算一次（P14），拿不到时用标准的 80×24。
*/
export const getWindowSize = (
	stdout: NodeJS.WriteStream,
): {columns: number; rows: number} => {
	// `stdout.columns`/`rows` can be 0 or undefined in non-TTY environments.
	const {columns, rows} = stdout;

	if (columns && rows) {
		return {columns, rows};
	}

	fallbackSize ??= computeFallbackSize();

	return {
		columns: columns || fallbackSize.columns,
		rows: rows || fallbackSize.rows,
	};
};

/** 测试用：清掉兜底缓存（同一进程只算一次，跨用例换环境时先重置）。 */
export const resetWindowSizeFallbackForTests = (): void => {
	fallbackSize = undefined;
};
