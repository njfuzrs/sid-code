import { describe, expect, test } from "bun:test";
import { stepStallCheck, type StallState } from "../../src/task/shell-task.ts";

// 多代理 F4：增长判据必须看文件字节数，不能看定长尾部的长度。
describe("stepStallCheck", () => {
  const PROMPT_TAIL = "x".repeat(900) + "\nPress Enter to continue";

  test("文件超过 1024 字节后仍持续增长 → 不报停滞", () => {
    let state: StallState = { lastSize: 0, lastGrowth: 0 };
    let now = 0;
    for (const size of [400, 900, 1500, 8000, 20000, 50000]) {
      now += 60_000; // 每步都超过 45s 阈值
      const step = stepStallCheck(state, size, PROMPT_TAIL, now);
      expect(step.notify).toBe(false);
      state = step.state;
    }
  });

  test("字节数不变且超阈值且尾部是提示词 → 报一次并重置锚点", () => {
    const state: StallState = { lastSize: 5000, lastGrowth: 0 };
    const step = stepStallCheck(state, 5000, PROMPT_TAIL, 46_000);
    expect(step.notify).toBe(true);
    expect(step.state.lastGrowth).toBe(46_000);
    // 紧接着下一次检查不再重复报
    expect(stepStallCheck(step.state, 5000, PROMPT_TAIL, 51_000).notify).toBe(false);
  });

  test("未到阈值或尾部无提示词 → 不报", () => {
    const state: StallState = { lastSize: 5000, lastGrowth: 0 };
    expect(stepStallCheck(state, 5000, PROMPT_TAIL, 30_000).notify).toBe(false);
    expect(stepStallCheck(state, 5000, "building...", 60_000).notify).toBe(false);
  });
});
