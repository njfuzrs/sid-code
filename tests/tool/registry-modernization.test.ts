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
import { buildTool } from "../../src/tool/types.ts";
import { toLegacyTool } from "../../src/tool/bridge.ts";

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

// ===== G19：新泛型 Tool → LegacyTool 桥接适配器 =====

describe("Registry — G19 bridge (toLegacyTool)", () => {
  test("buildTool → toLegacyTool → register → definitions 完整闭环", () => {
    const newTool = buildTool({
      name: "echo",
      description: () => "回显输入",
      inputSchema: () => ({ type: "object", properties: { text: { type: "string" } } }),
      call: async (input: { text: string }) => ({ data: input.text }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    const legacy = toLegacyTool(newTool);

    // 接口适配正确
    expect(legacy.name()).toBe("echo");
    expect(legacy.description()).toBe("回显输入");
    expect(legacy.readOnly?.()).toBe(true);
    expect(legacy.isConcurrencySafe?.({})).toBe(true);
    expect(legacy.inputSchema()).toHaveProperty("type", "object");

    // 可注册到 Registry
    const r = new Registry();
    r.register(legacy);
    const def = r.definitions().find((d) => d.name === "echo");
    expect(def).toBeDefined();
    expect(def!.description).toBe("回显输入");
  });

  test("execute 正确适配 call() → LegacyToolResult", async () => {
    const newTool = buildTool({
      name: "upper",
      description: () => "大写",
      inputSchema: () => ({ type: "object", properties: {} }),
      call: async (input: { text: string }) => ({ data: input.text.toUpperCase() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    const legacy = toLegacyTool(newTool);
    const result = await legacy.execute({ text: "hello" });
    expect(result.output).toBe("HELLO");
    expect(result.isError).toBeFalsy();
  });

  test("execute 透传 isError", async () => {
    const newTool = buildTool({
      name: "fail",
      description: () => "总是失败",
      inputSchema: () => ({ type: "object", properties: {} }),
      call: async () => ({ data: "boom", isError: true }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    const legacy = toLegacyTool(newTool);
    const result = await legacy.execute({});
    expect(result.output).toBe("boom");
    expect(result.isError).toBe(true);
  });

  test("ToolCapabilityFields 透传（zodSchema/searchHint/interruptBehavior）", () => {
    const schema = z.object({ path: z.string() });
    const newTool = buildTool({
      name: "picker",
      description: () => "选文件",
      inputSchema: () => ({ type: "object", properties: {} }),
      call: async () => ({ data: "" }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      zodSchema: schema,
      searchHint: "file picker",
      interruptBehavior: () => "block" as const,
    });

    const legacy = toLegacyTool(newTool);
    expect(legacy.zodSchema).toBe(schema);
    expect(legacy.searchHint).toBe("file picker");
    expect(legacy.interruptBehavior?.()).toBe("block");
  });
});

describe("Registry — 工具名冲突处理 (GAP-14)", () => {
  test("重复注册同名工具：先到先得，保留首个，不覆盖", () => {
    const r = new Registry();
    const first = mkTool("read", { searchHint: "first" });
    const second = mkTool("read", { searchHint: "second" });
    r.register(first);
    r.register(second);
    // 保留首个
    expect(r.get("read")).toBe(first);
    expect(r.get("read")?.searchHint).toBe("first");
    expect(r.size()).toBe(1);
  });

  test("重复注册同名 MCP 工具：同样先到先得", () => {
    const r = new Registry();
    const first = mkTool("mcp__s__t", { searchHint: "first" });
    const second = mkTool("mcp__s__t", { searchHint: "second" });
    r.register(first);
    r.register(second);
    expect(r.get("mcp__s__t")).toBe(first);
  });
});

describe("Registry — 工具名别名 fallback (GAP-13)", () => {
  test("get() 精确未命中返回 undefined（无别名登记时）", () => {
    const r = new Registry();
    r.register(mkTool("read"));
    // 未登记别名 → 旧名查不到
    expect(r.get("read_file")).toBeUndefined();
    // 精确名照常命中
    expect(r.get("read")).toBeDefined();
  });
});


describe("Registry — 延迟豁免名单 keepLoaded (P0-2)", () => {
  test("精确名豁免：命中工具 isDeferred=false、进 activeDefinitions、不进 deferredToolNames", () => {
    const r = new Registry();
    r.setKeepLoaded(["mcp__tavily__tavily_search"]);
    r.register(mkTool("mcp__tavily__tavily_search"));
    r.register(mkTool("mcp__tavily__tavily_extract"));

    // 豁免工具：强制首轮可见
    expect(r.isDeferred("mcp__tavily__tavily_search")).toBe(false);
    expect(r.activeDefinitions().map((d) => d.name)).toContain("mcp__tavily__tavily_search");
    expect(r.deferredToolNames()).not.toContain("mcp__tavily__tavily_search");

    // 未豁免的同 server 工具：照常延迟
    expect(r.isDeferred("mcp__tavily__tavily_extract")).toBe(true);
    expect(r.deferredToolNames()).toContain("mcp__tavily__tavily_extract");
  });

  test("server 通配 mcp__github__*：命中该 server 全部、不误伤其它 server", () => {
    const r = new Registry();
    r.setKeepLoaded(["mcp__github__*"]);
    r.register(mkTool("mcp__github__create_issue"));
    r.register(mkTool("mcp__github__merge_pr"));
    r.register(mkTool("mcp__slack__send"));

    expect(r.isDeferred("mcp__github__create_issue")).toBe(false);
    expect(r.isDeferred("mcp__github__merge_pr")).toBe(false);
    // 其它 server 不受影响，照常延迟
    expect(r.isDeferred("mcp__slack__send")).toBe(true);

    const deferred = r.deferredToolNames();
    expect(deferred).not.toContain("mcp__github__create_issue");
    expect(deferred).not.toContain("mcp__github__merge_pr");
    expect(deferred).toContain("mcp__slack__send");
  });

  test("空名单 / 未设置：MCP 工具照常全部延迟（向后兼容）", () => {
    const r = new Registry();
    r.register(mkTool("mcp__server__tool"));
    // 未 setKeepLoaded
    expect(r.isDeferred("mcp__server__tool")).toBe(true);
    // 显式空数组
    r.setKeepLoaded([]);
    expect(r.isDeferred("mcp__server__tool")).toBe(true);
    // undefined 归一化为空
    r.setKeepLoaded(undefined);
    expect(r.isDeferred("mcp__server__tool")).toBe(true);
  });

  test("豁免优先级低于运行时激活、但高于 mcp__ 前缀默认延迟", () => {
    const r = new Registry();
    r.setKeepLoaded(["mcp__x__a"]);
    r.register(mkTool("mcp__x__a"));
    // 豁免 → 本就可见，activateTool 返回 false（无需激活）
    expect(r.activateTool("mcp__x__a")).toBe(false);
    expect(r.isDeferred("mcp__x__a")).toBe(false);
  });
});
