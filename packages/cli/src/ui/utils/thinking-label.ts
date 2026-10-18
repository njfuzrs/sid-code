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

/** 无独立开关族（kimi / gpt-5.x / grok / o 系 / 未知族）的提示：说清楚由什么控制。 */
export const NO_TOGGLE_NOTE =
  "当前模型没有独立的思考开关，推理深度由 /effort 控制（思考行为由模型自身决定）。";

/** 恒思考模型（Opus 5.5 / Sonnet 5.5 / Fable / Mythos / GLM-5.3 等）关闭时的提示。 */
export const LOCKED_ON_NOTE =
  "⚠ 当前模型恒思考，服务端不接受关闭，本模型上仍会思考；切到可关闭思考的模型后 off 自动生效。";

/**
 * 「用户想关、当前模型关不掉」时该给的提示；无需提示返回 null。
 *
 * 切模型（R7）与启动期 env / settings 为 off（R8）共用这一个判定，/think 回执也读同一组文案，
 * 三处说法不分叉。只看 off：on / auto 在 locked-on 上与实际一致，在 none 族上状态栏已显示
 * `by-model`，不算「意图被覆盖」。
 */
export function thinkingIntentOverriddenNote(
  control: ThinkingControl,
  intent: "on" | "off" | "auto",
): string | null {
  if (intent !== "off") return null;
  if (control === "locked-on") return LOCKED_ON_NOTE;
  if (control === "none") return NO_TOGGLE_NOTE;
  return null;
}
