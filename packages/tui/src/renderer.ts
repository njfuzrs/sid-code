import renderNodeToOutput, {
	renderNodeToScreenReaderOutput,
} from './render-node-to-output.js';
import Output from './output.js';
import {type DOMElement} from './dom.js';
import {type Screen} from './screen/screen.js';

type Result = {
	output: string;
	outputHeight: number;
	staticOutput: string;
	/**
	 * sid-code（B9 / T3.1）：动态区的 cell 级屏幕缓冲，`output` 是它的纯文本形态。
	 * 帧 diff（T3.2）比它而不是比字符串。读屏模式下没有屏幕（输出是线性文本）。
	 */
	screen?: Screen;
};

/**
 * sid-code（B9 / T3.4，契约 P3）：`withText = false` 时不生成纯文本 `output`（返回空串）。
 * TTY 交互路径只比屏幕缓冲，纯文本是整屏再走一遍序列化，历史越长越贵，却没人读。
 */
const renderer = (
	node: DOMElement,
	isScreenReaderEnabled: boolean,
	withText = true,
): Result => {
	if (node.yogaNode) {
		if (isScreenReaderEnabled) {
			const output = renderNodeToScreenReaderOutput(node, {
				skipStaticElements: true,
			});

			const outputHeight = output === '' ? 0 : output.split('\n').length;

			let staticOutput = '';

			if (node.staticNode) {
				staticOutput = renderNodeToScreenReaderOutput(node.staticNode, {
					skipStaticElements: false,
				});
			}

			return {
				output,
				outputHeight,
				staticOutput: staticOutput ? `${staticOutput}\n` : '',
			};
		}

		const output = new Output({
			width: node.yogaNode.getComputedWidth(),
			height: node.yogaNode.getComputedHeight(),
		});

		renderNodeToOutput(node, output, {
			skipStaticElements: true,
		});

		let staticOutput;

		if (node.staticNode?.yogaNode) {
			staticOutput = new Output({
				width: node.staticNode.yogaNode.getComputedWidth(),
				height: node.staticNode.yogaNode.getComputedHeight(),
			});

			renderNodeToOutput(node.staticNode, staticOutput, {
				skipStaticElements: false,
			});
		}

		const screen = output.getScreen();
		const {output: generatedOutput, height: outputHeight} = withText
			? output.get(screen)
			: {output: '', height: output.height};

		return {
			output: generatedOutput,
			outputHeight,
			screen,
			// Newline at the end is needed, because static output doesn't have one, so
			// interactive output will override last line of static output
			staticOutput: staticOutput ? `${staticOutput.get().output}\n` : '',
		};
	}

	return {
		output: '',
		outputHeight: 0,
		staticOutput: '',
	};
};

export default renderer;
