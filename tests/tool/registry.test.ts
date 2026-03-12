/**
 * 工具注册表测试
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "../../src/tool/registry.ts";
import type { Tool, ToolResult } from "../../src/tool/types.ts";

/** 测试用的 mock 工具 */
class MockTool implements Tool {
  constructor(private _name: string) {}
  name() { return this._name; }
  description() { return `Mock tool: ${this._name}`; }
  inputSchema() { return { type: "object", properties: {} }; }
  async execute(): Promise<ToolResult> { return { output: "ok" }; }
}

describe("ToolRegistry", () => {
  test("注册和查找工具", () => {
    const reg = new Registry();
    const tool = new MockTool("read");
    reg.register(tool);

    expect(reg.get("read")).toBe(tool);
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  test("列举所有工具", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));
    reg.register(new MockTool("write"));
    reg.register(new MockTool("bash"));

    expect(reg.all().length).toBe(3);
    expect(reg.size()).toBe(3);
  });

  test("生成工具定义", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));

    const defs = reg.definitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe("read");
    expect(defs[0].description).toBe("Mock tool: read");
  });
});
