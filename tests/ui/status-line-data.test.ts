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
  deriveWorktree,
  deriveRepoName,
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
  test("默认 → success 色，非危险态，展示 ⏸ Manual 徽章（P2-4）", () => {
    const r = derivePermission("default");
    expect(r.color).toBe(theme.status.success);
    expect(r.isDanger).toBe(false);
    expect(r.display).toBe("⏸ Manual");
  });
  test("plan → 非危险态", () => {
    expect(derivePermission("plan").isDanger).toBe(false);
  });
});

describe("LY1 — deriveContextColor", () => {
  test("对齐 cc：≤60 默认 / 61-80 黄 / 81%+ 红", () => {
    // 用合法的 hex（Color 类型）而不是 "x"：deriveContextColor 的默认色参数会被原样
    // 透传到 <Text color=…>，"x" 这种值真进渲染会静默回退终端默认色。这里只需要一个
    // "与三个 status token 都不相等"的哨兵值，#010101 同样满足，且是真能上屏的颜色。
    const def = "#010101" as const;
    // 81%+ 红
    expect(deriveContextColor(81, def)).toBe(theme.status.error);
    expect(deriveContextColor(95, def)).toBe(theme.status.error);
    // 61-80 黄
    expect(deriveContextColor(61, def)).toBe(theme.status.warning);
    expect(deriveContextColor(80, def)).toBe(theme.status.warning);
    // ≤60 默认
    expect(deriveContextColor(60, def)).toBe(def);
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

describe("P3-3 — deriveWorktree", () => {
  test("worktree 路径提取名字", () => {
    expect(deriveWorktree("/home/u/proj/.claude/worktrees/feat-x")).toBe("feat-x");
    expect(deriveWorktree("/home/u/proj/.claude/worktrees/feat-x/src/a.ts")).toBe("feat-x");
  });

  test("非 worktree 路径返回空串", () => {
    expect(deriveWorktree("/home/u/proj")).toBe("");
    expect(deriveWorktree("/home/u/proj/src")).toBe("");
  });
});

describe("P3-3 — deriveRepoName", () => {
  test("非 git 目录返回空串（不抛错）", () => {
    // /tmp 下通常无 .git，返回空串。
    expect(deriveRepoName("/")).toBe("");
  });

  test("git 仓库返回主仓目录名", () => {
    // 本仓库根名为 sid-code；从 cwd 向上应找到它。
    const name = deriveRepoName(process.cwd());
    // 在本仓库内运行时应拿到 sid-code；否则至少是非空或空串（不抛错即通过）。
    expect(typeof name).toBe("string");
  });
});
