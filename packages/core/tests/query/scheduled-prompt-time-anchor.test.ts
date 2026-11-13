/**
 * R3：唤醒注入的「排定 / 触发」时间锚点单测（2026-11-12）
 *
 * 事故 b0aa0f1e 的误读类型之一是「分不清旧等待与新等待」。通知侧由
 * `notification-anchors.test.ts` 覆盖；唤醒注入侧（`schedule_wakeup` 到点后注入的
 * 那条 prompt）同理——模型看到一条自己写的 prompt，需要能回答「这是刚排的那次
 * 还是上一轮那次」。
 *
 * 判据落在**模型能看到的文本**上（`formatScheduledPromptHeader` 的产物），
 * 并顺带守住剥离侧仍能取回原始 prompt——头里多了时间段，`stripScheduledPromptHeader`
 * 若失配，TUI 的 resume 历史会把 harness 的话当成用户任务展示。
 */

import { describe, test, expect } from "bun:test";
import {
  formatScheduledPromptHeader,
  formatWakeupTurnGuidance,
  stripScheduledPromptHeader,
  withScheduledPromptHeader,
  type ScheduledPromptSource,
} from "@sid-code/core/query/scheduled-prompt.ts";
import { formatClockWithSeconds } from "@sid-code/core/task/monitor-text.ts";

const SCHEDULED_AT = new Date(2026, 10, 12, 6, 30, 0).getTime();
const FIRED_AT = new Date(2026, 10, 12, 6, 31, 5).getTime();

const base: ScheduledPromptSource = {
  taskId: "wk-r3test",
  origin: "schedule_wakeup",
};

describe("R3 唤醒注入：排定 / 触发时刻", () => {
  test("中文头含「排定于 / 触发于」两个绝对时刻", () => {
    const header = formatScheduledPromptHeader(
      { ...base, scheduledAt: SCHEDULED_AT, firedAt: FIRED_AT },
      "zh",
    );
    expect(header).toContain(`排定于 ${formatClockWithSeconds(SCHEDULED_AT)}`);
    expect(header).toContain(`触发于 ${formatClockWithSeconds(FIRED_AT)}`);
    // 身份标记不能因为加了时间段而丢：TUI / strip 都依赖这句固定措辞
    expect(header).toContain("由你此前安排，不是用户新输入的消息");
    expect(header).toContain("wk-r3test");
  });

  test("英文头同样带两个时刻", () => {
    const header = formatScheduledPromptHeader(
      { ...base, scheduledAt: SCHEDULED_AT, firedAt: FIRED_AT },
      "en",
    );
    expect(header).toContain(`排定于 ${formatClockWithSeconds(SCHEDULED_AT)}`);
    expect(header).toContain(`触发于 ${formatClockWithSeconds(FIRED_AT)}`);
    expect(header).toContain("scheduled by you earlier, not a new user message");
  });

  test("只有一个时刻时只写那一个（不编造另一个）", () => {
    const onlyScheduled = formatScheduledPromptHeader({ ...base, scheduledAt: SCHEDULED_AT }, "zh");
    expect(onlyScheduled).toContain("排定于");
    expect(onlyScheduled).not.toContain("触发于");

    const onlyFired = formatScheduledPromptHeader({ ...base, firedAt: FIRED_AT }, "zh");
    expect(onlyFired).toContain("触发于");
    expect(onlyFired).not.toContain("排定于");
  });

  test("两个时刻都没有时不出时间段（老任务 / 测试直接构造）", () => {
    const header = formatScheduledPromptHeader(base, "zh");
    expect(header).not.toContain("排定于");
    expect(header).not.toContain("触发于");
    expect(header).toContain("由你此前安排，不是用户新输入的消息");
  });

  test("strip 能剥掉带时间段的头 + 指引，取回原始 prompt", () => {
    const source: ScheduledPromptSource = { ...base, scheduledAt: SCHEDULED_AT, firedAt: FIRED_AT };
    for (const language of ["zh", "en"] as const) {
      const injected = withScheduledPromptHeader("检查 CI 是否绿了", source, language);
      expect(stripScheduledPromptHeader(injected, source)).toBe("检查 CI 是否绿了");
      // 指引行也必须一起剥掉
      expect(stripScheduledPromptHeader(injected, source)).not.toContain(
        formatWakeupTurnGuidance(language),
      );
    }
  });

  test("strip 兼容改动前落盘的历史消息（头里没有时间段）", () => {
    const legacySource: ScheduledPromptSource = base;
    const legacyInjected = `[定时唤醒 · schedule_wakeup · ID wk-r3test · 由你此前安排，不是用户新输入的消息]\n检查 CI`;
    // 剥离侧拿到的是带时间的 source，也要能剥旧形态
    expect(
      stripScheduledPromptHeader(legacyInjected, {
        ...base,
        scheduledAt: SCHEDULED_AT,
        firedAt: FIRED_AT,
      }),
    ).toBe("检查 CI");
    expect(stripScheduledPromptHeader(legacyInjected, legacySource)).toBe("检查 CI");
  });

  test("不是唤醒头时原样返回（不按前缀猜来源）", () => {
    const text = "[用户消息] 帮我看看这个";
    expect(stripScheduledPromptHeader(text, { ...base, firedAt: FIRED_AT })).toBe(text);
  });
});
