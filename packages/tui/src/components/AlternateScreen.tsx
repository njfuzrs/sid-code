import React, {type PropsWithChildren, useInsertionEffect} from 'react';
import instances from '../instances.js';
import useStdout from '../hooks/use-stdout.js';
import useWindowSize from '../hooks/use-window-size.js';
import {
	disableMouseTracking,
	enableMouseTracking,
	enterAltScreen,
	exitAltScreen,
} from '../terminal/modes.js';
import Box from './Box.js';

export type Props = {
	/** 进 alt-screen 时打开鼠标跟踪全套，离开时关掉。默认开 */
	readonly mouseTracking?: boolean;
};

/**
 * sid-code（B9 / T6.1a，契约 M1 / R14）：把子树画在终端的 alt-screen 上。
 *
 * 规则来自黑盒对拍旧底座：
 * - 挂载时（insertion effect，早于本次提交的出帧）直写 `?1049h 2J H`，`mouseTracking` 为真再写鼠标跟踪全套；
 *   卸载时先关鼠标（开过才关）再 `?1049l`。不经帧输出，非 TTY 也照写；
 * - 子树放进一个高 = 视口行数、宽 = 视口宽的纵向容器，超出视口的内容在出帧时裁掉（alt-screen 没有 scrollback）；
 * - 挂载 / 卸载各通知实例一次 `setAltScreenActive`，嵌套或并列多个时**后写的赢**（与旧底座一致，不做计数）；
 * - `mouseTracking` 变化等于「卸载再挂载」：关鼠标、`?1049l`，再 `?1049h 2J H`（+ 鼠标），下一帧整帧重画。
 *
 * 和旧底座一处有意的不同：通知的是**渲染到同一个 stdout 的实例**。旧底座找的是 `process.stdout` 上的实例，
 * 渲染到别的流时 alt 状态没人知道，出帧仍走主屏 diff（CLI 只用 `process.stdout`，生产上看不出差别）。
 */
export default function AlternateScreen({
	children,
	mouseTracking = true,
}: PropsWithChildren<Props>) {
	const {stdout} = useStdout();
	const {rows} = useWindowSize();

	useInsertionEffect(() => {
		const ink = instances.get(stdout);
		write(stdout, enterAltScreen + (mouseTracking ? enableMouseTracking : ''));
		ink?.setAltScreenActive(true, mouseTracking);
		return () => {
			ink?.setAltScreenActive(false);
			write(stdout, (mouseTracking ? disableMouseTracking : '') + exitAltScreen);
		};
	}, [stdout, mouseTracking]);

	return (
		<Box flexDirection="column" width="100%" height={rows} flexShrink={0}>
			{children}
		</Box>
	);
}

// 卸载时流可能已经关了：尽力写，不抛
function write(stdout: NodeJS.WriteStream, data: string): void {
	try {
		stdout.write(data);
	} catch {}
}
