/**
 * 瞬态行的高度水位：出现过就占住，到下一轮开始（busy 上升沿）才放掉。
 *
 * 为什么需要：主屏帧几乎恒超视口，帧一变矮就只能整帧重画全部历史（`2J 3J` + 整段 scrollback，
 * 长会话一次几百 KB，用户上翻的位置被拉回底部，见 packages/tui/src/frame/main-screen.ts 文件头）。
 * spinner 结束、工具完成提示 2s 后消失、Esc / Ctrl+O 提示、退出确认、状态提示这类行，
 * 一个回合里会反复出现 / 消失，消失那一帧就是一次整帧重画。占住它们的行，帧就不会因此变矮；
 * 下一轮开始时用户消息与 spinner 本来就在让帧变高，那时放掉不会单独造成收缩。
 *
 * 用法：组件按当前内容算出 `rows`，用返回值作为最少占用行数（不足的用空行补）。
 * 纯渲染期计算（ref），不触发额外渲染：多一帧「先缩再撑回」正是要避免的。
 */
import { useRef } from "react";

export function useHeldRows(rows: number, busy: boolean): number {
  const held = useRef(rows);
  const prevBusy = useRef(busy);
  if (busy && !prevBusy.current) {
    held.current = rows;
  } else if (rows > held.current) {
    held.current = rows;
  }
  prevBusy.current = busy;
  return held.current;
}
