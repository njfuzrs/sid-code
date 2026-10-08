/**
 * sid-code（B9 / T5.2b，契约 I2）：终端探查（XTVERSION `ESC[>0q` + DA1 `ESC[c`）。
 *
 * 规则全部来自旧底座黑盒探针（不读旧代码，D-5）：
 * - 时机：raw mode 引用计数每次从 0 变 1、以及 Ctrl+Z 恢复时计数仍 > 0，各排一次；
 *   用 `setImmediate` 推迟（调用返回时、微任务里都还没写），两段分两次 `write`；
 * - 抑制在**排队时**判定：排队后再 `setSuppressTerminalProbe(true)` 照样发；抑制期间排队的，解除抑制后也不补发；
 * - 排了就发：中途卸载、`detachForShutdown`、stdout 变成非 TTY 都不取消；连续开关几次就发几次；
 * - 回复由输入解析器当终端回复丢弃（I3），底座不等回复、没有超时重发，结果不交给任何人。
 *
 * 抑制开关是进程级的（同一进程里所有实例共用），会话选择器这类短命实例挂载前置真、卸载后置假。
 */
let suppressed = false;

export function setSuppressTerminalProbe(value: boolean): void {
	suppressed = value;
}

export const TERMINAL_PROBE = ['\u001B[>0q', '\u001B[c'] as const;

export function scheduleTerminalProbe(stdout: NodeJS.WriteStream): void {
	if (suppressed) {
		return;
	}

	setImmediate(() => {
		for (const sequence of TERMINAL_PROBE) {
			try {
				stdout.write(sequence);
			} catch {}
		}
	});
}
