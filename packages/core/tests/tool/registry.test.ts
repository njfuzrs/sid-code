/**
 * 工具注册表测试
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
// Registry 消费的是 LegacyTool（`name()` 方法形态 + `{ output }` 结果），
// 不是新版泛型 Tool（`readonly name` 字段 + `{ data }` 结果）。mock 必须按 registry
// 实际接受的接口写，否则 register() 传参处会类型不兼容。
import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
} from "@sid-code/core/tool/types.ts";

/** 测试用的 mock 工具 */
class MockTool implements Tool {
  constructor(private _name: string) {}
  name() {
    return this._name;
  }
  description() {
    return `Mock tool: ${this._name}`;
  }
  inputSchema() {
    return { type: "object", properties: {} };
  }
  async execute(): Promise<ToolResult> {
    return { output: "ok" };
  }
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

  test("内置工具保持注册顺序，MCP 工具按名称排序（prompt cache 稳定性）", () => {
    const reg = new Registry();
    // 内置工具：人工编排顺序，不排序
    reg.register(new MockTool("read"));
    reg.register(new MockTool("bash"));
    // MCP 工具：以非字典序注册，验证组装时被排序
    reg.register(new MockTool("mcp__zeta"));
    reg.register(new MockTool("mcp__alpha"));
    reg.register(new MockTool("mcp__mid"));

    const pool = reg.assembleToolPool();
    const names = pool.map((t) => t.name());

    // 内置在前，保持注册顺序
    expect(names.slice(0, 2)).toEqual(["read", "bash"]);
    // MCP 在后，按名称升序
    expect(names.slice(2)).toEqual(["mcp__alpha", "mcp__mid", "mcp__zeta"]);
  });

  test("MCP 排序是确定性的（多次组装结果一致）", () => {
    const reg = new Registry();
    reg.register(new MockTool("mcp__c"));
    reg.register(new MockTool("mcp__a"));
    reg.register(new MockTool("mcp__b"));

    const first = reg.assembleToolPool().map((t) => t.name());
    const second = reg.assembleToolPool().map((t) => t.name());
    expect(first).toEqual(second);
    expect(first).toEqual(["mcp__a", "mcp__b", "mcp__c"]);
  });
});
