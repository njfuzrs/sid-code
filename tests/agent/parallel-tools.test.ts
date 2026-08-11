/**
 * 并行工具执行测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
// 同 tests/tool/registry.test.ts：Registry 接受的是 LegacyTool 形态。
import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "@sid-code/core/tool/types.ts";

/** Mock 只读工具 */
class MockReadOnlyTool implements Tool {
  private _name: string;
  public callCount = 0;
  public callOrder: number[] = [];
  private static globalOrder = 0;

  constructor(name: string) {
    this._name = name;
  }

  name() { return this._name; }
  description() { return `Mock read-only: ${this._name}`; }
  inputSchema() { return { type: "object", properties: {} }; }
  readOnly() { return true; }

  async execute(input: unknown): Promise<ToolResult> {
    this.callCount++;
    this.callOrder.push(MockReadOnlyTool.globalOrder++);
    // 模拟一点延迟
    await new Promise(r => setTimeout(r, 10));
    return { output: `${this._name} result` };
  }

  static resetOrder() { MockReadOnlyTool.globalOrder = 0; }
}

/** Mock 写入工具 */
class MockWriteTool implements Tool {
  private _name: string;
  public callCount = 0;

  constructor(name: string) {
    this._name = name;
  }

  name() { return this._name; }
  description() { return `Mock write: ${this._name}`; }
  inputSchema() { return { type: "object", properties: {} }; }
  readOnly() { return false; }

  async execute(input: unknown): Promise<ToolResult> {
    this.callCount++;
    await new Promise(r => setTimeout(r, 10));
    return { output: `${this._name} result` };
  }
}

/** Mock 失败工具 */
class MockFailTool implements Tool {
  name() { return "fail_tool"; }
  description() { return "Always fails"; }
  inputSchema() { return { type: "object", properties: {} }; }
  readOnly() { return true; }

  async execute(_input: unknown): Promise<ToolResult> {
    throw new Error("工具执行失败");
  }
}

describe("并行工具执行 - 工具分类", () => {
  test("只读工具标记正确", () => {
    const readTool = new MockReadOnlyTool("read");
    const writeTool = new MockWriteTool("write");

    expect(readTool.readOnly()).toBe(true);
    expect(writeTool.readOnly()).toBe(false);
  });

  test("Registry.filter 正确过滤工具", () => {
    const registry = new Registry();
    const read = new MockReadOnlyTool("read");
    const grep = new MockReadOnlyTool("grep");
    const write = new MockWriteTool("write");

    registry.register(read);
    registry.register(grep);
    registry.register(write);

    const filtered = registry.filter(["read", "grep"]);
    expect(filtered.size()).toBe(2);
    expect(filtered.get("read")).toBeDefined();
    expect(filtered.get("grep")).toBeDefined();
    expect(filtered.get("write")).toBeUndefined();
  });
});

describe("并行工具执行 - 执行顺序", () => {
  beforeEach(() => {
    MockReadOnlyTool.resetOrder();
  });

  test("多个只读工具可以并行执行", async () => {
    const tools = [
      new MockReadOnlyTool("read1"),
      new MockReadOnlyTool("read2"),
      new MockReadOnlyTool("read3"),
    ];

    // 并行执行
    const results = await Promise.all(
      tools.map(t => t.execute({}))
    );

    expect(results).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.callCount).toBe(1);
    }
  });

  test("写入工具串行执行", async () => {
    const tools = [
      new MockWriteTool("write1"),
      new MockWriteTool("write2"),
    ];

    // 串行执行
    for (const tool of tools) {
      await tool.execute({});
    }

    expect(tools[0].callCount).toBe(1);
    expect(tools[1].callCount).toBe(1);
  });

  test("工具执行失败不影响其他工具", async () => {
    const readTool = new MockReadOnlyTool("read");
    const failTool = new MockFailTool();

    const results = await Promise.allSettled([
      readTool.execute({}),
      failTool.execute({}),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(readTool.callCount).toBe(1);
  });
});
