import {wrapText as wrapTextColumns} from './text/truncate.js';
import {type Styles} from './styles.js';

const cache: Record<string, string> = {};

// sid-code（B9 / T2.1）：换行与截断改走 text/truncate.ts，语义对齐旧底座（契约 T2），见 UPSTREAM-DIFF.md
const wrapText = (
	text: string,
	maxWidth: number,
	wrapType: Styles['textWrap'],
): string => {
	const cacheKey = text + String(maxWidth) + String(wrapType);
	const cachedText = cache[cacheKey];

	if (cachedText) {
		return cachedText;
	}

	const wrappedText = wrapTextColumns(text, maxWidth, wrapType ?? 'wrap');
	cache[cacheKey] = wrappedText;

	return wrappedText;
};

export default wrapText;
