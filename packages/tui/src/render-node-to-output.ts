// sid-code（B9 / T2.1）：列宽改走 text/width.ts（契约 T1），见 UPSTREAM-DIFF.md
import {widestLine} from './text/width.js';
import indentString from 'indent-string';
import Yoga from 'yoga-layout';
import wrapText from './wrap-text.js';
import getMaxWidth from './get-max-width.js';
import squashTextNodes from './squash-text-nodes.js';
import renderBorder from './render-border.js';
import renderBackground from './render-background.js';
import {type DOMElement} from './dom.js';
import type Output from './output.js';
import {type Operation} from './output.js';

/**
 * sid-code（B9 / T3.4，契约 P3）：节点级输出缓存。一个子树自上次输出以来没改过（`renderDirty` 为假），
 * 且横坐标、尺寸、外层 transformer、是否跳过 Static 都没变，它产生的输出操作就和上次一样，只是可能整体
 * 上下挪了（上面插了一行）。这时直接回放上次的操作，不再遍历子树、不再读 yoga 布局。
 *
 * 为什么尺寸相同就够：子树内部的布局只取决于这个节点的内框尺寸和子树自身的样式 / 内容，后两者一改就会标脏。
 * 横坐标必须相同，因为 `\t` 对齐的是屏幕绝对列。
 */
type RenderCache = {
	x: number;
	y: number;
	width: number;
	height: number;
	skipStaticElements: boolean;
	transformers: OutputTransformer[];
	operations: Operation[];
};

/** 观测用（测试 P3 断言「每帧只走脏的子树」）：自进程启动以来真正遍历（未命中缓存）的节点数 */
export const renderStats = {walked: 0};

const sameTransformers = (
	a: OutputTransformer[],
	b: OutputTransformer[],
): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

// If parent container is `<Box>`, text nodes will be treated as separate nodes in
// the tree and will have their own coordinates in the layout.
// To ensure text nodes are aligned correctly, take X and Y of the first text node
// and use it as offset for the rest of the nodes
// Only first node is taken into account, because other text nodes can't have margin or padding,
// so their coordinates will be relative to the first node anyway
const applyPaddingToText = (node: DOMElement, text: string): string => {
	const yogaNode = node.childNodes[0]?.yogaNode;

	if (yogaNode) {
		const offsetX = yogaNode.getComputedLeft();
		const offsetY = yogaNode.getComputedTop();
		text = '\n'.repeat(offsetY) + indentString(text, offsetX);
	}

	return text;
};

export type OutputTransformer = (s: string, index: number) => string;

export const renderNodeToScreenReaderOutput = (
	node: DOMElement,
	options: {
		parentRole?: string;
		skipStaticElements?: boolean;
	} = {},
): string => {
	if (options.skipStaticElements && node.internal_static) {
		return '';
	}

	if (node.yogaNode?.getDisplay() === Yoga.DISPLAY_NONE) {
		return '';
	}

	let output = '';

	if (node.nodeName === 'ink-text') {
		output = squashTextNodes(node);
	} else if (node.nodeName === 'ink-box' || node.nodeName === 'ink-root') {
		const separator =
			node.style.flexDirection === 'row' ||
			node.style.flexDirection === 'row-reverse'
				? ' '
				: '\n';

		const childNodes =
			node.style.flexDirection === 'row-reverse' ||
			node.style.flexDirection === 'column-reverse'
				? [...node.childNodes].reverse()
				: [...node.childNodes];

		output = childNodes
			.map(childNode => {
				const screenReaderOutput = renderNodeToScreenReaderOutput(
					childNode as DOMElement,
					{
						parentRole: node.internal_accessibility?.role,
						skipStaticElements: options.skipStaticElements,
					},
				);
				return screenReaderOutput;
			})
			.filter(Boolean)
			.join(separator);
	}

	if (node.internal_accessibility) {
		const {role, state} = node.internal_accessibility;

		if (state) {
			const stateKeys = Object.keys(state) as Array<keyof typeof state>;
			const stateDescription = stateKeys.filter(key => state[key]).join(', ');

			if (stateDescription) {
				output = `(${stateDescription}) ${output}`;
			}
		}

		if (role && role !== options.parentRole) {
			output = `${role}: ${output}`;
		}
	}

	return output;
};

