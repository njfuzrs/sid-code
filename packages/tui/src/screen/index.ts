/** cell 级屏幕缓冲（B9 / T3.1）：缓冲、样式 / 超链接池、序列化。 */
export {CellWidth, Screen} from './screen.js';
export {
	HyperlinkPool,
	hyperlinkId,
	hyperlinkPool,
	StylePool,
	stylePool,
} from './pools.js';
export {
	needsWidthCompensation,
	screenToString,
	serializeRow,
	serializeScreen,
} from './serialize.js';
