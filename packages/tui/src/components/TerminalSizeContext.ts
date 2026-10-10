/**
 * 终端尺寸 Context（B9 / T8.1d 人工矩阵发现）。
 *
 * CLI 的 `TerminalContext` 只读它拿宽高，再用 `width={termWidth}` 定死根 Box 宽度。
 * 底座不提供时 CLI 回落到 `stdout.columns`，而 resize 时 React 侧没有任何值变化、不触发重渲，
 * 于是根 Box 永远停在启动宽度：拖窄被截断、拖宽不跟。规则来自旧底座：值由底座在 render 时提供，
 * 尺寸变了才换新对象（身份稳定，避免下游 memo 白费）。
 */
import {createContext} from 'react';

export type TerminalSize = {
	readonly columns: number;
	readonly rows: number;
};

const TerminalSizeContext = createContext<TerminalSize | null>(null);

TerminalSizeContext.displayName = 'InternalTerminalSizeContext';

export default TerminalSizeContext;
