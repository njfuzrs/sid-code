/**
 * sid-code（B9 / T5.1d，契约 I5）：把 stdin 里已缓冲的字节读掉丢弃，供退出前调用（cli.ts），
 * 免得残留的鼠标 / 按键字节在进程退出后被 shell 当成命令行输入。
 *
 * 规则全部来自旧底座黑盒探针（不读旧代码，D-5）：
 * - 非 TTY stdin 不动（管道输入可能还有下游要读）；
 * - 循环 `read()` 直到返回 null；暂停态下挂着 `data` 监听的照样会收到这些字节（`read()` 本身的语义）；
 * - 读完后，原本不在 raw mode 的要 `setRawMode(true)` 再 `setRawMode(false)` 走一遍；原本在 raw mode 的不碰；
 * - 不经 fd 直读（旧底座对 fd 上未进流缓冲的字节不读）；任何一步抛错都吞掉，退出路径上不能再抛。
 */
export default function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
	if (!stdin.isTTY) {
		return;
	}

	try {
		while (stdin.read() !== null) {
			// 丢弃
		}
	} catch {}

	if (stdin.isRaw) {
		return;
	}

	try {
		stdin.setRawMode(true);
	} catch {}

	try {
		stdin.setRawMode(false);
	} catch {}
}
