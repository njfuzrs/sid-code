// sid-code（B9 / T4.3，契约 L4）：新写。规则来自黑盒对拍旧底座，没有读旧代码。
import {type DOMElement} from '../dom.js';
import measureElement from '../measure-element.js';

export type BoundingBox = {x: number; y: number; width: number; height: number};

/**
 * 节点在整棵布局树里的绝对位置与尺寸：沿父链累加 yoga 的 left / top（含负 margin，不按滚动位置修正）。
 * ScrollProvider 拿它和鼠标坐标比，判断点在哪个滚动区里。
 *
 * 对拍得出的边界：参数为空，或节点已从树上移除（没有 yoga 节点），返回 `null`，不抛。
 */
export function getBoundingBox(node: DOMElement | null | undefined): BoundingBox | null {
	if (!node?.yogaNode) {
		return null;
	}

	const {x, y, width, height} = measureElement(node);
	return {x, y, width, height};
}
