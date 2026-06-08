/**
 * src/context/auto-compact.ts 单测
 */

import { describe, it, expect } from "bun:test";
import {
  getAutoCompactLevel,
  TOKEN_THRESHOLDS,
  TokenFreedTracker,
  isCompacting,
  isCompactSourceMessage,
} from "../../src/context/auto-compact.ts";
import type { Message } from "../../src/llm/types.ts";

describe("getAutoCompactLevel", () => {
  it("剩余 > 20K 应返回 null", () => {
    expect(getAutoCompactLevel(30_000)).toBeNull();
  });

  it("剩余 ≤ 20K 应返回 warning", () => {
    expect(getAutoCompactLevel(18_000)).toBe("warning");
  });

  it("剩余 ≤ 13K 应返回 autoCompact", () => {
    expect(getAutoCompactLevel(10_000)).toBe("autoCompact");
  });

  it("剩余 ≤ 3K 应返回 blocking", () => {
    expect(getAutoCompactLevel(2_000)).toBe("blocking");
  });

  it("边界值 autoCompact/warning 分界 (13K)", () => {
    expect(getAutoCompactLevel(13_000)).toBe("autoCompact");
    expect(getAutoCompactLevel(13_001)).toBe("warning");
  });

  it("边界值 warning/null 分界 (20K)", () => {
    expect(getAutoCompactLevel(20_000)).toBe("warning");
    expect(getAutoCompactLevel(20_001)).toBeNull();
  });

  it("边界值 blocking/autoCompact 分界 (3K)", () => {
    expect(getAutoCompactLevel(3_000)).toBe("blocking");
    expect(getAutoCompactLevel(3_001)).toBe("autoCompact");
  });
});

describe("TokenFreedTracker", () => {
  it("初始总量为 0", () => {
    const tracker = new TokenFreedTracker();
    expect(tracker.getTotalFreed()).toBe(0);
    expect(tracker.getRecords()).toHaveLength(0);
  });

  it("recordCompact 累加", () => {
    const tracker = new TokenFreedTracker();
    tracker.recordCompact(100, "microCompact");
    tracker.recordCompact(200, "sessionMemory");
    expect(tracker.getTotalFreed()).toBe(300);
  });

  it("recordCompact 忽略非正值", () => {
    const tracker = new TokenFreedTracker();
    tracker.recordCompact(0, "microCompact");
    tracker.recordCompact(-10, "llmSummary");
    expect(tracker.getTotalFreed()).toBe(0);
  });

  it("getRecords 返回压缩记录", () => {
    const tracker = new TokenFreedTracker();
    tracker.recordCompact(100, "microCompact");
    tracker.recordCompact(200, "sessionMemory");

    const records = tracker.getRecords();
    expect(records).toHaveLength(2);
    expect(records[0].strategy).toBe("microCompact");
    expect(records[0].tokensFreed).toBe(100);
    expect(records[1].strategy).toBe("sessionMemory");
    expect(records[1].tokensFreed).toBe(200);
  });

  it("reset 应清空", () => {
    const tracker = new TokenFreedTracker();
    tracker.recordCompact(100, "microCompact");
    expect(tracker.getTotalFreed()).toBe(100);

    tracker.reset();
    expect(tracker.getTotalFreed()).toBe(0);
    expect(tracker.getRecords()).toHaveLength(0);
  });
});

describe("isCompactSourceMessage", () => {
  it("无 _meta 的消息应返回 false", () => {
    const msg: Message = { role: "user", content: [{ type: "text", text: "hello" }] };
    expect(isCompactSourceMessage(msg)).toBe(false);
  });

  it("_meta.compact_source = session_memory 应返回 true", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      _meta: { compact_source: "session_memory" },
    };
    expect(isCompactSourceMessage(msg)).toBe(true);
  });

  it("_meta.compact_source = compact 应返回 true", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      _meta: { compact_source: "compact" },
    };
    expect(isCompactSourceMessage(msg)).toBe(true);
  });

  it("_meta.compact_source = 其他值应返回 false", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      _meta: { compact_source: "other" },
    };
    expect(isCompactSourceMessage(msg)).toBe(false);
  });
});

describe("TOKEN_THRESHOLDS", () => {
  it("应包含四层阈值", () => {
    expect(TOKEN_THRESHOLDS.autoCompact).toBe(13_000);
    expect(TOKEN_THRESHOLDS.warning).toBe(20_000);
    expect(TOKEN_THRESHOLDS.error).toBe(20_000);
    expect(TOKEN_THRESHOLDS.blocking).toBe(3_000);
  });

  it("阈值应为只读（类型层面 as const 保证）", () => {
    // as const 在 TS 类型层面保证只读，运行时不冻结对象
    expect(TOKEN_THRESHOLDS.autoCompact).toBe(13_000);
    expect(TOKEN_THRESHOLDS.blocking).toBe(3_000);
  });
});
