/**
 * tab 状态点（B9 / T7.2a，契约 O2）：OSC 21337，iTerm2 / ghostty 等在 tab 上画一个彩色圆点。
 *
 * 规则来自黑盒对拍旧底座（D-5，没读旧代码）：
 * - 三种状态的字段固定（见 `TAB_STATUS_FIELDS`）；`null` 写一条三个字段全空的清除序列，
 *   但只在之前写过状态时写（一开始就是 `null` 不写）。
 * - `SID_DISABLE_TAB_STATUS` 非空（含 `0`、`true`、空格）即关闭，**每次状态变化时**读；
 *   关闭期间什么都不写，也不记账，重新打开后下一次变化照常写。
 * - 序列终止符随终端，再按 tmux / screen 包裹（与标题不同：tmux 不转发私有 OSC）。
 * - 同一值重渲不重写；组件卸载时不写（进程退出时的清除由 Ink 卸载序列负责，见 ink.tsx）。
 */
import process from 'node:process';
import {useContext, useEffect, useRef} from 'react';
import StdoutContext from '../components/StdoutContext.js';
import {OSC, osc, wrapForMultiplexer} from '../terminal/osc.js';

export type TabStatusKind = 'idle' | 'busy' | 'waiting';

const TAB_STATUS_FIELDS: Record<
	TabStatusKind,
	{indicator: string; status: string; statusColor: string}
> = {
	busy: {indicator: '#ff9500', status: 'Working…', statusColor: '#ff9500'},
	idle: {indicator: '#00d75f', status: 'Idle', statusColor: '#888888'},
	waiting: {indicator: '#5f87ff', status: 'Waiting', statusColor: '#5f87ff'},
};

export function isTabStatusDisabled(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env['SID_DISABLE_TAB_STATUS']);
}

/** 拼一条 tab 状态序列（已按多路复用器包裹）；`null` 得到清除序列。 */
export function tabStatusSequence(kind: TabStatusKind | null): string {
	const f = kind ? TAB_STATUS_FIELDS[kind] : {indicator: '', status: '', statusColor: ''};
	return wrapForMultiplexer(
		osc(
			OSC.TAB_STATUS,
			`indicator=${f.indicator}`,
			`status=${f.status}`,
			`status-color=${f.statusColor}`,
		),
	);
}

export function useTabStatus(kind: TabStatusKind | null): void {
	const {stdout} = useContext(StdoutContext);
	const written = useRef<TabStatusKind | null>(null);
	useEffect(() => {
		if (isTabStatusDisabled()) return;
		if (kind === null && written.current === null) return;
		stdout.write(tabStatusSequence(kind));
		written.current = kind;
	}, [kind, stdout]);
}
