/**
 * 思考开关展示词：Footer 与 /think 面板共用的事实源（utils/thinking-label.ts）。
 * 锁两件事：①6 种状态各一个可区分的词；②面板预览（选某项后显示什么）与 Footer 实际显示同口径。
 */
import { describe, expect, test } from "bun:test";
import { thinkingLabel, thinkingLabelForSetting } from "@sid-code/cli/ui/utils/thinking-label.ts";
import {
  resolveThinkingState,
  type ThinkingControl,
  type ThinkingSetting,
} from "@sid-code/core/llm/effort.ts";

describe("thinkingLabel", () => {
  test("6 种状态的词两两不同", () => {
    const words = [
      thinkingLabel({ on: true, isAuto: false }).text,
      thinkingLabel({ on: false, isAuto: false }).text,
      thinkingLabel({ on: true, isAuto: true }).text,
      thinkingLabel({ on: false, isAuto: true }).text,
      thinkingLabel({ on: true, isAuto: true, control: "locked-on" }).text,
      thinkingLabel({ on: false, isAuto: true, control: "none" }).text,
    ];
    expect(new Set(words).size).toBe(6);
  });

  test("always：意图 off → warn，其余 → active", () => {
    expect(
      thinkingLabel({ on: true, isAuto: false, control: "locked-on", intent: "off" }).tone,
    ).toBe("warn");
    expect(
      thinkingLabel({ on: true, isAuto: true, control: "locked-on", intent: "auto" }).tone,
    ).toBe("active");
  });
});

describe("thinkingLabelForSetting 与 Footer 同口径", () => {
  // Footer 的输入来自 app.ts pushKnobDisplay → resolveThinkingState；面板预览走 thinkingLabelForSetting。
  // 两条路径对同一 (cap, setting) 必须给出同一个词，否则面板说一套、Footer 显示另一套。
  const controls: ThinkingControl[] = ["toggle", "locked-on", "none"];
  const settings: ThinkingSetting[] = ["on", "off", undefined];
  for (const control of controls) {
    for (const defOn of [true, false]) {
      for (const setting of settings) {
        test(`${control} / defaultOn=${defOn} / ${setting ?? "auto"}`, () => {
          const cap = { thinkingControl: control, thinkingDefaultOn: defOn };
          const st = resolveThinkingState(cap as never, setting, null);
          const footer = thinkingLabel({
            on: st.effective,
            isAuto: st.intent === "auto",
            control: st.control,
            intent: st.intent,
          });
          expect(thinkingLabelForSetting(cap, setting)).toEqual(footer);
        });
      }
    }
  }
});