// After nodes are laid out, render each to output object, which later gets rendered to terminal
const renderNodeToOutput = (
	node: DOMElement,
	output: Output,
	options: {
		offsetX?: number;
		offsetY?: number;
		transformers?: OutputTransformer[];
		skipStaticElements: boolean;
	},
) => {
	const {
		offsetX = 0,
		offsetY = 0,
		transformers = [],
		skipStaticElements,
	} = options;

	if (skipStaticElements && node.internal_static) {
		return;
	}

	const {yogaNode} = node;

	if (yogaNode) {
		if (yogaNode.getDisplay() === Yoga.DISPLAY_NONE) {
			node.renderCache = undefined;
			return;
		}

		// Left and top positions in Yoga are relative to their parent node
		const x = offsetX + yogaNode.getComputedLeft();
		const y = offsetY + yogaNode.getComputedTop();
		const width = yogaNode.getComputedWidth();
		const height = yogaNode.getComputedHeight();

		const cache = node.renderCache as RenderCache | undefined;
		if (
			!node.renderDirty &&
			cache &&
			cache.x === x &&
			cache.width === width &&
			cache.height === height &&
			cache.skipStaticElements === skipStaticElements &&
			sameTransformers(cache.transformers, transformers)
		) {
			output.replay(cache.operations, y - cache.y);
			return;
		}

		const mark = output.mark();
		renderStats.walked++;
		renderLaidOutNode(node, output, x, y, transformers, skipStaticElements);
		node.renderCache = {
			x,
			y,
			width,
			height,
			skipStaticElements,
			transformers,
			operations: output.since(mark),
		} satisfies RenderCache;
		node.renderDirty = false;
	}
};

const renderLaidOutNode = (
	node: DOMElement,
	output: Output,
	x: number,
	y: number,
	transformers: OutputTransformer[],
	skipStaticElements: boolean,
): void => {
	const yogaNode = node.yogaNode!;
	{

		// Transformers are functions that transform final text output of each component
		// See Output class for logic that applies transformers
		let newTransformers = transformers;

		if (typeof node.internal_transform === 'function') {
			newTransformers = [node.internal_transform, ...transformers];
		}

		if (node.nodeName === 'ink-text') {
			let text = squashTextNodes(node);

			if (text.length > 0) {
				const currentWidth = widestLine(text);
				const maxWidth = getMaxWidth(yogaNode);

				// sid-code（B9 / T4.1）：RawAnsi 的内容已按列宽换好行，不再换行 / 截断（契约 T5）
				if (currentWidth > maxWidth && !node.attributes['internal_raw']) {
					const textWrap = node.style.textWrap ?? 'wrap';
					text = wrapText(text, maxWidth, textWrap);
				}

				text = applyPaddingToText(node, text);

				output.write(x, y, text, {transformers: newTransformers});
			}

			return;
		}

		let clipped = false;

		// sid-code（B9 / T4.3，契约 L3）：单轴取值优先于 `overflow`（`overflow="hidden" overflowY="visible"` 纵向不裁剪），
		// `scroll` 在本轴上与 `hidden` 一样裁剪；纵向 `scroll` 另走 renderScrollContent
		const overflowX = node.style.overflowX ?? node.style.overflow;
		const overflowY = node.style.overflowY ?? node.style.overflow;

		if (node.nodeName === 'ink-box') {
			renderBackground(x, y, node, output);
			renderBorder(x, y, node, output);

			const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll';
			const clipVertically = overflowY === 'hidden' || overflowY === 'scroll';

			if (clipHorizontally || clipVertically) {
				const x1 = clipHorizontally
					? x + yogaNode.getComputedBorder(Yoga.EDGE_LEFT)
					: undefined;

				const x2 = clipHorizontally
					? x +
						yogaNode.getComputedWidth() -
						yogaNode.getComputedBorder(Yoga.EDGE_RIGHT)
					: undefined;

				const y1 = clipVertically
					? y + yogaNode.getComputedBorder(Yoga.EDGE_TOP)
					: undefined;

				const y2 = clipVertically
					? y +
						yogaNode.getComputedHeight() -
						yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM)
					: undefined;

				output.clip({x1, x2, y1, y2});
				clipped = true;
			}
		}

		if (node.nodeName === 'ink-box' && overflowY === 'scroll') {
			renderScrollContent(node, output, x, y, newTransformers, skipStaticElements);
		} else if (node.nodeName === 'ink-root' || node.nodeName === 'ink-box') {
			for (const childNode of node.childNodes) {
				renderNodeToOutput(childNode as DOMElement, output, {
					offsetX: x,
					offsetY: y,
					transformers: newTransformers,
					skipStaticElements,
				});
			}
		}

		if (clipped) {
			output.unclip();
		}
	}
};

