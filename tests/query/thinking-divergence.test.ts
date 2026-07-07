/**
 * 思考发散熔断器单测（方案③，deepseek-reasoning-leak 修复 5.3）
 *
 * 覆盖 measureThinkingLen / isThinkingDiverging / pushThinkingLen 三个纯函数：
 * 例① 第 7→8→9 轮思考字符 5741→12720→55468 单调激增 = 分析瘫痪的最早信号。
 */

import { test, expect, describe } from "bun:test";
import {
  measureThinkingLen,
  isThinkingDiverging,
  pushThinkingLen,
  buildThinkingDivergenceMessage,
  THINKING_DIVERGENCE_WINDOW,
  THINKING_DIVERGENCE_LEN,
  isThinkingDivergenceDetectionEnabled,
} from "../../src/query/thinking-divergence.ts";

describe("measureThinkingLen", () => {
  test("累加所有 thinking 块字符数，忽略 text/tool_use", () => {
    const len = measureThinkingLen([
      { type: "thinking", thinking: "abc" },
      { type: "text", thinking: undefined },
      { type: "thinking", thinking: "de" },
    ] as any);
    expect(len).toBe(5);
  });

  test("无思考块 → 0", () => {
    expect(measureThinkingLen([{ type: "text" }] as any)).toBe(0);
  });
});

describe("isThinkingDiverging", () => {
  test("例① 雪崩序列 5741→12720→55468 → 判为发散", () => {
    expect(isThinkingDiverging([5741, 12720, 55468])).toBe(true);
  });

  test("窗口不足（< WINDOW 轮）→ 不判发散", () => {
    expect(isThinkingDiverging([55468])).toBe(false);
    expect(isThinkingDiverging([12720, 55468])).toBe(false);
  });

  test("单调递增但末轮未超阈值 → 不判发散（放过正常深度推理）", () => {
    expect(isThinkingDiverging([100, 200, 300])).toBe(false);
  });

  test("末轮超阈值但非单调递增 → 不判发散（震荡不算瘫痪）", () => {
    expect(isThinkingDiverging([30000, 5000, 40000])).toBe(false);
  });

  test("持平（非严格递增）→ 不判发散", () => {
    const v = THINKING_DIVERGENCE_LEN + 100;
    expect(isThinkingDiverging([v, v, v])).toBe(false);
  });
});

describe("pushThinkingLen", () => {
  test("滚动保留最近 WINDOW 轮", () => {
    let h: number[] | undefined = undefined;
    for (const n of [1, 2, 3, 4, 5]) h = pushThinkingLen(h, n);
    expect(h!.length).toBe(THINKING_DIVERGENCE_WINDOW);
    expect(h![h!.length - 1]).toBe(5); // 保留最新
  });

  test("不修改入参（返回新数组）", () => {
    const orig = [1, 2];
    const next = pushThinkingLen(orig, 3);
    expect(orig).toEqual([1, 2]);
    expect(next).toEqual([1, 2, 3]);
  });
});

describe("buildThinkingDivergenceMessage", () => {
  test("包含思考量轨迹 + system-reminder 包裹", () => {
    const msg = buildThinkingDivergenceMessage([5741, 12720, 55468]);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("5741 → 12720 → 55468");
    expect(msg).toContain("todo_write");
  });
});

describe("isThinkingDivergenceDetectionEnabled（Top 4：默认关闭 + env 门控）", () => {
  const KEYS = ["SID_ENABLE_THINKING_DIVERGENCE", "SID_ENABLE_LOOP_DETECTION"] as const;
  const saved: Record<string, string | undefined> = {};

  function clearAll() {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  function restore() {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  test("默认（两个开关都未设）→ 关闭", () => {
    clearAll();
    try {
      expect(isThinkingDivergenceDetectionEnabled()).toBe(false);
    } finally {
      restore();
    }
  });

  test("SID_ENABLE_THINKING_DIVERGENCE=1 → 单独开启", () => {
    clearAll();
    try {
      process.env.SID_ENABLE_THINKING_DIVERGENCE = "1";
      expect(isThinkingDivergenceDetectionEnabled()).toBe(true);
    } finally {
      restore();
    }
  });

  test("SID_ENABLE_LOOP_DETECTION=1 → 一并开启（同属防跑偏启发式）", () => {
    clearAll();
    try {
      process.env.SID_ENABLE_LOOP_DETECTION = "1";
      expect(isThinkingDivergenceDetectionEnabled()).toBe(true);
    } finally {
      restore();
    }
  });
});
