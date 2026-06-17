/**
 * 工具注册表现代化能力回归测试
 *
 * 守护"工具接口现代化"P1-2 的两项 registry 能力：
 * 1. 有 zodSchema 的工具用 z.toJSONSchema 生成 LLM 定义（与运行时校验器同源）
 * 2. ToolSearch 字段（shouldDefer / alwaysLoad / searchHint）真正接通 activeDefinitions 过滤
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import { Registry } from "../../src/tool/registry.ts";
import type { LegacyTool } from "../../src/tool/types.ts";

function mkTool(name: string, extra: Partial<LegacyTool> = {}): LegacyTool {
  return {
    name: () => name,
    description: () => `desc of ${name}`,
    inputSchema: () => ({ type: "object", properties: {}, _handwritten: true }),
    execute: async () => ({ output: "" }),
    ...extra,
  };
}

describe("Registry — zodSchema 生成 LLM 定义", () => {
  test("有 zodSchema：input_schema 来自 z.toJSONSchema（含 describe）", () => {
    const r = new Registry();
    r.register(mkTool("grep", { zodSchema: z.object({ pattern: z.string().describe("正则表达式") }) }));
    const def = r.definitions().find((d) => d.name === "grep")!;
    const schema = def.input_schema as any;
    expect(schema.properties.pattern.type).toBe("string");
    expect(schema.properties.pattern.description).toBe("正则表达式");
    expect(schema.required).toEqual(["pattern"]);
    // 不应是手写 schema 的 _handwritten 标记
    expect(schema._handwritten).toBeUndefined();
  });

  test("无 zodSchema：回退手写 inputSchema()", () => {
    const r = new Registry();
    r.register(mkTool("legacy"));
    const def = r.definitions().find((d) => d.name === "legacy")!;
    expect((def.input_schema as any)._handwritten).toBe(true);
  });
});

describe("Registry — ToolSearch 字段过滤", () => {
  test("shouldDefer=true 的工具不进 activeDefinitions", () => {
    const r = new Registry();
    r.register(mkTool("read"));
    r.register(mkTool("notebook", { shouldDefer: true }));
    const active = r.activeDefinitions().map((d) => d.name);
    expect(active).toContain("read");
    expect(active).not.toContain("notebook");
    // 但 definitions()（全量）仍含延迟工具
    expect(r.definitions().map((d) => d.name)).toContain("notebook");
  });

  test("alwaysLoad=true 强制首轮可见，即使被 markDeferred", () => {
    const r = new Registry();
    r.register(mkTool("bash", { alwaysLoad: true }));
    r.markDeferred("bash");
    expect(r.activeDefinitions().map((d) => d.name)).toContain("bash");
    expect(r.isDeferred("bash")).toBe(false);
  });

  test("MCP 工具默认延迟（无需 markDeferred）", () => {
    const r = new Registry();
    r.register(mkTool("mcp__server__tool"));
    // MCP 工具自动延迟（对标 claude-code isDeferredTool 的 isMcp 规则）
    expect(r.isDeferred("mcp__server__tool")).toBe(true);
    expect(r.activeDefinitions().map((d) => d.name)).not.toContain("mcp__server__tool");
  });

  test("markDeferred 运行时名单：非 MCP 工具的动态延迟通道", () => {
    const r = new Registry();
    r.register(mkTool("custom_tool"));
    expect(r.isDeferred("custom_tool")).toBe(false);
    r.markDeferred("custom_tool");
    expect(r.isDeferred("custom_tool")).toBe(true);
    expect(r.activeDefinitions().map((d) => d.name)).not.toContain("custom_tool");
  });

  test("searchDeferredTools 用 searchHint 参与关键词匹配", () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true, searchHint: "jupyter cell execution" }));
    r.register(mkTool("read"));
    const hit = r.searchDeferredTools("jupyter");
    expect(hit.map((t) => t.name())).toEqual(["notebook"]);
    // 非延迟工具不参与延迟搜索
    expect(r.searchDeferredTools("read")).toHaveLength(0);
  });

  test("deferredSize 字段 + 名单双来源去重计数", () => {
    const r = new Registry();
    r.register(mkTool("a", { shouldDefer: true }));
    r.register(mkTool("b"));
    r.markDeferred("b");
    r.markDeferred("a"); // a 同时被字段和名单标记，去重后仍计 1 次
    expect(r.deferredSize()).toBe(2);
  });
});
