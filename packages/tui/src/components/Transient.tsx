// sid-code：新写，上游没有等价物。主屏关闭对话框后的复原见 ink.tsx diffFrame 与 frame/main-screen.ts 文件头。
import {createElement, type ReactNode} from 'react';

export type Props = {
	readonly children?: ReactNode;
	/**
	 * sid-code（长会话按键延迟 PR4）：帧已溢出视口时改为叠画在上方的历史行上，不占帧内高度。
	 * 只给「矮、频繁开关」的浮层用（补全菜单）；对话框可能比视口还高，叠画放不下，保持在流布局。
	 * 何时叠画由底座出帧前按布局判定（ink.tsx `layoutFloatingTransients`），组件不需要知道帧高。
	 */
	readonly float?: boolean;
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
export default function Transient({children, float = false}: Props) {
	if (float) {
		// 外层是零高锚点（叠画时 height=0，落在浮层原本该在的位置），内层叠画时绝对定位、bottom 贴锚点：
		// 浮层占锚点之上的 h 行，也就是输入框正上方那几行历史。纯布局，不用二次 calculateLayout 推算位置
		return createElement(
			'ink-box',
			{
				// eslint-disable-next-line @typescript-eslint/naming-convention
				internal_transient: true,
				// eslint-disable-next-line @typescript-eslint/naming-convention
				internal_float: true,
				style: TRANSIENT_STYLE,
			},
			createElement('ink-box', {style: TRANSIENT_STYLE}, children),
		);
	}

	return createElement(
		'ink-box',
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_transient: true,
			style: TRANSIENT_STYLE,
		},
		children,
	);
}

// 与 <Box flexDirection="column"> 的默认样式一致，包一层不改排版
const TRANSIENT_STYLE = {
	flexWrap: 'nowrap',
	flexDirection: 'column',
	flexGrow: 0,
	flexShrink: 1,
	overflowX: 'visible',
	overflowY: 'visible',
} as const;
