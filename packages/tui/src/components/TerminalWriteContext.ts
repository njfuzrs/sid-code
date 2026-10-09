/**
 * 原始终端写入口（B9 / T7.2b，契约 O3）。
 *
 * 给 CLI 写终端集成序列用（BEL、OSC 777 桌面通知、OSC 9;4 进度等）：值是 Ink 实例上一个
 * **身份稳定**的函数，直接写渲染所用的 stdout，不擦屏重绘、不等下一帧、非 TTY 也写。
 * 规则来自黑盒对拍旧底座（D-5）：同一实例重渲后取到的是同一个函数。
 * 身份必须稳定：依赖它的 effect 会在每次 resize 重渲时重跑。
 */
import {createContext} from 'react';

export type WriteRaw = (data: string) => void;

const TerminalWriteContext = createContext<WriteRaw | null>(null);

TerminalWriteContext.displayName = 'InternalTerminalWriteContext';

export default TerminalWriteContext;
