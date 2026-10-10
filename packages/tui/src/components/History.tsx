// sid-code（B9 / T4.2，契约 R11，D-3 定案 A）：新写，替代上游 <Static> 在端口里的位置。
// 规则来自黑盒对拍旧底座（packages/cli/tests/render-port/history.test.tsx），没有读旧代码。
import React, {memo, type ReactNode} from 'react';
import Box, {type Props as BoxProps} from './Box.js';

export type Props<T> = {
	/** 历史项。引用不变且 `children` / `style` 引用也不变时，整块跳过重渲。 */
	readonly items: readonly T[];
	/** 容器样式，按 Box props 展开，覆盖默认的 `flexDirection: column`。 */
	readonly style?: BoxProps;
	/** 渲染一项；根元素必须带 `key`。第二个参数是该项在 `items` 里的下标。 */
	readonly children: (item: T, index: number) => ReactNode;
};

/**
 * 主屏的已完成历史区。**不是**上游 ink 的 print-once `<Static>`：
 * 这里的项是普通子树，内容变了照常 reconcile，靠帧 diff 让没变的行零写入、
 * 让滚进 scrollback 的历史自然留在终端里。执行中的工具项就放在这里，完成时原地变成终态。
 *
 * 取名 History 而不是 Static，是为了不让人按上游文档把它理解成「打印一次就忘」。
 *
 * 对拍得出的边界：
 * - 就是一个竖排 Box，参与正常布局（会被挤压、可放进横排容器、受父级高度约束）；
 * - memo 是**浅比较**：`items`、`children`、`style` 任一引用变了就整块重渲，
 *   所以调用方传内联渲染函数时每次父级重渲都会重渲全部历史项，代价落在 reconcile，不落在写屏；
 * - 不给子项补 key，也不去重。
 */
function History<T>({items, style, children}: Props<T>) {
	return (
		<Box flexDirection="column" {...style}>
			{items.map((item, index) => children(item, index))}
		</Box>
	);
}

export default memo(History) as typeof History;
