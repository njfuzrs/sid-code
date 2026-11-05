/**
 * 瞬态行的高度水位：出现过就占住，到「帧本来就在变高」的时刻才放掉。
 *
 * 为什么需要：主屏帧几乎恒超视口，帧一变矮就只能整帧重画全部历史（`2J 3J` + 整段 scrollback，
 * 长会话一次几百 KB，用户上翻的位置被拉回底部，见 packages/tui/src/frame/main-screen.ts 文件头）。
 * spinner 结束、工具完成提示 2s 后消失、Esc / Ctrl+O 提示、退出确认、状态提示这类行，
 * 一个回合里会反复出现 / 消失，消失那一帧就是一次整帧重画。占住它们的行，帧就不会因此变矮。
 *
 * 放掉的时刻有两个（任一满足即回落到当前行数）：
 * 1. **下一轮开始**（busy 上升沿）：用户消息进历史、spinner 出现，帧本来在变高；
 * 2. **历史区新增一项**（`HeldRowsContext.epoch` 变化）：新的工具组 / 消息进历史，帧同样在变高。
 *    只有第 1 条时，回合中途出现过一次的提示会以空行形式占到回合结束——
 *    它在 `gap={1}` 的留白区里一行空占位 = 1 行空白 + 1 行 gap，一个长回合里一直挂着两三行
 *    莫名其妙的空白（2026-11-04 用户截图：「思考中」与 spinner 之间 3 行、Todo 与 spinner 之间 4 行）。
 *    代价：放掉的行数比历史新增的行数多时，那一帧仍是一次整帧重画；但这只发生在「本回合确实
 *    出现过瞬态行」之后，且一次就清零，换掉的是持续整个回合的空白。
 *
 * 3. **空闲时不占**（`releaseWhenIdle`，输入框上方的瞬态块用）：回合已结束，没有「下一帧本来就在变高」
 *    的时刻可等，占住就是一直挂在最后一条消息与输入框之间的空白，直到用户再发消息
 *    （2026-11-05 用户截图：空闲时 Ctrl+O 提示 3s 后消失，留下 1 行占位 + 1 行 gap）。
 *    代价：空闲时这类提示消失那一帧是一次整帧重画。「界面不留空白」优先（用户定），
 *    且空闲时提示消失是低频事件。输入框内部、输入框下方的退出警告不受影响（高频交互零重画门禁锁着它们）。
 *
 * 全屏（alt-buffer）布局高度固定、不会整帧重画，占位只浪费空间：`enabled=false` 时直接返回 rows。
 *
 * 用法：组件按当前内容算出 `rows`，用返回值作为最少占用行数（不足的用空行补）。
 * 纯渲染期计算（ref），不触发额外渲染：多一帧「先缩再撑回」正是要避免的。
 */
import { createContext, useContext, useRef } from "react";

export interface HeldRowsPolicy {
  /** 是否占住行高（主屏 true；全屏 false） */
  enabled: boolean;
  /** 释放纪元：变化即放掉水位。主屏传历史项数，新的一项进历史时帧本来就在变高 */
  epoch: number;
}

/** 默认值与引入本 context 之前的行为一致（占住、只在 busy 上升沿放掉），单测不包 Provider 也成立。 */
export const HeldRowsContext = createContext<HeldRowsPolicy>({ enabled: true, epoch: 0 });

export function useHeldRowsPolicy(): HeldRowsPolicy {
  return useContext(HeldRowsContext);
}

/**
 * 纯规则（不含 hook），供 InputArea 那种「同一渲染里按分支调用」的地方复用。
 * state 由调用方用 ref 持有。
 */
export interface HeldRowsState {
  held: number;
  prevBusy: boolean;
  prevEpoch: number;
}

export interface HeldRowsOptions {
  /** 空闲（busy=false）时不占位，见文件头第 3 条。输入框上方的瞬态块传 true */
  releaseWhenIdle?: boolean;
}

export function nextHeldRows(
  state: HeldRowsState,
  rows: number,
  busy: boolean,
  policy: HeldRowsPolicy,
  opts: HeldRowsOptions = {},
): number {
  const release =
    !policy.enabled ||
    (busy && !state.prevBusy) ||
    policy.epoch !== state.prevEpoch ||
    (!!opts.releaseWhenIdle && !busy);
  if (release || rows > state.held) state.held = rows;
  state.prevBusy = busy;
  state.prevEpoch = policy.epoch;
  return state.held;
}

export function useHeldRows(rows: number, busy: boolean, opts?: HeldRowsOptions): number {
  const policy = useHeldRowsPolicy();
  const state = useRef<HeldRowsState>({ held: rows, prevBusy: busy, prevEpoch: policy.epoch });
  return nextHeldRows(state.current, rows, busy, policy, opts);
}
