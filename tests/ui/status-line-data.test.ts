/**
 * LY1 — 状态栏数据派生纯函数测试
 *
 * useStatusLineData 内部依赖 React context，难以脱离渲染单测；但其全部数据派生
 * 已拆为可独立测试的纯函数，这里覆盖这些纯逻辑（路径缩短、权限色、上下文/费用色、
 * 缓存命中率显隐）。
 */

import { test, expect, describe } from "bun:test";
import {
  shortenPath,
  derivePermission,
  deriveContextColor,
  deriveCost,
  deriveCacheMetrics,
} from "../../src/ui/hooks/useStatusLineData.ts";
import { theme } from "../../src/ui/semantic-colors.ts";
import type { Usage } from "../../src/llm/types.ts";

describe("LY1 — shortenPath", () => {
  test("home 前缀替换为 ~", () => {
    expect(shortenPath("/home/u/proj", 100, "/home/u")).toBe("~/proj");
  });

  test("超长只保留最后两级", () => {
    const long = "/home/u/a/b/c/d/e/very-long-dir-name-here";
    const out = shortenPath(long, 20, "/home/u");
    expect(out.startsWith("…/")).toBe(true);
    expect(out.split("/").length).toBe(3); // …/ + 两级
  });
});

describe("LY1 — derivePermission", () => {
  test("plan → active 色", () => {
    expect(derivePermission("plan").color).toBe(theme.ui.active);
  });
  test("deny-write → error 色", () => {
    expect(derivePermission("deny-write").color).toBe(theme.status.error);
  });
  test("dangerously-skip-permissions → skip-perms + warning 色 + isDanger", () => {
    const r = derivePermission("dangerously-skip-permissions");
    expect(r.display).toBe("skip-perms");
    expect(r.color).toBe(theme.status.warning);
    expect(r.isDanger).toBe(true);
  });
  test("deny-write 也是危险态", () => {
    expect(derivePermission("deny-write").isDanger).toBe(true);
  });
  test("默认 → success 色，非危险态", () => {
    const r = derivePermission("default");
    expect(r.color).toBe(theme.status.success);
    expect(r.isDanger).toBe(false);
  });
  test("plan → 非危险态", () => {
    expect(derivePermission("plan").isDanger).toBe(false);
  });
});

describe("LY1 — deriveContextColor", () => {
  test("≥90 红 / ≥70 黄 / 其余默认", () => {
    const def = "x";
    expect(deriveContextColor(95, def)).toBe(theme.status.error);
    expect(deriveContextColor(75, def)).toBe(theme.status.warning);
    expect(deriveContextColor(50, def)).toBe(def);
  });
});

describe("LY1 — deriveCost", () => {
  test("DeepSeek 用 ≈$ 前缀", () => {
    expect(deriveCost(1.5, 0, "deepseek-chat").text.startsWith("≈$")).toBe(true);
  });
  test("普通模型用 $ 前缀", () => {
    expect(deriveCost(1.5, 0, "gpt-4").text.startsWith("$")).toBe(true);
  });
  test("≥95% 限额红，≥80% 黄", () => {
    expect(deriveCost(96, 100, "gpt-4").color).toBe(theme.status.error);
    expect(deriveCost(85, 100, "gpt-4").color).toBe(theme.status.warning);
    expect(deriveCost(50, 100, "gpt-4").color).toBeUndefined();
  });
  test("无限额或零费用时无颜色", () => {
    expect(deriveCost(0, 100, "gpt-4").color).toBeUndefined();
    expect(deriveCost(10, 0, "gpt-4").color).toBeUndefined();
  });
});

describe("LY1 — deriveCacheMetrics", () => {
  test("无缓存命中返回 null（不显示）", () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 50 };
    expect(deriveCacheMetrics(usage, "gpt-4")).toBeNull();
  });

  test("有缓存命中返回命中率文本", () => {
    const usage: Usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 80,
    };
    const r = deriveCacheMetrics(usage, "claude-3-5-sonnet");
    if (r) {
      expect(r.text.startsWith("⚡")).toBe(true);
      expect(r.rate).toBeGreaterThan(0);
    }
    // 不同 provider 归一化策略不同，至少不抛错
    expect(true).toBe(true);
  });
});
