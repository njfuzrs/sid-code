/**
 * cache-detection.ts 测试
 * 两阶段检测 / 双重阈值 / 归因（模型/system/工具增删改/TTL）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  CacheBreakDetector,
  formatCacheBreakReport,
  recordCacheBreak,
  getRecentCacheBreaks,
  clearCacheBreaks,
  getCacheHealthAdvice,
  type CacheCheckParams,
  type CacheBreakRecord,
} from "../../src/api/cache-detection.ts";

const TOOLS = [
  { name: "read", description: "read file" },
  { name: "write", description: "write file" },
];

function params(over: Partial<CacheCheckParams> = {}): CacheCheckParams {
  return {
    cacheReadTokens: 10000,
    systemPrompt: "you are helpful",
    toolSchemas: TOOLS,
    model: "claude-sonnet-4",
    ...over,
  };
}

describe("CacheBreakDetector 基础", () => {
  test("首次请求返回 null（仅记录）", () => {
    const d = new CacheBreakDetector();
    expect(d.checkResponse(params())).toBeNull();
  });

  test("命中稳定（无下降）返回 null", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 10000 }));
    expect(d.checkResponse(params({ cacheReadTokens: 10000 }))).toBeNull();
  });

  test("下降未达阈值（<5% 或 <2000）返回 null", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 10000 }));
    // 下降 1000 tokens = 10%，但绝对值 < 2000 → 不报
    expect(d.checkResponse(params({ cacheReadTokens: 9000 }))).toBeNull();
  });
});

describe("归因分析", () => {
  test("system prompt 变化", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    const report = d.checkResponse(
      params({ cacheReadTokens: 10000, systemPrompt: "DIFFERENT PROMPT" }),
    );
    expect(report).not.toBeNull();
    expect(report!.changes.some((c) => c.includes("System prompt"))).toBe(true);
    expect(report!.dropTokens).toBe(40000);
    expect(report!.dropPercent).toBe(80);
  });

  test("模型变化", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    const report = d.checkResponse(params({ cacheReadTokens: 5000, model: "claude-opus-4" }));
    expect(report!.changes.some((c) => c.includes("模型变化"))).toBe(true);
  });

  test("工具新增", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    const report = d.checkResponse(
      params({ cacheReadTokens: 5000, toolSchemas: [...TOOLS, { name: "bash", description: "run" }] }),
    );
    const toolChange = report!.changes.find((c) => c.includes("工具变化"));
    expect(toolChange).toContain("新增: bash");
  });

  test("工具移除", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    const report = d.checkResponse(params({ cacheReadTokens: 5000, toolSchemas: [TOOLS[0]] }));
    const toolChange = report!.changes.find((c) => c.includes("工具变化"));
    expect(toolChange).toContain("移除: write");
  });

  test("工具修改（同名但 schema 变了）", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    const report = d.checkResponse(
      params({
        cacheReadTokens: 5000,
        toolSchemas: [{ name: "read", description: "CHANGED" }, TOOLS[1]],
      }),
    );
    const toolChange = report!.changes.find((c) => c.includes("工具变化"));
    expect(toolChange).toContain("修改: read");
  });

  test("TTL 过期（间隔 > 5 分钟）", () => {
    let t = 0;
    const d = new CacheBreakDetector(() => t);
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    t = 6 * 60_000; // 6 分钟后
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    expect(report!.changes.some((c) => c.includes("TTL"))).toBe(true);
  });

  test("Beta headers 变化（回归：此前主循环恒传 [] 使该归因永不触发）", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000, betaHeaders: [] }));
    // 会话中途新增 beta header（如首次启用 token-efficient-tools）→ 前缀失效
    const report = d.checkResponse(
      params({ cacheReadTokens: 5000, betaHeaders: ["token-efficient-tools-2025-02-19"] }),
    );
    expect(report).not.toBeNull();
    expect(report!.changes.some((c) => c.includes("Beta headers"))).toBe(true);
  });

  test("命中下降但状态无变化 → 前缀 hash 未变归因为服务端波动", () => {
    let t = 0;
    const d = new CacheBreakDetector(() => t);
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    t = 1000; // 1s 内，无 TTL 警告
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    // P2-1: 改进归因——前缀 hash 未变时明确标注为"服务端缓存波动"
    expect(report!.changes.some((c) => c.includes("服务端缓存波动"))).toBe(true);
    expect(report!.previousPrefixHash).toBeTruthy();
    expect(report!.currentPrefixHash).toBeTruthy();
    expect(report!.previousPrefixHash).toBe(report!.currentPrefixHash);
  });
});

describe("reset / format", () => {
  test("reset 后重新当作首次请求", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    d.reset();
    expect(d.checkResponse(params({ cacheReadTokens: 5000 }))).toBeNull();
  });

  test("formatCacheBreakReport 单行可读", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    const report = d.checkResponse(params({ cacheReadTokens: 5000, systemPrompt: "X" }))!;
    const line = formatCacheBreakReport(report);
    expect(line).toContain("%");
    expect(line).toContain("tokens");
  });
});

describe("中断记录环形缓冲 + 健康度建议（D3）", () => {
  beforeEach(() => clearCacheBreaks());

  function rec(over: Partial<CacheBreakRecord> = {}): CacheBreakRecord {
    return {
      dropTokens: 3000,
      dropPercent: 60,
      changes: ["System prompt 变化"],
      previousCacheReadTokens: 5000,
      currentCacheReadTokens: 2000,
      ts: 1_700_000_000,
      model: "deepseek-v4-pro",
      ...over,
    };
  }

  test("record 后能读回，最新在后", () => {
    recordCacheBreak(rec({ dropTokens: 100 }));
    recordCacheBreak(rec({ dropTokens: 200 }));
    const all = getRecentCacheBreaks();
    expect(all.length).toBe(2);
    expect(all[1].dropTokens).toBe(200);
  });

  test("环形缓冲上限 50 条", () => {
    for (let i = 0; i < 60; i++) recordCacheBreak(rec({ dropTokens: i }));
    const all = getRecentCacheBreaks();
    expect(all.length).toBe(50);
    expect(all[0].dropTokens).toBe(10); // 前 10 条被挤出
  });

  test("getRecentCacheBreaks(limit) 取尾部", () => {
    for (let i = 0; i < 5; i++) recordCacheBreak(rec({ dropTokens: i }));
    expect(getRecentCacheBreaks(2).map((b) => b.dropTokens)).toEqual([3, 4]);
  });

  test("system 频繁变化 → 给出移至 messages 的建议", () => {
    for (let i = 0; i < 3; i++) recordCacheBreak(rec({ changes: ["System prompt 变化"] }));
    const advice = getCacheHealthAdvice();
    expect(advice.some((a) => a.includes("system 提示词"))).toBe(true);
  });

  test("工具频繁变化 → 给出定序建议", () => {
    for (let i = 0; i < 3; i++) recordCacheBreak(rec({ changes: ["工具变化: +foo"] }));
    const advice = getCacheHealthAdvice();
    expect(advice.some((a) => a.includes("工具"))).toBe(true);
  });

  test("无记录时无建议", () => {
    expect(getCacheHealthAdvice()).toEqual([]);
  });

  test("clearCacheBreaks 清空", () => {
    recordCacheBreak(rec());
    clearCacheBreaks();
    expect(getRecentCacheBreaks()).toEqual([]);
  });
});

describe("G1 suppressNext 抑制机制", () => {
  test("notifyCompaction 抑制下一次检测", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    d.notifyCompaction();
    // 骤降但应被抑制
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    expect(report).toBeNull();
  });

  test("notifyCacheDeletion 抑制下一次检测", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    d.notifyCacheDeletion(3);
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    expect(report).toBeNull();
  });

  test("抑制仅作用一次，下次恢复正常检测", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    d.notifyCompaction();
    // 第一次：被抑制，基线更新为 30000
    d.checkResponse(params({ cacheReadTokens: 30000 }));
    // 第二次：无抑制，30000 → 5000 骤降应报告
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    expect(report).not.toBeNull();
  });

  test("未调用 notify 时正常检测不受影响", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    // 不调 notify，直接骤降 → 应检测到
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    expect(report).not.toBeNull();
  });
});
