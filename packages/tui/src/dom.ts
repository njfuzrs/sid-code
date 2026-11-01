import Yoga, {type Node as YogaNode} from 'yoga-layout';
import measureText from './measure-text.js';
import {stringWidth} from './text/width.js';
import {type Styles} from './styles.js';
import wrapText from './wrap-text.js';
import squashTextNodes from './squash-text-nodes.js';
import {type OutputTransformer} from './render-node-to-output.js';

type InkNode = {
	parentNode: DOMElement | undefined;
	/**
	 * sid-code（B9 / T3.4，契约 P3）：自上次输出以来，这个节点或它的子树有没有改过（文本、子节点、样式、属性、
	 * transform、显隐）。改动一律向上标到根；干净的子树复用上一帧的输出操作（见 render-node-to-output.ts）。
	 */
	renderDirty?: boolean;
	yogaNode?: YogaNode;
	internal_static?: boolean;
	/** sid-code：History 的容器节点。主屏帧 diff 要知道历史区下沿，溢出后收缩时把空行补在那里（frame/main-screen.ts） */
	internal_history?: boolean;
	/** sid-code：Transient（临时浮层）的容器节点，见 components/Transient.tsx */
	internal_transient?: boolean;
	/** sid-code：可叠画的 Transient 锚点（`<Transient float>`）与它当前是否处于叠画态，见 ink.tsx `layoutFloatingTransients` */
	internal_float?: boolean;
	internal_floating?: boolean;
	style: Styles;
};

type LayoutListener = () => void;

export type TextName = '#text';
export type ElementNames =
	'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text';

export type NodeNames = ElementNames | TextName;

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMElement = {
	nodeName: ElementNames;
	attributes: Record<string, DOMNodeAttribute>;
	childNodes: DOMNode[];
	internal_transform?: OutputTransformer;

	internal_accessibility?: {
		role?:
			| 'button'
			| 'checkbox'
			| 'combobox'
			| 'list'
			| 'listbox'
			| 'listitem'
			| 'menu'
			| 'menuitem'
			| 'option'
			| 'progressbar'
			| 'radio'
			| 'radiogroup'
			| 'tab'
			| 'tablist'
			| 'table'
			| 'textbox'
			| 'timer'
			| 'toolbar';
		state?: {
			busy?: boolean;
			checked?: boolean;
			disabled?: boolean;
			expanded?: boolean;
			multiline?: boolean;
			multiselectable?: boolean;
			readonly?: boolean;
			required?: boolean;
			selected?: boolean;
		};
	};

	// Internal properties
	isStaticDirty?: boolean;
	staticNode?: DOMElement;
	// Tracks the previous commit's `staticNode` so the reconciler can detect identity changes (mount, unmount, key-driven remount) and reset `fullStaticOutput`.
	previousStaticNode?: DOMElement;
	/** sid-code（B9 / T3.4）：上一次输出这个子树时的操作与判定条件，见 render-node-to-output.ts */
	renderCache?: unknown;
	onComputeLayout?: () => void;
	onRender?: () => void;
	onImmediateRender?: () => void;
	/**
	 * sid-code：根节点上登记创建过的 Transient 容器。删除时 reconciler 只摘掉被删子树的顶层节点，
	 * 子孙不会逐个收到回调，所以这里不维护「当前挂着几个」，出帧时再按 parentNode 链判定是否仍挂在树上
	 * （hasMountedTransient），顺手剔掉已脱离的
	 */
	transientNodes?: Set<DOMElement>;
	onStaticChange?: () => void;
	internal_layoutListeners?: Set<LayoutListener>;
} & InkNode;

export type TextNode = {
	nodeName: TextName;
	nodeValue: string;
} & InkNode;

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNode<T = {nodeName: NodeNames}> = T extends {
	nodeName: infer U;
}
	? U extends '#text'
		? TextNode
		: DOMElement
	: never;

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNodeAttribute = boolean | string | number;

export const createNode = (nodeName: ElementNames): DOMElement => {
	const node: DOMElement = {
		nodeName,
		style: {},
		attributes: {},
		childNodes: [],
		parentNode: undefined,
		yogaNode: nodeName === 'ink-virtual-text' ? undefined : Yoga.Node.create(),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		internal_accessibility: {},
		renderDirty: true,
	};

	if (nodeName === 'ink-text') {
		node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node));
	}

	return node;
};

/** 根节点下是否还挂着 Transient 容器；顺手剔掉已经脱离树的登记（O(登记数 × 深度)，不遍历整棵树） */
/**
 * `inFlowOnly`：只算在流布局的浮层。叠画态（`<Transient float>` 且 `internal_floating`）不占帧高、没把历史顶进
 * scrollback，关闭时普通 diff 就能复原，不该触发 diffFrame 的整帧重画（PR4）。
 */
export const hasMountedTransient = (
	root: DOMElement,
	{inFlowOnly = false}: {inFlowOnly?: boolean} = {},
): boolean => {
	const nodes = root.transientNodes;
	if (!nodes || nodes.size === 0) {
		return false;
	}

	let mounted = false;
	for (const node of nodes) {
		let cur: DOMElement | undefined = node;
		while (cur && cur !== root) {
			cur = cur.parentNode;
		}

		if (cur === root) {
			if (!inFlowOnly || !node.internal_floating) {
				mounted = true;
			}
		} else {
			nodes.delete(node);
		}
	}

	return mounted;
};

/** 节点及其全部祖先标脏。不在中途停：被 `display: none` 跳过的子树可能留着脏标记而祖先已清，提前停会漏标。 */
export const markRenderDirty = (node?: DOMNode): void => {
	for (let cur: DOMNode | undefined = node; cur; cur = cur.parentNode) {
		cur.renderDirty = true;
	}
};

