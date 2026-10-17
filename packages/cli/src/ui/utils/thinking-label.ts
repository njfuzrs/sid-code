/**
 * 思考开关的展示词：Footer thinking 列与 /think 面板的**唯一事实源**。
 *
 * 为什么只用词、不用字形：此前 Footer 只渲染 ✻ / ✧ 两个相近字形，auto 态不上色，
 * 用户把「auto 解析为开」的灰色 ✻ 读成了「关」（实测会话 20261018-001308-45d2c40b，
 * 请求体是 thinking enabled + effort max，而用户以为已关）。词是自解释的，颜色只做强调。
 *
 * 为什么面板也必须走这里：面板写「auto → on」、Footer 写另一套符号，两处说法一换就对不上。
 * 面板每个选项后面显示的「→ xxx」就是选它之后 Footer 会显示的词，两处用同一个函数算。
 *
 * 词表（6 种状态）：
 * - `on` / `off`             用户显式开 / 关
 * - `auto·on` / `auto·off`   跟随模型默认，当前解析结果
 * - `always`                 恒思考模型（关不掉）；意图是 off 时用警告色，提示设置在本模型上无效
 * - `by-model`               无独立开关（推理由模型自身 + /effort 决定）
 */
import type { ThinkingControl, ThinkingSetting } from "@sid-code/core/llm/effort.ts";

/** 语义色调：active = 实际在思考（亮色），muted = 灰，warn = 设置未生效 */
export type ThinkingTone = "active" | "muted" | "warn";

export interface ThinkingLabelInput {
  /** 服务端实际是否思考（resolveThinkingState().effective） */
  on: boolean;
  /** 是否 auto 态（跟随默认） */
  isAuto: boolean;
  /** 控制形态，缺省按 toggle */
  control?: ThinkingControl;
  /** 用户意图；locked-on 下 intent=off 时转警告色 */
  intent?: "on" | "off" | "auto";
}

export function thinkingLabel(s: ThinkingLabelInput): { text: string; tone: ThinkingTone } {
  const control = s.control ?? "toggle";
  if (control === "locked-on") {
    return { text: "always", tone: s.intent === "off" ? "warn" : "active" };
  }
  if (control === "none") {
    return { text: "by-model", tone: "muted" };
  }
  const v = s.on ? "on" : "off";
  // 规则只有一条：实际在思考就亮色，不管是不是 auto——「开 / 关」靠颜色一眼可分，auto 靠词。
  return { text: s.isAuto ? `auto·${v}` : v, tone: s.on ? "active" : "muted" };
}

/**
 * 某个 /think 选项被选中后 Footer 会显示的词（面板「→ xxx」预览用）。
 * 解析口径与 core `resolveThinkingState` 一致：locked-on 恒开，auto 取模型默认。
 */
export function thinkingLabelForSetting(
  cap: { thinkingControl: ThinkingControl; thinkingDefaultOn: boolean },
  setting: ThinkingSetting,
): { text: string; tone: ThinkingTone } {
  const intent = setting ?? "auto";
  const on =
    cap.thinkingControl === "locked-on"
      ? true
      : intent === "auto"
        ? cap.thinkingDefaultOn
        : intent === "on";
  return thinkingLabel({ on, isAuto: intent === "auto", control: cap.thinkingControl, intent });
}
