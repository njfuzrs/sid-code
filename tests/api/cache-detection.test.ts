/**
 * cache-detection.ts 测试
 * 两阶段检测 / 双重阈值 / 归因（模型/system/工具增删改/TTL）
 */

import { describe, test, expect } from "bun:test";
import {
  CacheBreakDetector,
  formatCacheBreakReport,
  type CacheCheckParams,
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

  test("命中下降但状态无变化 → 未知原因兜底", () => {
    let t = 0;
    const d = new CacheBreakDetector(() => t);
    d.checkResponse(params({ cacheReadTokens: 50000 }));
    t = 1000; // 1s 内，无 TTL 警告
    const report = d.checkResponse(params({ cacheReadTokens: 5000 }));
    expect(report!.changes.some((c) => c.includes("未知原因"))).toBe(true);
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
