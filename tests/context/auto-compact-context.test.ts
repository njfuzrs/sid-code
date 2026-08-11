/**
 * src/context/auto-compact.ts 单测
 */

import { describe, it, expect } from "bun:test";
import {
  TOKEN_THRESHOLDS,
  TokenFreedTracker,
  isCompactSourceMessage,
  resolveAutoCompactPctOverride,
} from "@sid-code/core/context/auto-compact.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

// §12 P2-2：getAutoCompactLevel + autoCompact/warning/error 三档已删除（事实死代码，
// 主循环只消费 blocking）。原 getAutoCompactLevel describe 一并移除。

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
  it("§12 P2-2 清理后只保留 blocking 底线（其余死档已删）", () => {
    expect(TOKEN_THRESHOLDS.blocking).toBe(3_000);
    // 死档已删除：断言不再存在，防止回归时误加回来
    expect((TOKEN_THRESHOLDS as Record<string, number>).autoCompact).toBeUndefined();
    expect((TOKEN_THRESHOLDS as Record<string, number>).warning).toBeUndefined();
    expect((TOKEN_THRESHOLDS as Record<string, number>).error).toBeUndefined();
  });
});

describe("resolveAutoCompactPctOverride (§12 P1-1)", () => {
  it("未设 env 返回 null", () => {
    expect(resolveAutoCompactPctOverride({})).toBeNull();
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "" })).toBeNull();
  });

  it("小数形态 (0,1) 原样返回", () => {
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "0.5" })).toBe(0.5);
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "0.82" })).toBe(0.82);
  });

  it("百分数形态 (1,100) 归一化为小数", () => {
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "50" })).toBe(0.5);
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "82" })).toBeCloseTo(0.82, 5);
  });

  it("非法值忽略返回 null（abc / 0 / 100 / 150）", () => {
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "abc" })).toBeNull();
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "0" })).toBeNull();
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "100" })).toBeNull();
    expect(resolveAutoCompactPctOverride({ SID_CODE_AUTOCOMPACT_PCT: "150" })).toBeNull();
  });

  it("SID_CODE_ 优先于 CLAUDE_ 兼容别名", () => {
    expect(
      resolveAutoCompactPctOverride({
        SID_CODE_AUTOCOMPACT_PCT: "0.6",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "0.3",
      }),
    ).toBe(0.6);
  });

  it("仅设 CLAUDE_ 别名时生效（迁移友好）", () => {
    expect(resolveAutoCompactPctOverride({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" })).toBeCloseTo(0.7, 5);
  });
});
