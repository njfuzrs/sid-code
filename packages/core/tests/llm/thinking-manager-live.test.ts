/**
 * D8：ThinkingManager 启用位现算（20261016 思考开关排查 §8.1）。
 *
 * 修前 App 只按**启动模型**构造一次快照：启动在 kimi / gpt-5.x（无开关族）再切到 Claude，
 * think hard / ultrathink 永久失效且零日志。
 */

import { describe, test, expect } from "bun:test";
import { ThinkingManager } from "@sid-code/core/llm/thinking.ts";

describe("ThinkingManager 现算启用位", () => {
  test("回调每次读取都重算：模拟 /model 从无开关族切到有开关族", () => {
    let toggle = false; // 启动在 kimi
    const mgr = new ThinkingManager(() => toggle);
    expect(mgr.parseThinkingHint("think hard 重构").config).toBeUndefined();

    toggle = true; // 切到 claude-sonnet-5
    expect(mgr.isEnabled()).toBe(true);
    expect(mgr.parseThinkingHint("think hard 重构").config).toEqual({
      enabled: true,
      budgetTokens: 50000,
    });
    expect(mgr.getThinkingConfig("重构这个模块")?.enabled).toBe(true);

    toggle = false; // 再切回无开关族
    expect(mgr.getThinkingConfig("重构这个模块")).toBeUndefined();
  });

  test("布尔构造保持旧语义；setEnabled 覆盖回调", () => {
    expect(new ThinkingManager(true).isEnabled()).toBe(true);
    expect(new ThinkingManager().isEnabled()).toBe(false);
    const mgr = new ThinkingManager(() => true);
    mgr.setEnabled(false);
    expect(mgr.isEnabled()).toBe(false);
  });
});
