/**
 * N2：`schedule_wakeup` 注入的收尾指引
 *
 * ## 缺陷形态
 *
 * 唤醒只在本轮结束、会话空闲后注入（宿主 `enqueueScheduledPrompt`）。模型排完唤醒若留在
 * 本轮前台轮询，自己排的唤醒只能排队：`20261109-160803-fbb02831` 两次排完唤醒都在 1.5s
 * 后继续 `gh pr view`，第二个唤醒晚了 383s（`ScheduledFire.lag_ms = 383270`）。
 * 注入文本原先只有来源头（「这不是用户新输入的消息」），没有一句说「排完该结束本轮」。
 *
 * ## 三条不变量
 *
 * 1. 只有 `origin=schedule_wakeup` 加收尾指引 —— `/loop` 与 `cron_create` 是固定节奏的
 *    周期任务，加这句会诱导模型提前结束那一轮该做的事。
 * 2. 指引是**独立一行**（在来源头与 prompt 之间），不塞进来源头：header 是身份标记，
 *    `stripScheduledPromptHeader` 依赖它的精确形态。
 * 3. `strip` 必须把指引一起剥掉 —— 否则 TUI 的 preview 首行会变成 harness 的话，
 *    而不是用户自己安排的任务。同时要兼容旧格式（历史消息里没有指引行）。
 */
import { describe, it, expect } from "bun:test";
import {
  formatWakeupTurnGuidance,
  stripScheduledPromptHeader,
  withScheduledPromptHeader,
  type ScheduledPromptSource,
} from "@sid-code/core/query/scheduled-prompt.ts";

const WAKEUP: ScheduledPromptSource = { taskId: "f59edfba", origin: "schedule_wakeup" };
const LOOP: ScheduledPromptSource = { taskId: "l1", origin: "loop" };
const CRON: ScheduledPromptSource = { taskId: "c1", origin: "cron_create" };

describe("N2 唤醒收尾指引：内容", () => {
  it("中文文案说清「本轮结束才触发」并给出收尾动作", () => {
    const g = formatWakeupTurnGuidance("zh");
    expect(g).toContain("本轮结束");
    expect(g).toContain("结束本轮");
    expect(g).toContain("推迟");
  });

  it("英文偏好出英文文案", () => {
    const g = formatWakeupTurnGuidance("en");
    expect(g).toContain("current turn ends");
    expect(g).toContain("end this turn");
    expect(g).not.toContain("本轮结束");
  });

  it("auto / 缺省按中文（与 system-prompt 的既有判定一致）", () => {
    expect(formatWakeupTurnGuidance("auto")).toBe(formatWakeupTurnGuidance(undefined));
    expect(formatWakeupTurnGuidance("auto")).toContain("本轮结束");
  });
});

describe("N2 唤醒收尾指引：拼装范围", () => {
  it("schedule_wakeup 的注入文本是「来源头 / 指引 / prompt」三行", () => {
    const text = withScheduledPromptHeader("检查 CI 状态", WAKEUP, "zh");
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("定时唤醒");
    expect(lines[0]).toContain("不是用户新输入");
    expect(lines[1]).toBe(formatWakeupTurnGuidance("zh"));
    expect(lines[2]).toBe("检查 CI 状态");
  });

  it("loop / cron_create 不追加指引（周期任务不该被诱导提前收尾）", () => {
    for (const src of [LOOP, CRON]) {
      const text = withScheduledPromptHeader("继续做那一轮的活", src, "zh");
      expect(text.split("\n")).toHaveLength(2);
      expect(text).not.toContain("唤醒只在本轮结束");
    }
  });
});

describe("N2 唤醒收尾指引：strip 一致性", () => {
  it("能把「头 + 指引」一起剥掉，取回原始 prompt（中英两种）", () => {
    expect(
      stripScheduledPromptHeader(withScheduledPromptHeader("正文", WAKEUP, "zh"), WAKEUP),
    ).toBe("正文");
    expect(
      stripScheduledPromptHeader(withScheduledPromptHeader("body", WAKEUP, "en"), WAKEUP),
    ).toBe("body");
  });

  it("兼容旧格式：历史消息里只有来源头、没有指引行", () => {
    // 旧会话落盘的正文是 `${header}\n${prompt}`。修复不能要求历史消息重写，
    // 否则 TUI resume 后 preview 会带上整行来源头。
    const legacy = `[定时唤醒 · schedule_wakeup · ID f59edfba · 由你此前安排，不是用户新输入的消息]\n旧正文`;
    expect(stripScheduledPromptHeader(legacy, WAKEUP)).toBe("旧正文");
  });

  it("多行 prompt 原样保留（只剥头与指引）", () => {
    const prompt = "第一行\n第二行\n第三行";
    const text = withScheduledPromptHeader(prompt, WAKEUP, "zh");
    expect(stripScheduledPromptHeader(text, WAKEUP)).toBe(prompt);
  });
});