export const appendChildNode = (
	node: DOMElement,
	childNode: DOMElement,
): void => {
	if (childNode.parentNode) {
		removeChildNode(childNode.parentNode, childNode);
	}

	childNode.parentNode = node;
	node.childNodes.push(childNode);
	markRenderDirty(node);

	if (childNode.yogaNode) {
		node.yogaNode?.insertChild(
			childNode.yogaNode,
			node.yogaNode.getChildCount(),
		);
	}

	if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {
		markNodeAsDirty(node);
	}
};

export const insertBeforeNode = (
	node: DOMElement,
	newChildNode: DOMNode,
	beforeChildNode: DOMNode,
): void => {
	if (newChildNode.parentNode) {
		removeChildNode(newChildNode.parentNode, newChildNode);
	}

	newChildNode.parentNode = node;
	markRenderDirty(node);

	const index = node.childNodes.indexOf(beforeChildNode);
	if (index >= 0) {
		node.childNodes.splice(index, 0, newChildNode);
		if (newChildNode.yogaNode) {
			node.yogaNode?.insertChild(newChildNode.yogaNode, index);
		}
	} else {
		node.childNodes.push(newChildNode);

		if (newChildNode.yogaNode) {
			node.yogaNode?.insertChild(
				newChildNode.yogaNode,
				node.yogaNode.getChildCount(),
			);
		}
	}

	if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {
		markNodeAsDirty(node);
	}
};

export const removeChildNode = (
	node: DOMElement,
	removeNode: DOMNode,
): void => {
	if (removeNode.yogaNode) {
		removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode);
	}

	removeNode.parentNode = undefined;
	markRenderDirty(node);

	const index = node.childNodes.indexOf(removeNode);
	if (index >= 0) {
		node.childNodes.splice(index, 1);
	}

	if (node.nodeName === 'ink-text' || node.nodeName === 'ink-virtual-text') {
		markNodeAsDirty(node);
	}
};

export const setAttribute = (
	node: DOMElement,
	key: string,
	value: DOMNodeAttribute,
): void => {
	markRenderDirty(node);
	if (key === 'internal_accessibility') {
		node.internal_accessibility = value as DOMElement['internal_accessibility'];
		return;
	}

	node.attributes[key] = value;
};

export const setStyle = (node: DOMNode, style?: Styles): void => {
	// Rendering code assumes style is always an object.
	node.style = style ?? {};
	markRenderDirty(node);
};

export const createTextNode = (text: string): TextNode => {
	const node: TextNode = {
		nodeName: '#text',
		nodeValue: text,
		yogaNode: undefined,
		parentNode: undefined,
		style: {},
	};

	setTextNodeValue(node, text);

	return node;
};

const measureTextNode = function (
	node: DOMNode,
	width: number,
): {width: number; height: number} {
	const text =
		node.nodeName === '#text' ? node.nodeValue : squashTextNodes(node);

	const dimensions = measureText(text);

	// Text fits into container, no need to wrap
	if (dimensions.width <= width) {
		return dimensions;
	}

	// This is happening when <Box> is shrinking child nodes and Yoga asks
	// if we can fit this text node in a <1px space, so we just tell Yoga "no"
	if (dimensions.width >= 1 && width > 0 && width < 1) {
		return dimensions;
	}

	const textWrap = node.style?.textWrap ?? 'wrap';
	const wrappedText = wrapText(text, width, textWrap);
	const wrapped = measureText(wrappedText);

	// sid-code（B9 / T3.1，契约 T4）：换行后仍比可用宽度宽的行（宽字符被挤到 1 列、VS16 宽字符压在行尾），
	// 按 ceil(行宽 / 可用宽) 计行数，与基线的布局高度一致。多出来的行是空行：
	// 屏幕缓冲写不下的宽字符整个丢掉，不劈半
	if (width >= 1 && wrapped.width > width) {
		let height = 0;
		for (const line of wrappedText.split('\n')) {
			height += Math.max(1, Math.ceil(stringWidth(line) / width));
		}

		return {width: wrapped.width, height};
	}

	return wrapped;
};

const findClosestYogaNode = (node?: DOMNode): YogaNode | undefined => {
	if (!node?.parentNode) {
		return undefined;
	}

	return node.yogaNode ?? findClosestYogaNode(node.parentNode);
};

const markNodeAsDirty = (node?: DOMNode): void => {
	// Mark closest Yoga node as dirty to measure text dimensions again
	const yogaNode = findClosestYogaNode(node);
	yogaNode?.markDirty();
};

export const setTextNodeValue = (node: TextNode, text: string): void => {
	if (typeof text !== 'string') {
		text = String(text);
	}

	node.nodeValue = text;
	markNodeAsDirty(node);
	markRenderDirty(node);
};

export const addLayoutListener = (
	rootNode: DOMElement,
	listener: LayoutListener,
): (() => void) => {
	if (rootNode.nodeName !== 'ink-root') {
		return () => {};
	}

	rootNode.internal_layoutListeners ??= new Set();
	rootNode.internal_layoutListeners.add(listener);

	return () => {
		rootNode.internal_layoutListeners?.delete(listener);
	};
};

export const emitLayoutListeners = (rootNode: DOMElement): void => {
	if (rootNode.nodeName !== 'ink-root' || !rootNode.internal_layoutListeners) {
		return;
	}

	for (const listener of rootNode.internal_layoutListeners) {
		listener();
	}
};
