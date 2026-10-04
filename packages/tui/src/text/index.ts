/** 文本工具（B9 / 阶段 2）：宽度、切片、换行与截断、bidi。都是纯函数，不依赖渲染核心。 */
export {stringWidth, widestLine} from './width.js';
export {sliceColumns} from './slice.js';
export {
	ELLIPSIS,
	truncate,
	type TruncatePosition,
	type WrapMode,
	wrapText,
} from './truncate.js';
export {reorderBidi, terminalNeedsSoftwareBidi} from './bidi.js';
