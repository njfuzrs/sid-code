/**
 * ToolSearch auto 模式 —— 阈值判定单测
 *
 * 覆盖：parseToolSearchConfig / checkAutoThreshold / resolveToolSearchEnabled / parseToolSearchEnv
 */

import { describe, test, expect } from "bun:test";
import {
  parseToolSearchConfig,
  checkAutoThreshold,
  resolveToolSearchEnabled,
  parseToolSearchEnv,
  type AutoThresholdInput,
} from "../../src/tool/tool-search-auto.ts";
import type { ToolDefinition } from "../../src/llm/types.ts";

describe("parseToolSearchConfig", () => {
  test("undefined → off", () => {
    expect(parseToolSearchConfig(undefined)).toEqual({ mode: "off", percentage: 0 });
  });
  test("false → off", () => {
    expect(parseToolSearchConfig(false)).toEqual({ mode: "off", percentage: 0 });
  });
  test("true → on", () => {
    expect(parseToolSearchConfig(true)).toEqual({ mode: "on", percentage: 0 });
  });
  test('"auto" → auto, 默认 10%', () => {
    expect(parseToolSearchConfig("auto")).toEqual({ mode: "auto", percentage: 10 });
  });
  test("number 0 → on（恒开）", () => {
    expect(parseToolSearchConfig(0)).toEqual({ mode: "on", percentage: 0 });
  });
  test("number 100 → off（恒关）", () => {
    expect(parseToolSearchConfig(100)).toEqual({ mode: "off", percentage: 0 });
  });
  test("number 25 → auto, 25%", () => {
    expect(parseToolSearchConfig(25)).toEqual({ mode: "auto", percentage: 25 });
  });
  test("number 负数 → on", () => {
    expect(parseToolSearchConfig(-5)).toEqual({ mode: "on", percentage: 0 });
  });
  test("number 150 → off（超 100 截断为恒关）", () => {
    expect(parseToolSearchConfig(150)).toEqual({ mode: "off", percentage: 0 });
  });
});

describe("checkAutoThreshold", () => {
  // 构造大量工具定义，确保 token 总数可控
  function mkDefs(count: number, descLen: number): ToolDefinition[] {
    return Array.from({ length: count }, (_, i) => ({
      name: `tool_${i}`,
      description: "x".repeat(descLen),
      input_schema: { type: "object", properties: {} },
    }));
  }

  test("延迟工具 token 远低于阈值 → 不启用", () => {
    const input: AutoThresholdInput = {
      model: "claude-sonnet-4-5",
      deferredDefinitions: mkDefs(1, 10), // 极少 token
    };
    // 200k 窗口 × 10% = 20k token 阈值，1 个小工具远不够
    expect(checkAutoThreshold(input, 10)).toBe(false);
  });

  test("延迟工具 token 超阈值 → 启用", () => {
    const input: AutoThresholdInput = {
      model: "claude-sonnet-4-5",
      deferredDefinitions: mkDefs(500, 2000), // 海量 token
    };
    expect(checkAutoThreshold(input, 10)).toBe(true);
  });

  test("阈值 0% → 任何延迟工具都启用", () => {
    const input: AutoThresholdInput = {
      model: "claude-sonnet-4-5",
      deferredDefinitions: mkDefs(1, 1),
    };
    expect(checkAutoThreshold(input, 0)).toBe(true);
  });

  test("availableModels 权威 contextWindow 影响判定", () => {
    const defs = mkDefs(10, 500); // 中等 token 量
    // 小窗口模型：阈值低，容易触发
    const smallWindow: AutoThresholdInput = {
      model: "custom-small",
      availableModels: [{ name: "custom-small", contextWindow: 4000 }],
      deferredDefinitions: defs,
    };
    // 大窗口模型：阈值高，不触发
    const bigWindow: AutoThresholdInput = {
      model: "custom-big",
      availableModels: [{ name: "custom-big", contextWindow: 10_000_000 }],
      deferredDefinitions: defs,
    };
    expect(checkAutoThreshold(smallWindow, 10)).toBe(true);
    expect(checkAutoThreshold(bigWindow, 10)).toBe(false);
  });
});

describe("resolveToolSearchEnabled", () => {
  const tinyInput: AutoThresholdInput = {
    model: "claude-sonnet-4-5",
    deferredDefinitions: [
      { name: "t", description: "x", input_schema: {} },
    ],
  };

  test("true → 恒开", () => {
    expect(resolveToolSearchEnabled(true, tinyInput)).toBe(true);
  });
  test("false → 恒关", () => {
    expect(resolveToolSearchEnabled(false, tinyInput)).toBe(false);
  });
  test("undefined → 恒关", () => {
    expect(resolveToolSearchEnabled(undefined, tinyInput)).toBe(false);
  });
  test('"auto" + 极少工具 → 不启用', () => {
    expect(resolveToolSearchEnabled("auto", tinyInput)).toBe(false);
  });
  test("number 0 → 恒开（绕过阈值）", () => {
    expect(resolveToolSearchEnabled(0, tinyInput)).toBe(true);
  });
});

describe("parseToolSearchEnv", () => {
  test("undefined / 空串 → undefined", () => {
    expect(parseToolSearchEnv(undefined)).toBeUndefined();
    expect(parseToolSearchEnv("")).toBeUndefined();
  });
  test('"true" → true', () => {
    expect(parseToolSearchEnv("true")).toBe(true);
  });
  test('"false" → false', () => {
    expect(parseToolSearchEnv("false")).toBe(false);
  });
  test('"auto" → "auto"', () => {
    expect(parseToolSearchEnv("auto")).toBe("auto");
  });
  test('"auto:25" → 25', () => {
    expect(parseToolSearchEnv("auto:25")).toBe(25);
  });
  test('"auto:abc" → "auto"（非法 N 回退）', () => {
    expect(parseToolSearchEnv("auto:abc")).toBe("auto");
  });
  test('"30" → 30', () => {
    expect(parseToolSearchEnv("30")).toBe(30);
  });
  test("无法解析 → undefined", () => {
    expect(parseToolSearchEnv("garbage")).toBeUndefined();
  });
});
