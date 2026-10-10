/**
 * 终端标题（B9 / T7.2a，契约 O1）。
 *
 * 规则来自黑盒对拍旧底座（D-5，没读旧代码）：
 * - `null` 不写；其余先去 ANSI（`strip-ansi`，对拍样本逐字一致：CSI / OSC 8 / C1 CSI 都去掉，
 *   孤立 ESC、DCS 原样留下），空串照样写。
 * - 先 OSC 2 再 OSC 0，终止符随终端（kitty 用 ST）；**不经** tmux / screen 包裹（tmux 自己转标题）。
 * - 直接写渲染所用的 stdout，不擦屏重绘、非 TTY 也写；同一值重渲不重写（按值做依赖）。
 * - Windows 不写序列，改写 `process.title`（conhost 不认 OSC 2/0）。
 * - 卸载时什么也不写，标题留在终端上。
 */
import process from 'node:process';
import {useContext, useEffect} from 'react';
import stripAnsi from 'strip-ansi';
import StdoutContext from '../components/StdoutContext.js';
import {OSC, osc} from '../terminal/osc.js';

export function useTerminalTitle(title: string | null): void {
	const {stdout} = useContext(StdoutContext);
	useEffect(() => {
		if (title === null) return;
		const clean = stripAnsi(title);
		if (process.platform === 'win32') {
			process.title = clean;
			return;
		}

		stdout.write(osc(OSC.SET_TITLE, clean) + osc(OSC.SET_TITLE_AND_ICON, clean));
	}, [title, stdout]);
}
