// sid-code（B9 / T4.1，契约 T5）：新写。上游没有等价物。
// 规则来自对拍旧底座首帧字节（tests/fixtures/screen-vectors.json 的 `RawAnsi *` 条目），没有读旧代码。
import {createElement, memo} from 'react';

export type Props = {
	/** 终端就绪的行：生产方已按 `width` 换好行，每个元素正好一行，ANSI 码内联。 */
	readonly lines: readonly string[];
	/** 生产方换行用的列宽，作为布局里这个叶子节点的固定宽度。 */
	readonly width: number;
};

/**
 * 已经是终端就绪内容时，跳过「解析 → 每段一个节点 → 布局 → 重新拼接」这一圈：整块内容是**一个**文本叶子，
 * 布局尺寸固定为 `width × lines.length`、不参与伸缩，渲染时不换行不截断，原样写进屏幕缓冲。
 *
 * 对拍得出的边界：
 * - `lines` 为空时不渲染，不占行也不占列；
 * - 尺寸只由 props 决定：行比 `width` 宽时照样写出去（同一行后面的兄弟会盖住多出的部分），
 *   行里混进 `\n` 时内容多占一行但布局高度不变；
 * - 非 SGR 的控制序列、非链接的 OSC 照常被清理掉（与 `<Text>` 共用同一道写入）。
 */
function RawAnsi({lines, width}: Props) {
	if (lines.length === 0) {
		return null;
	}

	// 用 createElement 而不是 JSX：根 tsconfig 下两套底座的 global.d.ts 都在声明 `ink-text`，
	// legacy 那份不认识 internal_raw（T9 删旧底座后可改回 JSX）
	return createElement(
		'ink-text',
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_raw: true,
			style: {flexGrow: 0, flexShrink: 0, width, height: lines.length},
		},
		lines.join('\n'),
	);
}

export default memo(RawAnsi);
