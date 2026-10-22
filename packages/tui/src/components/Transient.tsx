// sid-code：新写，上游没有等价物。主屏关闭对话框后的复原见 ink.tsx diffFrame 与 frame/main-screen.ts 文件头。
import {createElement, type ReactNode} from 'react';

export type Props = {
	readonly children?: ReactNode;
};

/**
 * 临时浮层（对话框、补全菜单这类「打开 → 关闭」的块）的容器。布局上就是一个竖排 Box，
 * 只多一个节点标记：主屏帧 diff 看到「上一帧有浮层、这一帧没有、帧变矮、上一帧已溢出视口」时
 * 整帧重画，而不是补空行——浮层打开时顶进 scrollback 的历史行拉不回来，补空行会在关闭后留下
 * 一整块与浮层等高的空白。
 *
 * 标记走 props（createInstance 时就在节点上），不走 ref：ref 在 commit 的 layout 阶段才挂，
 * 打开浮层的那一帧可能已经出了，帧层就会漏记「这一帧有浮层」。
 */
export default function Transient({children}: Props) {
	return createElement(
		'ink-box',
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_transient: true,
			// 与 <Box flexDirection="column"> 的默认样式一致，包一层不改排版
			style: {
				flexWrap: 'nowrap',
				flexDirection: 'column',
				flexGrow: 0,
				flexShrink: 1,
				overflowX: 'visible',
				overflowY: 'visible',
			},
		},
		children,
	);
}