/**
 * sid-code（B9 / T4.3，契约 L3）：纵向 `overflow: scroll` 的内容。规则来自黑盒对拍旧底座，没有读旧代码。
 *
 * 只画**第一个子节点**（「内容盒」）的子项，所以首子是 Text 时什么都不画。内容盒自己的背景、边框、裁剪都不画，
 * 只当坐标原点用；它的每个子节点按「在内容盒里的纵向位置」和视口高度（滚动盒高度减去上下 padding 与边框）
 * 比较，与 `[0, 视口高)` 有交集才画，画就整个画（只受滚动盒自己的裁剪）。
 *
 * 判定故意不看内容盒在滚动盒里的偏移：CLI（VirtualizedList）用上下 spacer 和内容盒的负 `marginTop`
 * 表达滚动位置，旧底座始终按「滚动位置为 0」剔除，负 `marginTop` 滚上去的行由裁剪挡掉，
 * 底部因此会空出与偏移等高的行。这是对拍出的现行行为，照搬。
 */
const renderScrollContent = (
	node: DOMElement,
	output: Output,
	x: number,
	y: number,
	transformers: OutputTransformer[],
	skipStaticElements: boolean,
): void => {
	const content = node.childNodes[0] as DOMElement | undefined;
	const contentYoga = content?.yogaNode;
	// 首子是 Text 时它的子节点是没有 yoga 节点的文本，下面的循环自然一个都不画，不用单独判断
	if (
		!content ||
		!contentYoga ||
		contentYoga.getDisplay() === Yoga.DISPLAY_NONE ||
		(skipStaticElements && content.internal_static)
	) {
		return;
	}

	const yogaNode = node.yogaNode!;
	const viewport =
		yogaNode.getComputedHeight() -
		yogaNode.getComputedPadding(Yoga.EDGE_TOP) -
		yogaNode.getComputedPadding(Yoga.EDGE_BOTTOM) -
		yogaNode.getComputedBorder(Yoga.EDGE_TOP) -
		yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
	const contentX = x + contentYoga.getComputedLeft();
	const contentY = y + contentYoga.getComputedTop();
	const contentTransformers =
		typeof content.internal_transform === 'function'
			? [content.internal_transform, ...transformers]
			: transformers;

	for (const child of content.childNodes) {
		const childYoga = (child as DOMElement).yogaNode;
		if (!childYoga) {
			continue;
		}

		const top = childYoga.getComputedTop();
		if (top + childYoga.getComputedHeight() <= 0 || top >= viewport) {
			continue;
		}

		renderNodeToOutput(child as DOMElement, output, {
			offsetX: contentX,
			offsetY: contentY,
			transformers: contentTransformers,
			skipStaticElements,
		});
	}

	// 内容盒不走 renderNodeToOutput，自己的缓存永远不用；清掉脏标记，免得它一直挂着
	content.renderCache = undefined;
	content.renderDirty = false;
};

export default renderNodeToOutput;
