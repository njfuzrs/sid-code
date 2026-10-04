// sid-code（B9 / T2.1）：列宽改走 text/width.ts（契约 T1），见 UPSTREAM-DIFF.md
import {widestLine} from './text/width.js';

const cache = new Map<string, Output>();

type Output = {
	width: number;
	height: number;
};

const measureText = (text: string): Output => {
	if (text.length === 0) {
		return {
			width: 0,
			height: 0,
		};
	}

	const cachedDimensions = cache.get(text);

	if (cachedDimensions) {
		return cachedDimensions;
	}

	const width = widestLine(text);
	const height = text.split('\n').length;
	const dimensions = {width, height};
	cache.set(text, dimensions);

	return dimensions;
};

export default measureText;
