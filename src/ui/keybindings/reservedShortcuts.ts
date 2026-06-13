/**
 * 保留键保护 — K3
 *
 * 某些按键在终端/应用语义里有不可让渡的含义，禁止用户在 keybindings.json 里
 * 重新绑定到别的 action（否则会让 CLI 失去"逃生通道"或破坏终端约定）。
 *
 * 对标 claude-code 的 reservedShortcuts：保护 Ctrl+C（退出/中断）、回车、Tab 等。
 *
 * 设计：
 * - 用 Keystroke 归一化签名（strokeSignature）做集合判定，与 chord.ts 的匹配语义一致。
 * - 保留 ≠ 不能用，而是"不能被用户重绑到其它 action"。系统默认绑定仍可使用这些键。
 */

import type { Keystroke } from "./chord.ts";

/**
 * 把一个 Keystroke 归一化为稳定签名串，用于 Set/Map 去重与冲突判定。
 * 修饰键顺序固定为 C(trl) / S(hift) / A(lt) / M(eta，即 cmd)，name 小写。
 */
export function strokeSignature(stroke: Keystroke): string {
  const mods =
    `${stroke.ctrl ? "C" : ""}` +
    `${stroke.shift ? "S" : ""}` +
    `${stroke.alt ? "A" : ""}` +
    `${stroke.cmd ? "M" : ""}`;
  return `${mods}+${(stroke.name || "").toLowerCase()}`;
}

/**
 * 保留键清单。这些组合键禁止被用户重新绑定到非系统 action。
 *
 * 说明：
 * - Ctrl+C：退出/中断的唯一逃生通道，绝不能丢。
 * - enter / 裸 tab：终端基础语义（提交/补全），改了会让输入框不可用。
 * - Ctrl+D：EOF/退出语义，多数终端约定。
 */
export const RESERVED_STROKES: readonly Keystroke[] = [
  { ctrl: true, name: "c" },
  { ctrl: true, name: "d" },
  { name: "enter" },
  { name: "tab" },
];

/** 预计算的保留键签名集合（模块加载时一次性构建）。 */
const RESERVED_SIGNATURES: ReadonlySet<string> = new Set(
  RESERVED_STROKES.map(strokeSignature),
);

/**
 * 判断某个 stroke 是否为保留键。
 *
 * @param allowedActions 该 stroke 在默认表里本来就绑定的 action 列表。
 *   若用户把保留键绑回它原本的 action（如 Ctrl+C → app:quit），视为合法、不算违规。
 *   留空表示任何重绑都算违规。
 */
export function isReservedStroke(stroke: Keystroke): boolean {
  return RESERVED_SIGNATURES.has(strokeSignature(stroke));
}
