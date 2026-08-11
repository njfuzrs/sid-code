/**
 * Footer 上下文口径对齐守卫 — §八 #6 #7 + P0-3 文案守卫（#4）
 *
 * 背景（2026-07-29 事故的第二个现象）：Footer 显示 `17%`，分母是**满窗口 1M**；而真实压缩
 * 触发点是「窗口 − 18% 余量 ≈ 82%」。用户看到 17% 时无从得知 82% 才压缩，于是「占用率一直
 * 很低却突然压缩」在旧设计下是**必然**而非偶发。同期 deriveContextColor 的变色点是硬编码的
 * 61%/81%，与真实档位（绝对 buffer + 窗口系数算出）不同源。
 *
 * fix_type: infra_bug（L1，测试）
 */

import { describe, test, expect } from "bun:test";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { deriveContextColor } from "@sid-code/cli/ui/hooks/useStatusLineData.ts";
import { theme } from "@sid-code/cli/ui/semantic-colors.ts";
import { buildEmptyParamRetryMessage } from "@sid-code/core/query/empty-param.ts";

describe("§八 #6 — 上下文占用率必须与压缩阈值同源", () => {
  test("getContextUsageForDisplay 的触发点与 getCompactionThresholds 完全一致", () => {
    for (const maxTokens of [32_000, 60_000, 128_000, 200_000, 1_000_000]) {
      const ctx = new ContextManager({ maxTokens });
      ctx.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(5000) }] });

      const u = ctx.getContextUsageForDisplay();
      const t = ctx.getCompactionThresholds();

      // 展示用的触发点必须由阈值单一事实源派生，不得自行计算
      expect(u.triggerPercentOfWindow, `${maxTokens}`).toBe(
        Math.round((Math.max(1, t.compactionTriggerUsed) / maxTokens) * 100),
      );
      // 档位必须与真实决策函数同源
      expect(u.level, `${maxTokens}`).toBe(ctx.getCompactionLevel());
      // 满窗口占比口径不变（不破坏用户既有认知）
      expect(u.percentOfWindow, `${maxTokens}`).toBe(
        Math.round((ctx.estimateTokens() / maxTokens) * 100),
      );
    }
  });

  test("1M 窗口下触发点显著低于 100%（满窗口占比不能当成压缩进度）", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

    const u = ctx.getContextUsageForDisplay();

    // 事故里的关键数字：真实触发点约 82%，而 Footer 只显示满窗口占比
    expect(u.triggerPercentOfWindow).toBeGreaterThan(60);
    expect(u.triggerPercentOfWindow).toBeLessThan(95);
    // 低占用时距触发点的进度也必须低（两个口径都要自洽）
    expect(u.percentOfTrigger).toBeLessThan(5);
  });

  test("percentOfTrigger 达 100 时，档位必须已进入 hard/emergency（口径自洽）", () => {
    const ctx = new ContextManager({ maxTokens: 200_000 });
    // 灌到触发点以上
    for (let i = 0; i < 400; i++) {
      ctx.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "z".repeat(2000) }],
      });
    }
    const u = ctx.getContextUsageForDisplay();
    if (u.percentOfTrigger >= 100) {
      expect(["hard", "emergency"]).toContain(u.level);
    }
  });
});

describe("§八 #7 — deriveContextColor 变色点与真实档位对齐", () => {
  const defaultColor = "#default";

  test("按档位着色：soft→黄、hard/emergency→红、none→默认", () => {
    expect(deriveContextColor(0, defaultColor, "none")).toBe(defaultColor);
    expect(deriveContextColor(0, defaultColor, "soft")).toBe(theme.status.warning);
    expect(deriveContextColor(0, defaultColor, "hard")).toBe(theme.status.error);
    expect(deriveContextColor(0, defaultColor, "emergency")).toBe(theme.status.error);
  });

  test("档位优先于百分比：低百分比但已进 soft 档 → 必须变色", () => {
    // 这正是旧实现的漏洞方向：小窗口下真实档位已告警，而百分比还没到 61
    expect(deriveContextColor(30, defaultColor, "soft")).toBe(theme.status.warning);
    // 反向：高百分比但档位为 none（大窗口远未到触发点）→ 不该虚假告警
    expect(deriveContextColor(70, defaultColor, "none")).toBe(defaultColor);
  });

  test("未提供档位时回退旧阈值（不回归）", () => {
    expect(deriveContextColor(50, defaultColor)).toBe(defaultColor);
    expect(deriveContextColor(61, defaultColor)).toBe(theme.status.warning);
    expect(deriveContextColor(81, defaultColor)).toBe(theme.status.error);
  });

  test("1M 窗口进入 soft 档时 UI 必须已变色（与阈值联动的端到端检查）", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    const t = ctx.getCompactionThresholds();
    // 灌到刚过 soft 档（剩余 <= maskingRemaining）
    const targetUsed = t.effectiveWindow - t.maskingRemaining + 1000;
    const perMsg = 4000;
    for (let i = 0; ctx.estimateTokens() < targetUsed && i < 5000; i++) {
      ctx.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "w".repeat(perMsg) }],
      });
    }
    const u = ctx.getContextUsageForDisplay();
    expect(u.level).not.toBe("none");
    expect(deriveContextColor(u.percentOfWindow, defaultColor, u.level)).not.toBe(defaultColor);
  });
});

describe("§八 #4 / P0-3 — 未压缩时提示文案不得声称已精简上下文", () => {
  const hits = [{ id: "tu_1", name: "write", index: 0 }];

  test("compacted=false 时文案不含任何「精简/压缩上下文」字样", () => {
    for (const stopReason of [undefined, "max_tokens", "end_turn"]) {
      const msg = buildEmptyParamRetryMessage(hits, 1, 3, false, stopReason);
      expect(msg, `stop=${stopReason}`).not.toContain("已为你精简对话上下文");
      expect(msg, `stop=${stopReason}`).not.toContain("精简对话上下文");
    }
  });

  test("compacted=true 时才允许出现该措辞（真压了才说）", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, 3, true, undefined);
    expect(msg).toContain("精简对话上下文");
  });
});
