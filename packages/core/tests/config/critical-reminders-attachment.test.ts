/**
 * P2-17：`PRIORITY.CRITICAL_REMINDER` 的第一个生产者
 *
 * 缺陷：CRITICAL_REMINDER=1（最高优先级）此前全仓只有定义那一行，零消费者。
 * 于是「用户明确说过不要做 X」的唯一保留渠道是摘要 prompt 里那句话 —— 靠模型遵从。
 * 放大它的两条事实：决策点注入消息流后会被下一次 strip 剥掉（只活一代），
 * 落盘的 decisions.jsonl 没有任何读取方。
 */
import { describe, it, expect } from "bun:test";
import {
  generateCriticalRemindersAttachment,
  generateDenyRulesAttachment,
  PRIORITY,
} from "../../src/config/attachments.ts";
import { buildSystemPrompt } from "../../src/config/system-prompt.ts";
import { DYNAMIC_BOUNDARY } from "../../src/api/cache-strategy.ts";

describe("generateCriticalRemindersAttachment", () => {
  it("空列表 / 全空白 → null（不注入空壳附件）", () => {
    expect(generateCriticalRemindersAttachment([])).toBeNull();
    expect(generateCriticalRemindersAttachment(["", "   "])).toBeNull();
  });

  it("约束原文进 <user-constraints>，优先级为 CRITICAL_REMINDER", () => {
    const att = generateCriticalRemindersAttachment(["不要改生产配置", "别用 any"]);
    expect(att).not.toBeNull();
    expect(att!.content).toContain("<user-constraints>");
    expect(att!.content).toContain("不要改生产配置");
    expect(att!.content).toContain("别用 any");
    expect(att!.priority).toBe(PRIORITY.CRITICAL_REMINDER);
  });

  it("标 stable：约束只在压缩时增补，不随请求变化（否则每轮击穿静态前缀）", () => {
    const att = generateCriticalRemindersAttachment(["不要删测试"]);
    expect(att!.cacheStability).toBe("stable");
  });

  it("优先级高于 deny 规则 —— 口头约束没有权限层兜底这道第二防线", () => {
    const cr = generateCriticalRemindersAttachment(["不要提交"])!;
    const deny = generateDenyRulesAttachment("禁止 rm -rf")!;
    expect(cr.priority).toBeLessThan(deny.priority);
  });
});

describe("P2-17：接进 buildSystemPrompt 后落在静态区", () => {
  it("criticalReminders 传入后出现在提示词里，且在 DYNAMIC_BOUNDARY 之前", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      criticalReminders: ["不要改生产配置"],
      gitStatus: false,
    });
    expect(prompt).toContain("不要改生产配置");
    const idxConstraint = prompt.indexOf("不要改生产配置");
    const idxBoundary = prompt.indexOf(DYNAMIC_BOUNDARY);
    // 标了 stable 就必须落在边界之前；落到动态区等于每轮内容不同，白付 cache_creation
    if (idxBoundary >= 0) expect(idxConstraint).toBeLessThan(idxBoundary);
  });

  it("不传 criticalReminders 时不注入该段（向后兼容，不白占 token）", () => {
    const prompt = buildSystemPrompt({ tools: [], gitStatus: false });
    expect(prompt).not.toContain("<user-constraints>");
  });
});
